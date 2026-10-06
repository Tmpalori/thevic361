#!/usr/bin/env python3
"""Read and manage The Vic 361's Meta ads (Marketing API).

Runs from .github/workflows/meta-ads.yml, so the token never leaves GitHub:

  status            what's running, its delivery/review state, and results
                    (today, yesterday, last 7 days); also checks the token
  report            yesterday + last 7 days to Slack (the daily run); quiet
                    when nothing has spent in the last 7 days. A disapproved
                    ad, a billing hold, a disabled account, a live campaign
                    that spent $0 yesterday, or (scheduled) not being able
                    to read the account at all goes to the alerts channel
  pause  <id>       pause a campaign, ad set or ad
  resume <id>       turn it back on
  budget <id> <$>   set an ad set's (or campaign's) daily budget, in dollars;
                    refuses more than MAX_DAILY_BUDGET unless --force

Needs (GitHub Actions):
  META_ADS_TOKEN      a system-user token with ads_read (+ ads_management to
                      change anything) and the ad account assigned to that
                      system user; falls back to META_PAGE_TOKEN
  META_AD_ACCOUNT_ID  repo variable, e.g. act_123 (optional when the token
                      sees exactly one ad account)

The token goes in the Authorization header, never a URL, and errors never
include it.
"""
import argparse
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
import slack_notify  # noqa: E402

GRAPH = f"https://graph.facebook.com/{os.environ.get('GRAPH_API_VERSION', 'v23.0')}"
MAX_DAILY_BUDGET = 50  # dollars; a typo like 1000 shouldn't go live
NEEDS = ("ads_read", "ads_management")


class AdsError(RuntimeError):
    pass


class Api:
    def __init__(self, token, session=None):
        self.token = token
        self.s = session or requests.Session()

    def call(self, method, path, **params):
        headers = {"Authorization": f"Bearer {self.token}"}
        where = {"params": params} if method == "GET" else {"data": params}
        try:
            r = self.s.request(method, f"{GRAPH}/{path}", headers=headers, timeout=60, **where)
        except requests.RequestException as e:
            raise AdsError(f"{method} {path} failed: {type(e).__name__}") from None
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400 or (isinstance(body, dict) and body.get("error")):
            err = body.get("error", {}) if isinstance(body, dict) else {}
            raise AdsError(f"{method} {path} failed: {err.get('message') or f'HTTP {r.status_code}'}")
        return body

    def all(self, path, **params):
        """Every page of a list edge (small accounts: a page or two)."""
        out, after = [], None
        for _ in range(20):
            body = self.call("GET", path, **params, **({"after": after} if after else {}))
            out += body.get("data") or []
            after = ((body.get("paging") or {}).get("cursors") or {}).get("after")
            if not after or not (body.get("paging") or {}).get("next"):
                break
        return out


def granted_scopes(api):
    """Permissions on the token, or None if Meta won't say (system users
    can't always read /me/permissions)."""
    try:
        return {p["permission"] for p in api.all("me/permissions") if p.get("status") == "granted"}
    except AdsError:
        return None


def find_account(api, wanted=""):
    accounts = api.all("me/adaccounts", fields="id,name,account_status,currency")
    if wanted:
        wanted = wanted if wanted.startswith("act_") else f"act_{wanted}"
        hit = [a for a in accounts if a["id"] == wanted]
        if hit:
            return hit[0], accounts
        # Not in the list (e.g. no access via this route): try it directly.
        try:
            return api.call("GET", wanted, fields="id,name,account_status,currency"), accounts
        except AdsError:
            raise AdsError(f"The token can't see ad account {wanted}. In Business settings → System users, "
                           "assign that ad account to the system user (Manage ad account).") from None
    if len(accounts) == 1:
        return accounts[0], accounts
    if not accounts:
        raise AdsError("The token sees no ad accounts. In Business settings → System users → your system user → "
                       "Assign assets → Ad accounts, give it the ad account (Manage ad account), and make sure "
                       "the token has ads_read and ads_management.")
    names = ", ".join(f"{a.get('name')} ({a['id']})" for a in accounts)
    raise AdsError(f"The token sees several ad accounts: {names}. Set the META_AD_ACCOUNT_ID repo variable.")


def money(cents_or_dollars, cents=True):
    if cents_or_dollars in (None, ""):
        return "—"
    v = float(cents_or_dollars) / (100 if cents else 1)
    return f"${v:,.2f}"


def action(row, kind):
    for a in row.get("actions") or []:
        if a.get("action_type") == kind:
            return int(float(a.get("value") or 0))
    return 0


INSIGHT_FIELDS = "spend,impressions,reach,frequency,inline_link_clicks,inline_link_click_ctr,actions"


def summarize(row):
    """One line of numbers from an insights row (or an empty one)."""
    spend = float(row.get("spend") or 0)
    lpv = action(row, "landing_page_view")
    clicks = int(float(row.get("inline_link_clicks") or 0))
    leads = action(row, "lead") or action(row, "offsite_conversion.fb_pixel_lead")
    parts = [f"${spend:,.2f} spent", f"{int(float(row.get('reach') or 0)):,} people reached",
             f"{clicks:,} link clicks ({float(row.get('inline_link_click_ctr') or 0):.2f}% CTR)",
             f"{lpv:,} landing page views" + (f" (${spend / lpv:,.2f} each)" if lpv else ""),
             f"frequency {float(row.get('frequency') or 0):.2f}"]
    if leads:
        parts.append(f"{leads} signups (${spend / leads:,.2f} each)")
    return spend, ", ".join(parts)


def insights(api, account_id, preset):
    rows = api.call("GET", f"{account_id}/insights", fields=INSIGHT_FIELDS, date_preset=preset, level="account").get("data") or []
    return rows[0] if rows else {}


def structure(api, account_id):
    fields = "id,name,effective_status"
    campaigns = api.all(f"{account_id}/campaigns", fields=fields + ",objective,daily_budget")
    adsets = api.all(f"{account_id}/adsets", fields=fields + ",campaign_id,daily_budget,optimization_goal")
    ads = api.all(f"{account_id}/ads", fields=fields + ",adset_id,ad_review_feedback")
    return campaigns, adsets, ads


LIVE = {"ACTIVE", "IN_PROCESS", "PENDING_REVIEW", "WITH_ISSUES", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO"}


def status_lines(campaigns, adsets, ads):
    lines = []
    for c in campaigns:
        if c.get("effective_status") not in LIVE | {"PAUSED", "CAMPAIGN_PAUSED"}:
            continue  # archived/deleted
        lines.append(f"• Campaign *{c['name']}* ({c['id']}): {c['effective_status'].lower()}, "
                     f"{c.get('objective', '').replace('OUTCOME_', '').lower()}"
                     + (f", {money(c.get('daily_budget'))}/day" if c.get("daily_budget") else ""))
        for s in [s for s in adsets if s.get("campaign_id") == c["id"]]:
            lines.append(f"   ◦ Ad set *{s['name']}* ({s['id']}): {s['effective_status'].lower()}"
                         + (f", {money(s.get('daily_budget'))}/day" if s.get("daily_budget") else "")
                         + (f", goal {s.get('optimization_goal', '').lower()}" if s.get("optimization_goal") else ""))
            for a in [a for a in ads if a.get("adset_id") == s["id"]]:
                review = a.get("ad_review_feedback") or {}
                why = "; ".join(f"{k}: {v}" for k, v in (review.get("global") or {}).items())
                lines.append(f"      ▪ Ad *{a['name']}* ({a['id']}): {a['effective_status'].lower()}" + (f" ({why})" if why else ""))
    return lines or ["• No campaigns yet."]


def cmd_status(api, account, out):
    scopes = granted_scopes(api)
    if scopes is not None:
        missing = [p for p in NEEDS if p not in scopes]
        out.append("Token permissions: " + ("ads_read and ads_management ✓" if not missing
                                            else f"missing {', '.join(missing)} (add them and generate a new token)"))
    out.append(f"Ad account: {account.get('name')} ({account['id']}), {account.get('currency', '')}")
    campaigns, adsets, ads = structure(api, account["id"])
    out += status_lines(campaigns, adsets, ads)
    for label, preset in [("Today", "today"), ("Yesterday", "yesterday"), ("Last 7 days", "last_7d")]:
        _, line = summarize(insights(api, account["id"], preset))
        out.append(f"{label}: {line}")


# Why spend usually drops to $0 without anyone pausing it.
TROUBLE = ("DISAPPROVED", "WITH_ISSUES", "PENDING_BILLING_INFO")
ACCOUNT_STATES = {2: "disabled", 3: "unsettled (a payment failed)", 7: "pending risk review",
                  8: "pending settlement", 9: "in a grace period", 100: "pending closure", 101: "closed"}


def ad_problems(account, campaigns, adsets, ads):
    """Lines for anything that stops ads delivering: a disapproved ad, a
    billing hold, a disabled or unpaid account."""
    out = []
    status = account.get("account_status")
    if status not in (None, 1, "1"):
        try:
            state = ACCOUNT_STATES.get(int(status), f"in state {status}")
        except (TypeError, ValueError):
            state = f"in state {status}"
        out.append(f"⚠️ The ad account is {state}: check Billing in Ads Manager")
    for kind, rows in (("Campaign", campaigns), ("Ad set", adsets), ("Ad", ads)):
        for r in rows:
            if r.get("effective_status") in TROUBLE:
                out.append(f"⚠️ {kind} *{r.get('name')}* is {r['effective_status'].lower().replace('_', ' ')}: check it in Ads Manager")
    return out


def running(campaigns, adsets, ads):
    """True when an active campaign has an active ad set with an active ad,
    i.e. something is supposed to be spending."""
    live = {c["id"] for c in campaigns if c.get("effective_status") == "ACTIVE"}
    sets = {s["id"] for s in adsets if s.get("effective_status") == "ACTIVE" and s.get("campaign_id") in live}
    return any(a.get("effective_status") == "ACTIVE" and a.get("adset_id") in sets for a in ads)


def cmd_report(api, account, out):
    """Returns (report, alert): the daily numbers for the activity channel,
    and what needs the owner for the alerts channel. Either may be None.
    The structure is read first: a disapproved ad or a billing hold is the
    usual reason spend is $0, so a quiet week must not skip that check."""
    campaigns, adsets, ads = structure(api, account["id"])
    problems = ad_problems(account, campaigns, adsets, ads)
    spend7, week = summarize(insights(api, account["id"], "last_7d"))
    yspend, yday = summarize(insights(api, account["id"], "yesterday"))
    if running(campaigns, adsets, ads) and yspend <= 0:
        problems.append("⚠️ A campaign is on but spent $0 yesterday: check delivery in Ads Manager")
    alert = "\n".join(["🚨 Meta ads need a look"] + problems) if problems else None
    if spend7 <= 0:
        out.append("No ad spend in the last 7 days; no report.")
        if alert:
            out.append(alert)
        return None, alert
    text = "\n".join([f"📈 Meta ads: yesterday {yday}", f"Last 7 days: {week}"] + problems)
    out.append(text)
    return text, alert


def alert_slack(text, link):
    """Post to the alerts channel (SLACK_ALERTS_WEBHOOK_URL, else the
    default webhook)."""
    url = os.environ.get("SLACK_ALERTS_WEBHOOK_URL", "").strip() or os.environ.get("SLACK_WEBHOOK_URL", "")
    old = os.environ.get("SLACK_WEBHOOK_URL")
    os.environ["SLACK_WEBHOOK_URL"] = url
    try:
        slack_notify.main([text, "--link", link])
    finally:
        if old is None:
            os.environ.pop("SLACK_WEBHOOK_URL", None)
        else:
            os.environ["SLACK_WEBHOOK_URL"] = old


def not_set_up(err):
    """The Page-token fallback seeing no ad account just means the ads token
    isn't set up yet (no META_ADS_TOKEN secret): not worth a daily alert."""
    return os.environ.get("META_ADS_TOKEN_SOURCE") == "page" and "sees no ad accounts" in str(err)


def set_status(api, target, status, out):
    obj = api.call("GET", target, fields="name,effective_status")
    api.call("POST", target, status=status)
    out.append(f"{obj.get('name')} ({target}): {obj.get('effective_status', '').lower()} → {status.lower()}")


def cmd_budget(api, target, dollars, force, out):
    if dollars <= 0:
        raise AdsError("Budget must be more than $0.")
    if dollars > MAX_DAILY_BUDGET and not force:
        raise AdsError(f"${dollars:,.2f}/day is over the ${MAX_DAILY_BUDGET} safety limit; run again with force to confirm.")
    obj = api.call("GET", target, fields="name,daily_budget")
    if not obj.get("daily_budget"):
        raise AdsError(f"{obj.get('name') or target} has no daily budget to change (the budget may be set on the campaign or ad set instead).")
    api.call("POST", target, daily_budget=str(int(round(dollars * 100))))
    out.append(f"{obj.get('name')} ({target}): daily budget {money(obj.get('daily_budget'))} → ${dollars:,.2f}")


def main(argv=None, session=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["status", "report", "pause", "resume", "budget"])
    ap.add_argument("target", nargs="?", default="")
    ap.add_argument("amount", nargs="?", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--scheduled", action="store_true", help="the daily run: setup problems alert Slack instead of failing it")
    args = ap.parse_args(argv)

    token = os.environ.get("META_ADS_TOKEN", "").strip()
    if not token:
        print("META_ADS_TOKEN / META_PAGE_TOKEN not set; nothing to do.")
        return 0
    api = Api(token, session)
    out = []
    try:
        account, _ = find_account(api, os.environ.get("META_AD_ACCOUNT_ID", "").strip())
        if args.command == "status":
            cmd_status(api, account, out)
        elif args.command == "report":
            text, alert = cmd_report(api, account, out)
            manager = f"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act={account['id'][4:]}"
            if text:
                slack_notify.main([text, "--link", manager])
            if alert:
                alert_slack(alert, manager)
        elif args.command in ("pause", "resume"):
            if not args.target:
                raise AdsError("Which campaign, ad set or ad? Pass its id.")
            set_status(api, args.target, "PAUSED" if args.command == "pause" else "ACTIVE", out)
        elif args.command == "budget":
            try:
                dollars = float(args.amount)
            except ValueError:
                raise AdsError("Budget needs an id and an amount in dollars, e.g. budget 1234 15") from None
            cmd_budget(api, args.target, dollars, args.force, out)
    except AdsError as e:
        print("\n".join(out))
        if args.scheduled:
            # The daily report can't run (expired or revoked token, lost
            # account access, Graph outage). A green run would look just
            # like a quiet day, so say so in the alerts channel.
            print(f"::warning::{e}")
            if not not_set_up(e):
                alert_slack(f"🚨 Meta ads daily report couldn't run: {e}",
                            os.environ.get("RUN_URL") or "https://adsmanager.facebook.com/")
            return 0
        print(f"::error::{e}")
        return 1
    text = "\n".join(out)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(f"### Meta ads: {args.command}\n\n" + "\n".join(f"{x}  " for x in out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
