#!/usr/bin/env python3
"""Market scan: how many event venues with Facebook or Instagram a town has.

    MARKET_LOCATIONS="Victoria, TX; Tupelo, MS" python3 scripts/market_scan.py
    python3 scripts/market_scan.py --estimate            # cost ceiling only, no Apify call

For comparing candidate towns before launching one (MULTI_CITY_PLAN.md 5).
Most of a town's automatic events come from venues' Facebook and Instagram
posts, so the count of real venues with a social page is the best early
measure of how much the collector will find there. Runs the same Google
Maps search as discover_venues.py (same categories, same HIGH/MEDIUM/SKIP
rules) for each location, with Victoria as the baseline, and reports:

  - places found, and how many have Facebook / Instagram;
  - HIGH (busy, well-reviewed event venues with a social page) and MEDIUM;
  - per category, venues with a social page (where a town is thin);
  - what the run cost (Apify's own figure for each run).

Read-only: writes market_scan_report.json and prints a table; no venue
file, no town, no site data is touched. Needs APIFY_TOKEN. The cost ceiling
is checked before anything runs (MARKET_MAX_USD, default $40): the scan
refuses to start if the worst case is over it.
"""
import argparse
import json
import os
import sys
import time

import requests

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
_saved_town = os.environ.pop("TOWN", None)   # the location comes from the args, not a town
import discover_venues as dv  # noqa: E402
if _saved_town is not None:
    os.environ["TOWN"] = _saved_town

# compass/google-maps-extractor, pay per event at Apify's FREE tier (the
# highest): place + detail page + company contacts (the social handles).
# Paid tiers cost less, so this is a ceiling.
USD_PER_PLACE = 0.005 + 0.002 + 0.004
DEFAULT_PER_SEARCH = 40
REPORT = os.path.join(ROOT, "market_scan_report.json")


def locations_from(text):
    return [x.strip() for x in str(text or "").replace("\n", ";").split(";") if x.strip()]


def estimate_usd(n_locations, per_search):
    return round(n_locations * len(dv.CATEGORY_SEARCHES) * per_search * USD_PER_PLACE, 2)


def summarize(items):
    """Counts for one location from the actor's raw items (deduped by place)."""
    seen, venues = set(), []
    for raw in items:
        v = dv.normalize_actor_item(raw)
        if not v.get("name"):
            continue
        key = dv._venue_key(v)
        if key in seen:
            continue
        seen.add(key)
        v["tier"] = dv.classify_tier(v)
        venues.append(v)
    social = [v for v in venues if dv._has_social(v)]
    by_cat = {}
    for term in dv.CATEGORY_SEARCHES:
        by_cat[term] = sum(1 for v in social if any(term.split()[0] in c.lower() for c in v.get("categories") or []))
    high = sorted((v for v in venues if v["tier"] == "HIGH"), key=lambda v: -(v.get("reviewsCount") or 0))
    return {
        "places": len(venues),
        "with_facebook": sum(1 for v in venues if v.get("facebooks")),
        "with_instagram": sum(1 for v in venues if v.get("instagrams")),
        "with_social": len(social),
        "high": len(high),
        "medium": sum(1 for v in venues if v["tier"] == "MEDIUM"),
        "social_by_category": by_cat,
        "top_high": [{"name": v["name"], "reviews": v.get("reviewsCount"), "rating": v.get("totalScore"),
                      "facebook": (v.get("facebooks") or [None])[0], "instagram": (v.get("instagrams") or [None])[0]}
                     for v in high[:15]],
    }


def run_cost(token, since_iso, get=requests.get):
    """What Apify charged for this actor's runs started since the scan began."""
    try:
        r = get(f"https://api.apify.com/v2/acts/{dv.APIFY_GMAPS_ACTOR}/runs",
                params={"desc": "true", "limit": 100}, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        runs = r.json().get("data", {}).get("items", [])
        return round(sum(x.get("usageTotalUsd") or 0 for x in runs if (x.get("startedAt") or "") >= since_iso), 4)
    except Exception as e:
        print(f"  (couldn't read the run cost: {type(e).__name__})")
        return None


def table(results):
    head = f"{'Location':<26}{'Places':>7}{'FB':>6}{'IG':>6}{'Social':>8}{'HIGH':>6}{'MED':>6}"
    lines = [head, "-" * len(head)]
    for loc, s in results.items():
        lines.append(f"{loc:<26}{s['places']:>7}{s['with_facebook']:>6}{s['with_instagram']:>6}"
                     f"{s['with_social']:>8}{s['high']:>6}{s['medium']:>6}")
    return "\n".join(lines)


def main(argv=None, run=None, cost=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--locations", default=os.environ.get("MARKET_LOCATIONS", ""),
                    help='"City, ST; City, ST" (Victoria, TX is added as the baseline)')
    ap.add_argument("--per-search", type=int, default=int(os.environ.get("MARKET_PER_SEARCH") or DEFAULT_PER_SEARCH))
    ap.add_argument("--max-usd", type=float, default=float(os.environ.get("MARKET_MAX_USD") or 40))
    ap.add_argument("--estimate", action="store_true", help="print the cost ceiling and stop")
    args = ap.parse_args(argv)
    locs = locations_from(args.locations)
    if not any(l.lower() == "victoria, tx" for l in locs):
        locs.insert(0, "Victoria, TX")
    per = max(1, min(args.per_search, 100))
    ceiling = estimate_usd(len(locs), per)
    print(f"{len(locs)} locations x {len(dv.CATEGORY_SEARCHES)} categories x {per} places: at most ${ceiling:.2f}")
    if args.estimate:
        return 0
    if ceiling > args.max_usd:
        print(f"Refusing: the worst case ${ceiling:.2f} is over MARKET_MAX_USD ${args.max_usd:.2f}.", file=sys.stderr)
        return 2
    token = os.environ.get("APIFY_TOKEN", "").strip()
    if not token and run is None:
        print("APIFY_TOKEN is not set.", file=sys.stderr)
        return 2

    dv.PLACES_PER_SEARCH = per
    # More places per search than the nightly discovery, so give each call
    # time to finish rather than count a cut-off search as a thin town, and
    # never retry: a retried search is billed twice and the ceiling above
    # assumes one try each (a failed category shows as 0 and is printed).
    dv.APIFY_ACTOR_TIMEOUT = 290
    dv.APIFY_PER_CALL_TIMEOUT = 300
    dv.APIFY_MAX_RETRIES = 0
    started = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    results = {}
    for loc in locs:
        print(f"\n== {loc}")
        dv.LOCATION_QUERY = loc
        items = (run or (lambda: dv.run_apify_discovery(token, total_budget_seconds=1800)))()
        results[loc] = summarize(items)
    spent = (cost or (lambda: run_cost(token, started)))()
    report = {"generated_at": started + "Z", "per_search": per, "ceiling_usd": ceiling, "spent_usd": spent,
              "categories": dv.CATEGORY_SEARCHES, "locations": results}
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print("\n" + table(results))
    print(f"\nApify charged: {'$%.2f' % spent if spent is not None else 'unknown'} (ceiling ${ceiling:.2f})")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("## Market scan\n\n```\n" + table(results) + "\n```\n\n"
                    f"Apify charged: {'$%.2f' % spent if spent is not None else 'unknown'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
