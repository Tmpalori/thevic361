"""Properties of the GitHub Actions workflows that keep scheduled jobs from
failing silently or being dropped. The newsletter's send step is run for
real against a fake curl."""
import os
import stat
import subprocess

import pytest
import yaml

WF = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".github", "workflows")


def load(name):
    with open(os.path.join(WF, name)) as f:
        return yaml.safe_load(f)


def step(job, name):
    return next(s for s in job["steps"] if s.get("name") == name)


def _exe(path, body):
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def run_newsletter_send(tmp_path, codes):
    """Run the send step with curl answering `codes` in turn."""
    script = step(load("newsletter.yml")["jobs"]["send"], "Send this week's newsletter")["run"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (tmp_path / "codes").write_text("\n".join(codes) + "\n")
    _exe(bin_dir / "curl", """#!/bin/sh
echo "$*" >> "$STATE/calls"
n=$(wc -l < "$STATE/calls")
code=$(sed -n "${n}p" "$STATE/codes")
while [ $# -gt 0 ]; do [ "$1" = -o ] && echo '{"ok":true}' > "$2"; shift; done
printf '%s' "$code"
[ "$code" = 000 ] && exit 28
exit 0
""")
    _exe(bin_dir / "sleep", '#!/bin/sh\necho "$1" >> "$STATE/sleeps"\n')
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", STATE=str(tmp_path),
               SECRET="s3cret", SITE="https://example.test")
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], cwd=tmp_path, env=env,
                       capture_output=True, text=True, timeout=30)
    calls = (tmp_path / "calls").read_text().splitlines()
    sleeps = (tmp_path / "sleeps").read_text().split() if (tmp_path / "sleeps").exists() else []
    return r.returncode, calls, sleeps


def test_newsletter_retries_server_errors_and_no_answer(tmp_path):
    rc, calls, sleeps = run_newsletter_send(tmp_path, ["502", "000", "200"])
    assert rc == 0 and len(calls) == 3 and len(sleeps) == 2
    assert all("--max-time" in c for c in calls)


def test_newsletter_gives_up_after_three_tries(tmp_path):
    rc, calls, _ = run_newsletter_send(tmp_path, ["500", "500", "500", "200"])
    assert rc == 1 and len(calls) == 3


def test_newsletter_does_not_retry_a_wrong_secret(tmp_path):
    rc, calls, sleeps = run_newsletter_send(tmp_path, ["401", "200"])
    assert rc == 1 and len(calls) == 1 and sleeps == []


def test_newsletter_job_timeout_fits_the_retries():
    job = load("newsletter.yml")["jobs"]["send"]
    assert job["timeout-minutes"] >= 25
    assert step(job, "Tell Slack it failed")["if"] == "failure()"


def test_social_kit_fits_its_worst_case_and_alerts_on_cancel():
    wf = load("social-kit.yml")
    job = wf["jobs"]["build"]
    post = step(job, "Post to Facebook + Instagram")
    # Deploy wait (10 min) + Reel processing (6 min) + Thursday's second post.
    assert post["timeout-minutes"] >= 18
    assert job["timeout-minutes"] >= post["timeout-minutes"] + 10
    assert "cancelled()" in step(job, "Tell Slack it failed")["if"]
    assert step(job, "Save posted ids")["if"].startswith("always()")


def test_social_kit_posting_runs_have_their_own_concurrency_group():
    # One pending run per group: a push rebuild must not replace a queued post.
    group = load("social-kit.yml")["concurrency"]["group"]
    assert "github.event_name == 'schedule'" in group and "inputs.post" in group


def test_uptime_stale_feed_check_is_not_in_the_five_minute_group():
    wf = load("uptime.yml")
    assert "concurrency" not in wf  # per job, below
    check, stale = wf["jobs"]["check"], wf["jobs"]["stale-feed"]
    assert check["concurrency"]["group"] != stale["concurrency"]["group"]
    assert stale["if"] == "github.event.schedule == '17 15 * * *'"
    assert "17 15 * * *" in [c["cron"] for c in wf[True]["schedule"]]
    assert "feed_age.py" in step(stale, "Stale feed")["run"]


def test_meta_ads_failure_alerts_slack():
    job = load("meta-ads.yml")["jobs"]["ads"]
    alert = step(job, "Tell Slack it failed")
    assert "failure()" in alert["if"] and "slack_notify.py" in alert["run"]


@pytest.mark.parametrize("name", sorted(f for f in os.listdir(WF) if f.endswith(".yml")))
def test_every_workflow_parses(name):
    assert load(name)["jobs"]
