"""Google Maps venue discovery for The Vic 361.

Runs the Apify ``compass/google-maps-extractor`` actor against a fixed list of
category searches scoped to ``Victoria, TX``. Each result is enriched with
place-detail + company-contacts/social fields so we can capture Instagram and
Facebook handles, websites, ratings, and lat/lng.

Tiering rules:
  - HIGH:   rating >= 4.2, reviews >= 50, event-likely category, IG or FB
  - MEDIUM: (rating >= 3.8 OR reviews < 50), IG or FB
  - SKIP:   permanently/temporarily closed, fast-food chain, rating < 3.5,
            or no social presence

Outputs:
  - HIGH venues auto-merge into ``venues.json`` (the new primary venue source)
  - MEDIUM venues append to ``pending_venues.json`` for admin approval
  - Anything in ``rejected_venues.json`` is never re-suggested

Existing venues in the repo (``facebook_venues.json``) are preserved as a
"seed floor" — they are never deleted and always carried forward into
``venues.json``. The legacy file is also copied to
``facebook_venues.backup.json`` so collectors that haven't migrated still
have something to read.

Safe to run unattended: if ``APIFY_TOKEN`` is missing or the actor errors out,
discovery is a no-op — existing venue files are left untouched.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Iterable

import requests


# ─── SENTRY (silent failure observability) ──────────────────────────────────
# Mirrors collect_events.py: a missing SENTRY_DSN or missing sentry_sdk
# leaves these hooks as no-ops, but if Sentry IS configured the workflow
# logs are no longer the only way to see breakage. The audit specifically
# called out that this script previously double-silenced everything (every
# error path printed a one-liner and returned []), so each interesting
# failure now also fires a Sentry event.

_SENTRY_ENABLED = False
try:
    import sentry_sdk  # type: ignore
    _dsn = os.environ.get("SENTRY_DSN", "").strip()
    if _dsn:
        sentry_sdk.init(
            dsn=_dsn,
            traces_sample_rate=0.0,
            environment=os.environ.get(
                "SENTRY_ENVIRONMENT", "thevic361-discover-venues"
            ),
            release=os.environ.get("GITHUB_SHA", "local")[:12],
        )
        _SENTRY_ENABLED = True
except Exception:
    _SENTRY_ENABLED = False


def _sentry_warn(message: str, **tags: Any) -> None:
    if not _SENTRY_ENABLED:
        return
    try:
        with sentry_sdk.push_scope() as scope:
            for k, v in tags.items():
                scope.set_tag(k, v)
            sentry_sdk.capture_message(message, level="warning")
    except Exception:
        pass


def _sentry_exception(stage: str, **tags: Any) -> None:
    if not _SENTRY_ENABLED:
        return
    try:
        with sentry_sdk.push_scope() as scope:
            scope.set_tag("stage", stage)
            for k, v in tags.items():
                scope.set_tag(k, v)
            sentry_sdk.capture_exception()
    except Exception:
        pass


# ─── Constants ──────────────────────────────────────────────────────────────

APIFY_GMAPS_ACTOR = "compass~google-maps-extractor"
APIFY_RUN_TIMEOUT = 240  # seconds

CATEGORY_SEARCHES = [
    "bar",
    "restaurant",
    "live music venue",
    "theater",
    "museum",
    "bowling alley",
    "event venue",
    "community center",
]

LOCATION_QUERY = "Victoria, TX"

# Categories where we're meaningfully more likely to discover events. Used as
# part of the HIGH-tier gate.
EVENT_LIKELY_TOKENS = {
    "bar",
    "live music",
    "music venue",
    "concert",
    "theater",
    "theatre",
    "museum",
    "bowling",
    "event venue",
    "community center",
    "winery",
    "brewery",
    "nightclub",
    "dance hall",
    "arts",
    "performing arts",
    "gallery",
    "venue",
}

# Chain names we never want to surface as event venues. Lowercase, partial-match.
FAST_FOOD_CHAINS = {
    "mcdonald",
    "burger king",
    "wendy",
    "taco bell",
    "kfc",
    "subway",
    "chick-fil-a",
    "chick fil a",
    "popeyes",
    "arby",
    "sonic drive",
    "dairy queen",
    "whataburger",
    "domino",
    "pizza hut",
    "papa john",
    "little caesars",
    "starbucks",
    "dunkin",
    "panda express",
    "five guys",
    "jack in the box",
    "carl's jr",
    "hardee",
    "ihop",
    "denny",
    "waffle house",
}


# ─── File helpers ───────────────────────────────────────────────────────────


def _here() -> str:
    return os.path.dirname(os.path.abspath(__file__)) or "."


def _load_json(path: str, default):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:  # pragma: no cover - defensive
        print(f"  [discover] Failed to read {path}: {e}", file=sys.stderr)
        return default


def _write_json(path: str, data) -> None:
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ─── Normalization & dedupe ─────────────────────────────────────────────────


def _normalize_name(name: str) -> str:
    """Lowercase + strip punctuation/whitespace for dedupe keys."""
    if not name:
        return ""
    s = name.lower().strip()
    s = re.sub(r"[’']", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _venue_key(v: dict) -> str:
    """Stable identity for a venue across the seed list and discovery results."""
    place_id = (v.get("place_id") or "").strip()
    if place_id:
        return f"pid:{place_id}"
    return f"name:{_normalize_name(v.get('name', ''))}"


def _first(*values):
    for v in values:
        if v:
            return v
    return None


def _coerce_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return [v for v in value if v]
    return [value]


# ─── Tiering ────────────────────────────────────────────────────────────────


def _has_social(venue: dict) -> bool:
    if venue.get("instagrams") or venue.get("facebooks"):
        return True
    # Seed venues store a single facebook_page string.
    if (venue.get("facebook_page") or "").strip():
        return True
    if (venue.get("instagram") or "").strip():
        return True
    return False


def _is_event_likely(categories: Iterable[str]) -> bool:
    # Word-aware matching so "Barber Shop" doesn't trip on "bar".
    blob = " " + re.sub(r"[^a-z0-9]+", " ", " ".join(
        (c or "").lower() for c in categories
    )) + " "
    for tok in EVENT_LIKELY_TOKENS:
        needle = " " + tok + " "
        if needle in blob:
            return True
    return False


def _is_fast_food_chain(name: str, categories: Iterable[str]) -> bool:
    name_l = (name or "").lower()
    if any(chain in name_l for chain in FAST_FOOD_CHAINS):
        return True
    cats_l = " ".join((c or "").lower() for c in categories)
    if "fast food" in cats_l:
        # Allow "fast food" if name doesn't trip the chain list AND it's tiny.
        # We're conservative: drop chains, keep mom-and-pop fast food.
        if any(chain in name_l for chain in FAST_FOOD_CHAINS):
            return True
    return False


def _is_closed(venue: dict) -> bool:
    status = (venue.get("permanentlyClosed") or venue.get("permanently_closed")
              or venue.get("closed") or venue.get("temporarilyClosed")
              or venue.get("temporarily_closed"))
    if isinstance(status, bool) and status:
        return True
    bs = (venue.get("businessStatus") or venue.get("business_status") or "")
    if isinstance(bs, str) and bs:
        bs_l = bs.lower()
        if "closed_permanently" in bs_l or "closed_temporarily" in bs_l:
            return True
        if bs_l in ("closed", "permanently_closed", "temporarily_closed"):
            return True
    return False


def classify_tier(venue: dict) -> str:
    """Return 'HIGH', 'MEDIUM', or 'SKIP' for a (normalized) venue dict."""
    if _is_closed(venue):
        return "SKIP"

    name = venue.get("name") or ""
    categories = _coerce_list(venue.get("categories"))
    if _is_fast_food_chain(name, categories):
        return "SKIP"

    rating = venue.get("totalScore")
    try:
        rating_f = float(rating) if rating is not None else None
    except (TypeError, ValueError):
        rating_f = None

    reviews = venue.get("reviewsCount")
    try:
        reviews_i = int(reviews) if reviews is not None else 0
    except (TypeError, ValueError):
        reviews_i = 0

    if rating_f is not None and rating_f < 3.5:
        return "SKIP"

    if not _has_social(venue):
        return "SKIP"

    if (
        rating_f is not None
        and rating_f >= 4.2
        and reviews_i >= 50
        and _is_event_likely(categories)
    ):
        return "HIGH"

    if (rating_f is not None and rating_f >= 3.8) or reviews_i < 50:
        return "MEDIUM"

    return "SKIP"


# ─── Apify actor wrapper ────────────────────────────────────────────────────


def _build_actor_input(search_terms: list[str]) -> dict:
    """Input payload for compass/google-maps-extractor.

    The actor evolves over time; we pass several near-equivalent flags so the
    payload survives small renames. Unknown keys are ignored by Apify.
    """
    return {
        "searchStringsArray": search_terms,
        "locationQuery": LOCATION_QUERY,
        "language": "en",
        "maxCrawledPlacesPerSearch": 30,
        # Detail-page enrichment — different actor versions accept different
        # spellings, so include both.
        "scrapePlaceDetailPage": True,
        "scrapeDetail": True,
        # Company contacts / social handles enrichment.
        "scrapeCompanyContacts": True,
        "includeWebResults": True,
        "scrapeContacts": True,
        # Reviews aren't needed for tiering beyond the aggregate count, which
        # is part of the basic place result.
        "maxReviews": 0,
        "maxImages": 0,
    }


def run_apify_discovery(token: str, *, http_post=None) -> list[dict]:
    """Call the Apify actor and return the raw item list. Empty list on error.

    Failures are intentionally non-fatal (the workflow comment says discovery
    is best-effort), but they are no longer silent — each failure path fires
    a Sentry event so the operator can see breakage without grep-diving the
    Actions log.
    """
    post = http_post or requests.post
    url = (
        f"https://api.apify.com/v2/acts/{APIFY_GMAPS_ACTOR}"
        f"/run-sync-get-dataset-items?token={token}"
    )
    payload = _build_actor_input(CATEGORY_SEARCHES)
    try:
        resp = post(
            url,
            json=payload,
            timeout=APIFY_RUN_TIMEOUT,
            headers={"Content-Type": "application/json"},
        )
    except Exception as e:
        print(f"  [discover] Apify request failed: {e}")
        _sentry_exception("apify_request", actor=APIFY_GMAPS_ACTOR)
        return []

    status = getattr(resp, "status_code", 0)
    if status >= 400:
        text = getattr(resp, "text", "") or ""
        print(f"  [discover] Apify HTTP {status}: {text[:300]}")
        _sentry_warn(
            f"[discover] Apify HTTP {status}",
            actor=APIFY_GMAPS_ACTOR,
            status=str(status),
        )
        return []

    try:
        items = resp.json()
    except Exception as e:
        print(f"  [discover] Apify response parse failed: {e}")
        _sentry_exception("apify_parse", actor=APIFY_GMAPS_ACTOR)
        return []

    if not isinstance(items, list):
        kind = type(items).__name__
        print(f"  [discover] Unexpected Apify payload type: {kind}")
        _sentry_warn(
            "[discover] Unexpected Apify payload type",
            actor=APIFY_GMAPS_ACTOR,
            payload_type=kind,
        )
        return []
    return items


# ─── Mapping Apify items → our venue dict ───────────────────────────────────


def normalize_actor_item(item: dict) -> dict:
    """Map a raw Apify item into our internal venue dict shape."""
    if not isinstance(item, dict):
        return {}

    name = _first(item.get("title"), item.get("name"))
    place_id = _first(item.get("placeId"), item.get("place_id"))
    website = _first(item.get("website"), item.get("websiteUrl"), item.get("url"))
    rating = _first(item.get("totalScore"), item.get("rating"))
    reviews = _first(item.get("reviewsCount"), item.get("userRatingsTotal"),
                     item.get("ratingCount"))

    raw_cats = item.get("categories")
    if not raw_cats:
        cat = item.get("categoryName") or item.get("category")
        raw_cats = [cat] if cat else []
    categories = _coerce_list(raw_cats)

    # Apify variants: instagrams[], instagram, instagramUrl
    igs = _coerce_list(item.get("instagrams"))
    if not igs:
        ig = _first(item.get("instagram"), item.get("instagramUrl"))
        if ig:
            igs = [ig]
    fbs = _coerce_list(item.get("facebooks"))
    if not fbs:
        fb = _first(item.get("facebook"), item.get("facebookUrl"))
        if fb:
            fbs = [fb]

    location = item.get("location") or {}
    lat = _first(item.get("lat"), location.get("lat"))
    lng = _first(item.get("lng"), location.get("lng"), item.get("lon"))

    address = _first(item.get("address"), item.get("formattedAddress"),
                     item.get("street"))

    closed_flag = _first(item.get("permanentlyClosed"),
                         item.get("temporarilyClosed"))

    venue = {
        "name": name,
        "place_id": place_id,
        "address": address,
        "categories": categories,
        "website": website,
        "instagrams": igs,
        "facebooks": fbs,
        "totalScore": rating,
        "reviewsCount": reviews,
        "lat": lat,
        "lng": lng,
        "businessStatus": item.get("businessStatus") or item.get("permanentlyClosed"),
        "permanentlyClosed": bool(closed_flag) if isinstance(closed_flag, bool) else None,
        "source": "google_maps",
    }
    # Mirror primary FB into facebook_page for back-compat with collectors.
    if fbs:
        venue["facebook_page"] = fbs[0]
    return venue


# ─── Seed floor & merge ─────────────────────────────────────────────────────


def load_seed_venues(repo_root: str | None = None) -> list[dict]:
    """Preserve every existing repo venue as the seed floor.

    The 73-venue workspace file is missing, so we lean on
    ``facebook_venues.json`` as the safety floor. Each entry is left
    structurally intact and tagged with ``source='seed'``.
    """
    root = repo_root or _here()
    fb_venues = _load_json(os.path.join(root, "facebook_venues.json"), [])
    seed: list[dict] = []
    for v in fb_venues:
        if not isinstance(v, dict):
            continue
        copy = dict(v)
        copy.setdefault("source", "seed")
        seed.append(copy)
    return seed


def merge_venues(
    seed: list[dict],
    discovered_high: list[dict],
    existing_venues: list[dict] | None = None,
) -> list[dict]:
    """Merge seed + existing + new HIGH discoveries into one venue list.

    Seed venues are never dropped. Discovered HIGH venues are added when their
    dedupe key is new. Re-runs are idempotent: existing entries' enrichment
    fields are refreshed from the latest discovery, but the seed metadata
    (notes, confidence) is preserved.
    """
    by_key: dict[str, dict] = {}
    order: list[str] = []

    def _add(v: dict) -> None:
        if not isinstance(v, dict) or not v.get("name"):
            return
        k = _venue_key(v)
        if not k or k == "name:":
            return
        if k in by_key:
            # Refresh enrichment fields from the new record without clobbering
            # seed-level annotations.
            existing = by_key[k]
            for field in (
                "instagrams", "facebooks", "website", "totalScore",
                "reviewsCount", "categories", "lat", "lng", "place_id",
                "address",
            ):
                if v.get(field) and not existing.get(field):
                    existing[field] = v[field]
            return
        by_key[k] = dict(v)
        order.append(k)

    for v in seed or []:
        _add(v)
    for v in existing_venues or []:
        _add(v)
    for v in discovered_high or []:
        _add(v)

    return [by_key[k] for k in order]


def append_pending(
    pending_path: str,
    new_medium: list[dict],
    *,
    rejected_keys: set[str],
    floor_keys: set[str],
) -> list[dict]:
    """Append new MEDIUM venues to pending_venues.json without duplicates."""
    existing = _load_json(pending_path, [])
    existing_keys = {_venue_key(v) for v in existing if isinstance(v, dict)}
    out = list(existing)
    for v in new_medium:
        k = _venue_key(v)
        if not k or k == "name:":
            continue
        if k in rejected_keys or k in floor_keys or k in existing_keys:
            continue
        out.append(v)
        existing_keys.add(k)
    return out


# ─── Orchestration ──────────────────────────────────────────────────────────


def discover_and_update(repo_root: str | None = None, *, http_post=None) -> dict:
    """Top-level entry point. Returns a summary dict for logging/tests."""
    root = repo_root or _here()
    venues_path = os.path.join(root, "venues.json")
    pending_path = os.path.join(root, "pending_venues.json")
    rejected_path = os.path.join(root, "rejected_venues.json")
    legacy_path = os.path.join(root, "facebook_venues.json")
    backup_path = os.path.join(root, "facebook_venues.backup.json")

    summary = {
        "ran_apify": False,
        "discovered_high": 0,
        "discovered_medium": 0,
        "skipped": 0,
        "venues_total": 0,
        "pending_total": 0,
    }

    seed = load_seed_venues(root)
    floor_keys = {_venue_key(v) for v in seed}

    rejected = _load_json(rejected_path, [])
    rejected_keys = {_venue_key(v) for v in rejected if isinstance(v, dict)}

    existing_primary = _load_json(venues_path, None)
    if existing_primary is None:
        existing_primary = []

    # 1. Always (re)write the legacy backup so transitional collectors keep
    #    seeing the old file even after we cut over to venues.json.
    if os.path.exists(legacy_path):
        try:
            with open(legacy_path, "r") as f:
                legacy_data = json.load(f)
            _write_json(backup_path, legacy_data)
        except Exception as e:
            print(f"  [discover] Could not refresh legacy backup: {e}")

    token = (os.environ.get("APIFY_TOKEN") or "").strip()
    discovered_high: list[dict] = []
    discovered_medium: list[dict] = []
    skipped = 0

    if not token:
        # Visible-skipped-token: a zero-effort path that used to be logged
        # only to stdout. Now also fires a Sentry warning so the operator
        # finds out before the next weekly digest comes in dry.
        print("  [discover] No APIFY_TOKEN — skipping Google Maps discovery")
        _sentry_warn(
            "[discover] APIFY_TOKEN not set; venue discovery skipped",
            stage="apify_token_missing",
        )
    else:
        items = run_apify_discovery(token, http_post=http_post)
        summary["ran_apify"] = True
        seen_keys: set[str] = set()
        for raw in items:
            v = normalize_actor_item(raw)
            if not v.get("name"):
                continue
            k = _venue_key(v)
            if k in seen_keys or k in rejected_keys:
                continue
            seen_keys.add(k)
            tier = classify_tier(v)
            if tier == "HIGH":
                v["tier"] = "HIGH"
                discovered_high.append(v)
            elif tier == "MEDIUM":
                v["tier"] = "MEDIUM"
                discovered_medium.append(v)
            else:
                skipped += 1

        # Surface the silent-zero case: token was set, actor ran, but
        # NOTHING new came back across HIGH/MEDIUM. That can be legitimate
        # (everything in Victoria is already in the seed list) but is more
        # often a sign the actor schema changed, the token's quota lapsed,
        # or the location query stopped resolving. We want a Sentry ping
        # on that, not just a dry workflow log.
        if not discovered_high and not discovered_medium:
            _sentry_warn(
                "[discover] Apify ran but produced 0 HIGH and 0 MEDIUM venues",
                stage="apify_zero_results",
                items=str(len(items)),
                skipped=str(skipped),
            )

    # 2. Merge HIGH + seed + existing → venues.json
    merged = merge_venues(seed, discovered_high, existing_primary)
    _write_json(venues_path, merged)

    # 3. Append MEDIUM to pending_venues.json
    floor_keys_full = floor_keys | {_venue_key(v) for v in merged}
    pending = append_pending(
        pending_path,
        discovered_medium,
        rejected_keys=rejected_keys,
        floor_keys=floor_keys_full,
    )
    _write_json(pending_path, pending)

    summary.update(
        discovered_high=len(discovered_high),
        discovered_medium=len(discovered_medium),
        skipped=skipped,
        venues_total=len(merged),
        pending_total=len(pending),
    )
    print(
        "  [discover] HIGH={discovered_high} MEDIUM={discovered_medium} "
        "SKIP={skipped} venues.json={venues_total} pending={pending_total}".format(
            **summary
        )
    )
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Google Maps venue discovery")
    parser.add_argument(
        "--repo-root",
        default=None,
        help="Override the repo root (defaults to the script's directory)",
    )
    args = parser.parse_args(argv)
    try:
        discover_and_update(repo_root=args.repo_root)
        return 0
    except Exception as e:
        # Non-destructive failure: capture to Sentry (so it's visible) and
        # exit 0 so the workflow continues with the existing venue files.
        # The audit's complaint was that THIS path used to be the only
        # signal that anything went wrong — it was a stdout one-liner that
        # the workflow then masked again with `|| echo "skipped"`. Sentry
        # makes the failure surface even when nobody reads the Action log.
        print(f"  [discover] Discovery failed (non-fatal): {e}")
        _sentry_exception("discover_top_level")
        return 0


if __name__ == "__main__":
    sys.exit(main())
