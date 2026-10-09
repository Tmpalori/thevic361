"""Properties of the GitHub Actions workflows that keep scheduled jobs from
failing silently or being dropped. The newsletter's send step is run for
real against a fake curl."""
import os
import stat
import subprocess
import sys

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
    # The site scheduler dispatches the daily post with scheduled=true (and
    # post=false); it must queue with the posts, not the push rebuilds.
    assert "inputs.scheduled" in group


def test_event_check_wait_step_can_alert_slack():
    # A collect whose candidates never go live alerts from the wait step.
    job = load("event-check.yml")["jobs"]["check"]
    env = step(job, "Wait for the new events to go live")["env"]
    assert "SLACK_ALERTS_WEBHOOK_URL" in env["SLACK_WEBHOOK_URL"]


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


def town_env(town=None):
    """What the workflows' "Town paths" step puts in GITHUB_ENV (TOWN unset = Victoria)."""
    env = {k: v for k, v in os.environ.items() if k not in ("TOWN", "TOWNS_DIR")}
    out = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "town.py"), "paths"],
                         env=env, capture_output=True, text=True, check=True).stdout
    return dict(line.split("=", 1) for line in out.splitlines())


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True,
                   capture_output=True, text=True)


def run_kit_commit(tmp_path, posting):
    """Run social-kit's Commit step after another run pushed a different kit."""
    origin, other, mine = tmp_path / "origin.git", tmp_path / "other", tmp_path / "mine"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    _git(tmp_path, "clone", "-q", str(origin), str(other))
    kit = other / "docs" / "social" / "latest"
    kit.mkdir(parents=True)
    (kit / "kit.json").write_text('{"v": "base"}\n')
    _git(other, "add", ".")
    _git(other, "commit", "-qm", "base")
    _git(other, "push", "-q", "origin", "HEAD:main")
    _git(tmp_path, "clone", "-q", str(origin), str(mine))
    (kit / "kit.json").write_text('{"v": "theirs"}\n')   # the concurrent run lands first
    _git(other, "commit", "-qam", "other kit")
    _git(other, "push", "-q", "origin", "HEAD:main")
    (mine / "docs" / "social" / "latest" / "kit.json").write_text('{"v": "mine"}\n')
    script = step(load("social-kit.yml")["jobs"]["build"], "Commit")["run"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _exe(bin_dir / "sleep", "#!/bin/sh\nexit 0\n")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", POSTING="true" if posting else "false",
               GIT_CONFIG_GLOBAL=os.devnull, **town_env())
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], cwd=mine, env=env,
                       capture_output=True, text=True, timeout=60)
    _git(other, "pull", "-q", "--rebase", "origin", "main")
    return r.returncode, (kit / "kit.json").read_text()


def test_social_kit_posting_run_wins_a_kit_conflict(tmp_path):
    # A push rebuild committed docs/social/latest first: the posting run's
    # retries all conflicted and it exited 1 before posting.
    rc, on_main = run_kit_commit(tmp_path, posting=True)
    assert rc == 0 and '"mine"' in on_main


def test_social_kit_rebuild_yields_to_a_newer_kit(tmp_path):
    rc, on_main = run_kit_commit(tmp_path, posting=False)
    assert rc == 0 and '"theirs"' in on_main


def test_social_kit_installs_ffmpeg_only_for_the_reel_and_bounded():
    job = load("social-kit.yml")["jobs"]["build"]
    ff = step(job, "Install ffmpeg")
    assert "weekend" in ff["if"] and ff["timeout-minutes"] <= 5 and ff["continue-on-error"] is True


def run_gate(tmp_path, wf, schedule, now, ran=False, event="schedule"):
    """Run a fallback cron's gate step at `now` with the site answering `ran`."""
    g = next(s for s in load(wf)["jobs"]["gate"]["steps"] if s.get("id") == "g")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    _exe(bin_dir / "curl", '#!/bin/sh\necho \'{"ok":true,"ran":%s}\'\n' % ("true" if ran else "false"))
    out = tmp_path / "out"
    out.write_text("")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", GITHUB_OUTPUT=str(out),
               GATE_NOW=now, EVENT=event, SCHEDULE=schedule, SITE="https://example.test",
               **{k: v for k, v in g["env"].items() if k.endswith("CRON")})
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", g["run"]], env=env,
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    lines = out.read_text().strip().splitlines()
    run_gate.outputs = dict(x.split("=", 1) for x in lines)
    return next(x for x in lines if x.startswith("run="))


SUMMER, WINTER = "2026-07-06T18:00:00Z", "2026-12-07T18:00:00Z"


@pytest.mark.parametrize("wf,cdt,cst", [("event-check.yml", "43 11 * * 1", "43 12 * * 1"),
                                        ("newsletter.yml", "43 12 * * 1", "43 13 * * 1"),
                                        ("meta-ads.yml", "37 13 * * *", "37 14 * * *"),
                                        ("social-kit.yml", "47 13 * * *", "47 14 * * *")])
def test_fallback_crons_fire_at_the_slot_in_both_cdt_and_cst(tmp_path, wf, cdt, cst):
    # Pinned to CDT alone, the winter run came an hour before the slot,
    # when the scheduler's "ran" still answered for the previous slot.
    crons = [c["cron"] for c in load(wf)[True]["schedule"]]
    assert cdt in crons and cst in crons
    assert run_gate(tmp_path, wf, cdt, SUMMER) == "run=true"
    assert run_gate(tmp_path, wf, cst, SUMMER) == "run=false"
    assert run_gate(tmp_path, wf, cst, WINTER) == "run=true"
    assert run_gate(tmp_path, wf, cdt, WINTER) == "run=false"
    # Still skipped when the site's scheduler already ran the slot; by-hand
    # runs are never gated.
    assert run_gate(tmp_path, wf, cst, WINTER, ran=True) == "run=false"
    assert run_gate(tmp_path, wf, "", WINTER, ran=True, event="workflow_dispatch") == "run=true"


def test_newsletter_thursday_cron_sends_the_weekend_issue(tmp_path):
    crons = [c["cron"] for c in load("newsletter.yml")[True]["schedule"]]
    assert "13 12 * * 4" in crons and "13 13 * * 4" in crons
    thu_summer, thu_winter = "2026-07-09T18:00:00Z", "2026-12-10T18:00:00Z"
    assert run_gate(tmp_path, "newsletter.yml", "13 12 * * 4", thu_summer) == "run=true"
    assert run_gate.outputs["edition"] == "weekend"
    assert run_gate(tmp_path, "newsletter.yml", "13 12 * * 4", thu_winter) == "run=false"
    assert run_gate(tmp_path, "newsletter.yml", "13 13 * * 4", thu_winter, ran=True) == "run=false"
    assert run_gate(tmp_path, "newsletter.yml", "43 12 * * 1", SUMMER) == "run=true"
    assert run_gate.outputs["edition"] == "weekly"
    send = step(load("newsletter.yml")["jobs"]["send"], "Send this week's newsletter")
    assert "X-Newsletter-Edition: $EDITION" in send["run"]


@pytest.mark.parametrize("name,job,post,script", [("meta-ads.yml", "ads", "Meta ads", "meta_ads.py"),
                                                  ("social-kit.yml", "build", "Post to Facebook + Instagram",
                                                   "social_post.py")])
def test_meta_workflows_pass_the_graph_version_and_slack_names_a_refused_one(name, job, post, script):
    # A retired Graph version must be fixable from the repo variable, and
    # the alert must say so instead of blaming the token.
    steps = load(name)["jobs"][job]
    call = step(steps, post)
    assert call["env"]["GRAPH_API_VERSION"] == "${{ vars.GRAPH_API_VERSION || 'v23.0' }}"
    alert = step(steps, "Tell Slack it failed")
    assert alert["env"]["ALERT"] == "${{ steps.%s.outputs.alert }}" % call["id"]
    out = subprocess.run(["bash", "-c", 'printf "%s" "' + alert["run"].split('"')[1] + '"'],
                         env={"ALERT": "named v23.0"}, capture_output=True, text=True).stdout
    assert out == "named v23.0"
    with open(os.path.join(os.path.dirname(WF), "..", "scripts", script)) as f:
        assert "set_output(\"alert\"" in f.read()


# ─── weekly-collect push retry ──────────────────────────────────────────────

def _collect_push_loop():
    script = step(load("weekly-collect.yml")["jobs"]["collect"], "Commit and push")["run"]
    return script[script.index("for i in"):script.index("done")]


def test_weekly_collect_push_retry_aborts_a_failed_rebase():
    # Without the abort, one conflict left a rebase in progress and every
    # retry failed at once, losing the paid collect.
    loop = _collect_push_loop()
    assert "git rebase --abort" in loop
    assert loop.index("git pull --rebase") < loop.index("git rebase --abort") < loop.index("sleep")


def test_weekly_collect_keeps_its_files_when_main_changed_them(tmp_path):
    # A merge touched candidates.json during the collect.
    origin, other, mine = tmp_path / "origin.git", tmp_path / "other", tmp_path / "mine"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    _git(tmp_path, "clone", "-q", str(origin), str(other))
    for f in ("candidates.json", "enrichment_cache.json"):
        (other / f).write_text('{"v": "base"}\n')
    _git(other, "add", ".")
    _git(other, "commit", "-qm", "base")
    _git(other, "push", "-q", "origin", "HEAD:main")
    _git(tmp_path, "clone", "-q", str(origin), str(mine))
    (other / "candidates.json").write_text('{"v": "merged pr"}\n')
    _git(other, "commit", "-qam", "pr")
    _git(other, "push", "-q", "origin", "HEAD:main")
    (mine / "candidates.json").write_text('{"v": "this collect"}\n')
    script = step(load("weekly-collect.yml")["jobs"]["collect"], "Commit and push")["run"]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _exe(bin_dir / "sleep", "#!/bin/sh\nexit 0\n")
    env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", GIT_CONFIG_GLOBAL=os.devnull, **town_env())
    r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], cwd=mine, env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    _git(other, "pull", "-q", "--rebase", "origin", "main")
    assert '"this collect"' in (other / "candidates.json").read_text()


@pytest.mark.parametrize("name", sorted(os.listdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".github", "workflows"))))
def test_town_paths_are_set_before_use(name):
    # A step that reads $TOWN_CANDIDATES etc. after no "Town paths" step
    # would see an empty path (git add "" fails; --candidates "./" worse).
    for job_name, job in load(name)["jobs"].items():
        seen = False
        for st in job.get("steps", []):
            if st.get("name") == "Town paths":
                assert st["run"].strip() == 'python3 town.py paths >> "$GITHUB_ENV"'
                seen = True
                continue
            uses = "TOWN_" in yaml.safe_dump(st)
            assert seen or not uses, f"{name} {job_name}: {st.get('name')} uses TOWN_* before the Town paths step"
