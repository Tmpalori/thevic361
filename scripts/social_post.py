#!/usr/bin/env python3
"""Post the social kit to the Facebook Page and Instagram account.

Runs from .github/workflows/social-kit.yml after the kit is committed and
deployed, and only when the SOCIAL_AUTOPOST repo variable is 1. Monday
posts "this week", Thursday posts "this weekend" (as a Reel on Instagram
when the kit has one; Reels reach people who don't follow us yet), and
the other days post "today".

Needs (GitHub Actions secrets):
  META_PAGE_ID        Facebook Page id
  META_PAGE_TOKEN     long-lived Page access token with pages_manage_posts,
                      instagram_basic, instagram_content_publish
  IG_USER_ID          Instagram business account id linked to the Page
                      (optional; Facebook still posts without it)

Instagram fetches images by URL, so the slides must be live on
thevic361.com first; we wait for the deploy before posting.
"""
import argparse
import json
import os
import sys
import time

import requests

SITE = os.environ.get("SITE_URL", "https://www.thevic361.com").rstrip("/")
GRAPH = f"https://graph.facebook.com/{os.environ.get('GRAPH_API_VERSION', 'v23.0')}"
KIT_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "social", "latest")
MAX_CAROUSEL = 10  # Instagram's carousel limit (Facebook allows more, but keep them in sync)


class PostError(RuntimeError):
    pass


def pick_slides(slides, limit=MAX_CAROUSEL):
    """Cover first and the call-to-action last; day slides in between."""
    if len(slides) <= limit:
        return list(slides)
    return [slides[0]] + list(slides[1:limit - 1]) + [slides[-1]]


def _graph(method, path, session, **params):
    r = session.request(method, f"{GRAPH}/{path}", data=params, timeout=60)
    try:
        body = r.json()
    except ValueError:
        body = {"raw": r.text[:300]}
    if r.status_code >= 400 or (isinstance(body, dict) and body.get("error")):
        err = body.get("error", body) if isinstance(body, dict) else body
        raise PostError(f"{method} {path} failed: {json.dumps(err)[:300]}")
    return body


def wait_for_deploy(urls, kit_url, generated_for, session, timeout_s=600, sleep=15):
    """Wait until the deployed kit.json is this run's kit and the images load."""
    deadline = time.time() + timeout_s
    while True:
        try:
            live = session.get(kit_url, timeout=20)
            if live.ok and live.json().get("generated_for") == generated_for \
                    and all(session.head(u, timeout=20).ok for u in urls):
                return True
        except (requests.RequestException, ValueError):
            pass
        if time.time() >= deadline:
            raise PostError("Slides never appeared on the live site; not posting.")
        time.sleep(sleep)


def post_facebook(page_id, token, image_urls, caption, session):
    """Upload photos unpublished, then one feed post with all of them attached."""
    media = []
    for url in image_urls:
        photo = _graph("POST", f"{page_id}/photos", session, url=url, published="false", access_token=token)
        media.append({"media_fbid": photo["id"]})
    params = {"message": caption, "access_token": token}
    for i, m in enumerate(media):
        params[f"attached_media[{i}]"] = json.dumps(m)
    return _graph("POST", f"{page_id}/feed", session, **params)["id"]


def post_instagram(ig_user_id, token, image_urls, caption, session, poll_sleep=5):
    """Carousel: one container per image, a carousel container, then publish."""
    children = []
    for url in image_urls:
        item = _graph("POST", f"{ig_user_id}/media", session,
                      image_url=url, is_carousel_item="true", access_token=token)
        children.append(item["id"])
    carousel = _graph("POST", f"{ig_user_id}/media", session, media_type="CAROUSEL",
                      children=",".join(children), caption=caption, access_token=token)
    # Instagram processes containers asynchronously; publish once FINISHED.
    for _ in range(24):
        status = _graph("GET", carousel["id"], session, fields="status_code", access_token=token)
        if status.get("status_code") == "FINISHED":
            break
        if status.get("status_code") == "ERROR":
            raise PostError("Instagram could not process the carousel.")
        time.sleep(poll_sleep)
    return _graph("POST", f"{ig_user_id}/media_publish", session,
                  creation_id=carousel["id"], access_token=token)["id"]


def post_instagram_reel(ig_user_id, token, video_url, caption, session, poll_sleep=10):
    """Reel: one video container (also shown in the feed), then publish."""
    item = _graph("POST", f"{ig_user_id}/media", session, media_type="REELS", video_url=video_url,
                  caption=caption, share_to_feed="true", access_token=token)
    # Video takes longer to process than photos.
    for _ in range(36):
        status = _graph("GET", item["id"], session, fields="status_code", access_token=token)
        if status.get("status_code") == "FINISHED":
            break
        if status.get("status_code") == "ERROR":
            raise PostError("Instagram could not process the Reel.")
        time.sleep(poll_sleep)
    else:
        raise PostError("Instagram was still processing the Reel after 6 minutes.")
    return _graph("POST", f"{ig_user_id}/media_publish", session,
                  creation_id=item["id"], access_token=token)["id"]


def main(argv=None, session=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=["week", "weekend", "today"], required=True)
    ap.add_argument("--kit-dir", default=KIT_DIR)
    ap.add_argument("--no-wait", action="store_true", help="Skip waiting for the deploy (testing)")
    args = ap.parse_args(argv)
    session = session or requests.Session()

    page_id = os.environ.get("META_PAGE_ID", "").strip()
    token = os.environ.get("META_PAGE_TOKEN", "").strip()
    ig_user = os.environ.get("IG_USER_ID", "").strip()
    if not page_id or not token:
        print("META_PAGE_ID / META_PAGE_TOKEN not set; skipping auto-post.")
        return 0

    with open(os.path.join(args.kit_dir, "kit.json")) as f:
        manifest = json.load(f)
    kit = manifest["kits"][args.kind]
    if not kit.get("events"):
        print(f"No events in the {args.kind} kit; not posting an empty list.")
        return 0

    base = f"{SITE}/social/latest"
    urls = [f"{base}/{name}" for name in pick_slides(kit["slides"])]
    reel_url = f"{base}/{kit['reel']}" if kit.get("reel") else None
    if not args.no_wait:
        wait_for_deploy(urls + ([reel_url] if reel_url else []), f"{base}/kit.json",
                        manifest["generated_for"], session)

    failures = []
    try:
        fb_id = post_facebook(page_id, token, urls, kit["captions"]["facebook"], session)
        print(f"Facebook: posted {fb_id}")
    except PostError as e:
        failures.append(f"Facebook: {e}")
    if ig_user:
        try:
            if reel_url:
                ig_id = post_instagram_reel(ig_user, token, reel_url, kit["captions"]["instagram"], session)
                print(f"Instagram: posted Reel {ig_id}")
            else:
                ig_id = post_instagram(ig_user, token, urls, kit["captions"]["instagram"], session)
                print(f"Instagram: posted {ig_id}")
        except PostError as e:
            failures.append(f"Instagram: {e}")
    else:
        print("IG_USER_ID not set; skipping Instagram.")

    for f in failures:
        print(f"::error::{f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
