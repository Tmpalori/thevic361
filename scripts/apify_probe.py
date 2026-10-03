#!/usr/bin/env python3
"""Try candidate Apify actors against Victoria, TX and report what they return.

Manual-only (see .github/workflows/apify-probe.yml). Nothing is committed:
the report goes to the job log and a JSON artifact. Each actor runs with a
small item cap so a probe costs cents.

For each actor we fetch its input schema, start from the schema's prefill
values, then override the fields that look like a search query, location
or limit. The schema is printed too, so a bad guess is easy to fix.
"""
import json
import os
import re
import sys
import time

import requests

TOKEN = os.environ.get("APIFY_TOKEN", "").strip()
API = "https://api.apify.com/v2"
MAX_ITEMS = int(os.environ.get("PROBE_MAX_ITEMS", "40"))

QUERY = "events in Victoria, TX"
CITY = "Victoria, TX"

# actor id → extra input overrides (applied after the generic guesses)
ACTORS = {
    # Baseline: what the collector uses today.
    "apify/facebook-events-scraper": {"searchQueries": ["Victoria Texas"], "maxEvents": MAX_ITEMS},
    # Google Events aggregates Eventbrite, venue sites, Facebook, ticketing.
    "muhammadafzal/google-events": {},
    "codingfrontend/google-events-scraper": {},
    # Eventbrite by city.
    "datapilot/eventbrite-events-scraper": {},
    "khadinakbar/eventbrite-events-scraper": {},
    # Facebook events search by city, no login.
    "alfalfa/facebook-events-scraper": {"searchQueries": ["Victoria, Texas", "events Victoria TX"]},
    # Live music by city.
    "parseforge/bandsintown-concerts-scraper": {},
    "automation-lab/bandsintown-events-scraper": {},
}

VICTORIA_RE = re.compile(r"victoria,?\s*(tx|texas)|\b7790[145]\b", re.I)


def guess_input(schema):
    props = (schema or {}).get("properties", {}) or {}
    inp = {}
    for name, spec in props.items():
        if "prefill" in spec:
            inp[name] = spec["prefill"]
        elif "default" in spec:
            inp[name] = spec["default"]
    for name, spec in props.items():
        n = name.lower()
        typ = spec.get("type")
        if re.search(r"max|limit|count|results", n) and typ == "integer":
            inp[name] = MAX_ITEMS
        elif re.search(r"quer|search|keyword|term", n):
            inp[name] = [QUERY] if typ == "array" else QUERY
        elif re.search(r"city|location|place|near|where", n) and typ in ("string", None):
            inp[name] = CITY
        elif re.search(r"city|location", n) and typ == "array":
            inp[name] = [CITY]
        elif re.search(r"country", n) and typ == "string":
            inp[name] = spec.get("prefill") or "US"
        elif re.search(r"future|upcoming", n) and typ == "boolean":
            inp[name] = True
        elif re.search(r"proxy", n):
            inp.setdefault(name, {"useApifyProxy": True})
    return inp


def actor_schema(actor):
    aid = actor.replace("/", "~")
    r = requests.get(f"{API}/acts/{aid}", params={"token": TOKEN}, timeout=30)
    if r.status_code != 200:
        return None, f"actor lookup HTTP {r.status_code}"
    data = r.json().get("data", {})
    build_tag = (data.get("defaultRunOptions") or {}).get("build", "latest")
    build_id = (data.get("taggedBuilds") or {}).get(build_tag, {}).get("buildId")
    if not build_id:
        return {}, None
    b = requests.get(f"{API}/actor-builds/{build_id}", params={"token": TOKEN}, timeout=30)
    raw = (b.json().get("data") or {}).get("inputSchema") if b.status_code == 200 else None
    try:
        return (json.loads(raw) if isinstance(raw, str) else (raw or {})), None
    except ValueError:
        return {}, None


def run_actor(actor, inp):
    aid = actor.replace("/", "~")
    r = requests.post(f"{API}/acts/{aid}/runs", params={"token": TOKEN, "maxItems": MAX_ITEMS},
                      json=inp, timeout=60)
    if r.status_code not in (200, 201):
        return None, f"start HTTP {r.status_code}: {r.text[:300]}"
    run = r.json()["data"]
    deadline = time.time() + 300
    while run["status"] in ("READY", "RUNNING") and time.time() < deadline:
        time.sleep(10)
        run = requests.get(f"{API}/actor-runs/{run['id']}", params={"token": TOKEN}, timeout=30).json()["data"]
    if run["status"] in ("READY", "RUNNING"):
        requests.post(f"{API}/actor-runs/{run['id']}/abort", params={"token": TOKEN}, timeout=30)
        return {"status": "TIMEOUT", "items": [], "usd": None}, None
    items = requests.get(f"{API}/datasets/{run['defaultDatasetId']}/items",
                         params={"token": TOKEN, "clean": "true", "limit": MAX_ITEMS}, timeout=60).json()
    return {"status": run["status"], "items": items if isinstance(items, list) else [],
            "usd": run.get("usageTotalUsd")}, None


def main():
    if not TOKEN:
        sys.exit("APIFY_TOKEN not set")
    only = [a.strip() for a in os.environ.get("PROBE_ACTORS", "").split(",") if a.strip()]
    report = {}
    for actor, overrides in ACTORS.items():
        if only and actor not in only:
            continue
        print(f"\n━━━ {actor}")
        schema, err = actor_schema(actor)
        if err:
            print(f"  ✗ {err}")
            report[actor] = {"error": err}
            continue
        props = (schema or {}).get("properties", {})
        print("  input fields:", ", ".join(f"{k}:{v.get('type')}" for k, v in props.items())[:600])
        inp = guess_input(schema)
        inp.update(overrides)
        print("  input used:", json.dumps(inp)[:600])
        res, err = run_actor(actor, inp)
        if err:
            print(f"  ✗ {err}")
            report[actor] = {"error": err, "input": inp}
            continue
        items = res["items"]
        local = [i for i in items if VICTORIA_RE.search(json.dumps(i))]
        keys = sorted({k for i in items[:20] if isinstance(i, dict) for k in i})
        print(f"  status={res['status']} items={len(items)} victoria_mentions={len(local)} cost_usd={res['usd']}")
        print("  fields:", ", ".join(keys)[:500])
        for i in (local or items)[:4]:
            print("  sample:", json.dumps(i, ensure_ascii=False)[:500])
        report[actor] = {"status": res["status"], "items": len(items), "victoria": len(local),
                         "usd": res["usd"], "fields": keys, "input": inp, "samples": (local or items)[:10]}
    with open("apify_probe_report.json", "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print("\nSUMMARY")
    for a, r in report.items():
        print(f"  {a}: " + (r.get("error") or f"{r['items']} items, {r['victoria']} Victoria, ${r['usd']}"))


if __name__ == "__main__":
    main()
