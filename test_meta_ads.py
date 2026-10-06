"""Tests for scripts/meta_ads.py, the Meta ads reader/manager."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "scripts"))
import meta_ads as ma  # noqa: E402

TOKEN = "SECRET-TOKEN-123"


class Resp:
    def __init__(self, body, status=200):
        self.body, self.status_code = body, status

    def json(self):
        return self.body


class FakeMeta:
    """Answers the few Graph calls the script makes; records every call."""

    def __init__(self, accounts=None, scopes=("ads_read", "ads_management"), spend="12.34", ad_status="PENDING_REVIEW"):
        self.calls = []
        self.accounts = [{"id": "act_1", "name": "The Vic 361", "currency": "USD"}] if accounts is None else accounts
        self.scopes = scopes
        self.spend = spend
        self.ad_status = ad_status
        self.objects = {"999": {"name": "Visitors ad set", "effective_status": "ACTIVE", "daily_budget": "1000"}}

    def request(self, method, url, headers=None, timeout=None, params=None, data=None):
        path = url.split("/v23.0/")[1]
        self.calls.append((method, path, headers, params, data))
        if method == "GET" and path == "me/permissions":
            return Resp({"data": [{"permission": p, "status": "granted"} for p in self.scopes]})
        if path == "me/adaccounts":
            return Resp({"data": self.accounts})
        if path.endswith("/insights"):
            return Resp({"data": [{"spend": self.spend, "reach": "800", "frequency": "1.4", "inline_link_clicks": "40",
                                   "inline_link_click_ctr": "1.9", "actions": [{"action_type": "landing_page_view", "value": "31"}]}]})
        if path.endswith("/campaigns"):
            return Resp({"data": [{"id": "1", "name": "Vic361 – Visitors", "effective_status": "ACTIVE", "objective": "OUTCOME_TRAFFIC"}]})
        if path.endswith("/adsets"):
            return Resp({"data": [{"id": "999", "name": "Victoria 25mi", "campaign_id": "1", "effective_status": "ACTIVE",
                                   "daily_budget": "1000", "optimization_goal": "LANDING_PAGE_VIEWS"}]})
        if path.endswith("/ads"):
            return Resp({"data": [{"id": "5", "name": "Video", "adset_id": "999", "effective_status": self.ad_status}]})
        if path in self.objects:
            if method == "POST":
                self.objects[path].update(data)
                if "status" in data:
                    self.objects[path]["effective_status"] = data["status"]
                return Resp({"success": True})
            return Resp(dict(self.objects[path]))
        return Resp({"error": {"message": "Unsupported request"}}, 400)


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("META_ADS_TOKEN", TOKEN)
    monkeypatch.delenv("META_AD_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    monkeypatch.setattr(ma.slack_notify, "main", lambda args: sent.append(args) or 0)
    sent.clear()


sent = []


def test_status_shows_structure_and_numbers_and_never_puts_the_token_in_a_url(capsys):
    meta = FakeMeta()
    assert ma.main(["status"], session=meta) == 0
    out = capsys.readouterr().out
    assert "ads_read and ads_management ✓" in out
    assert "Vic361 – Visitors" in out and "$10.00/day" in out and "pending_review" in out
    assert "31 landing page views ($0.40 each)" in out
    for method, path, headers, params, data in meta.calls:
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        assert TOKEN not in path and TOKEN not in str(params) and TOKEN not in str(data)
    assert TOKEN not in out


def test_missing_permissions_and_no_ad_account_are_explained(capsys):
    assert ma.main(["status"], session=FakeMeta(accounts=[])) == 1
    assert "Assign assets → Ad accounts" in capsys.readouterr().out
    assert ma.main(["status"], session=FakeMeta(scopes=("pages_manage_posts",))) == 0
    assert "missing ads_read, ads_management" in capsys.readouterr().out


def test_scheduled_run_with_a_setup_problem_alerts_but_does_not_fail(monkeypatch, capsys):
    monkeypatch.setenv("SLACK_ALERTS_WEBHOOK_URL", "https://hooks.slack.com/alerts")
    assert ma.main(["report", "--scheduled"], session=FakeMeta(accounts=[])) == 0
    assert "::warning::" in capsys.readouterr().out
    assert len(sent) == 1 and "couldn't run" in sent[0][0] and "no ad accounts" in sent[0][0]


def test_scheduled_run_stays_quiet_while_only_the_page_token_is_set(monkeypatch):
    # No META_ADS_TOKEN yet: the Page token seeing no ad account just means
    # ads aren't set up, not that something broke.
    monkeypatch.setenv("META_ADS_TOKEN_SOURCE", "page")
    assert ma.main(["report", "--scheduled"], session=FakeMeta(accounts=[])) == 0
    assert sent == []


def test_report_goes_to_slack_only_when_something_spent():
    assert ma.main(["report"], session=FakeMeta()) == 0
    assert len(sent) == 1 and "📈 Meta ads: yesterday $12.34 spent" in sent[0][0]
    sent.clear()
    assert ma.main(["report"], session=FakeMeta(spend="0")) == 0
    assert sent == []


def test_zero_spend_with_a_disapproved_ad_or_a_billing_problem_alerts():
    assert ma.main(["report"], session=FakeMeta(spend="0", ad_status="DISAPPROVED")) == 0
    assert len(sent) == 1 and "🚨 Meta ads need a look" in sent[0][0] and "*Video* is disapproved" in sent[0][0]
    sent.clear()
    unpaid = [{"id": "act_1", "name": "The Vic 361", "currency": "USD", "account_status": 3}]
    assert ma.main(["report"], session=FakeMeta(accounts=unpaid, spend="0")) == 0
    assert len(sent) == 1 and "unsettled" in sent[0][0]


def test_a_live_campaign_that_spent_nothing_alerts():
    assert ma.main(["report"], session=FakeMeta(spend="0", ad_status="ACTIVE")) == 0
    assert len(sent) == 1 and "spent $0 yesterday" in sent[0][0]
    sent.clear()
    # Spending normally: just the report.
    assert ma.main(["report"], session=FakeMeta(ad_status="ACTIVE")) == 0
    assert len(sent) == 1 and sent[0][0].startswith("📈")


def test_pause_resume_and_budget_with_a_safety_limit(capsys):
    meta = FakeMeta()
    assert ma.main(["pause", "999"], session=meta) == 0
    assert meta.objects["999"]["status"] == "PAUSED"
    assert ma.main(["resume", "999"], session=meta) == 0
    assert meta.objects["999"]["status"] == "ACTIVE"
    assert "paused → active" in capsys.readouterr().out
    assert ma.main(["budget", "999", "15"], session=meta) == 0
    assert meta.objects["999"]["daily_budget"] == "1500"
    assert "$10.00 → $15.00" in capsys.readouterr().out
    assert ma.main(["budget", "999", "500"], session=meta) == 1
    assert meta.objects["999"]["daily_budget"] == "1500"
    assert "safety limit" in capsys.readouterr().out
    assert ma.main(["budget", "999", "500", "--force"], session=meta) == 0
    assert meta.objects["999"]["daily_budget"] == "50000"


def test_several_ad_accounts_need_the_variable(monkeypatch, capsys):
    two = [{"id": "act_1", "name": "A"}, {"id": "act_2", "name": "B"}]
    assert ma.main(["status"], session=FakeMeta(accounts=two)) == 1
    assert "META_AD_ACCOUNT_ID" in capsys.readouterr().out
    monkeypatch.setenv("META_AD_ACCOUNT_ID", "2")
    assert ma.main(["status"], session=FakeMeta(accounts=two)) == 0


def test_network_errors_carry_no_token():
    class Boom:
        def request(self, *a, **k):
            raise ma.requests.ConnectionError(f"https://graph.facebook.com/x?access_token={TOKEN}")
    with pytest.raises(ma.AdsError) as e:
        ma.Api(TOKEN, Boom()).call("GET", "me")
    assert TOKEN not in str(e.value) and e.value.__cause__ is None
