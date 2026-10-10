"""scripts/launch_check.py (MULTI_CITY_PLAN.md 5.3): a new town's live site
checked read-only against a fake site."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import launch_check  # noqa: E402
import new_town  # noqa: E402

SITE = "https://www.thebay979.com"
BAY = ["--slug", "bay", "--name", "The Bay 979", "--domain", "thebay979.com", "--city", "Bay City", "--state", "TX",
       "--state-name", "Texas", "--timezone", "America/Chicago", "--yes"]


def fake_site(**override):
    pages = {
        "/api/health?deep=1": (200, json.dumps({"ok": True, "storage": "postgres"})),
        "/api/config": (200, json.dumps({"town": {"id": "bay", "domain": "thebay979.com"},
                                         "github_events_path": "towns/bay/public/events.json"})),
        "/robots.txt": (200, f"User-agent: *\nSitemap: {SITE}/sitemap.xml\n"),
        "/sitemap.xml": (200, f"<urlset><url><loc>{SITE}/</loc></url></urlset>"),
        "/events.json": (200, json.dumps({"events": []})),
        "/api/hq/summary": (200, json.dumps({"ok": True, "town": {"id": "bay"}})),
        **{p: (200, f"<h1>The Bay 979</h1> Bay City, TX {p}") for p in launch_check.PAGES},
    }
    pages.update(override)
    seen = []

    def get(url, headers=None):
        path = url[len(SITE):]
        seen.append((path, (headers or {}).get("Authorization")))
        status, body = pages.get(path, (404, "Not found"))
        return status, "", "", body
    return get, seen


def run(tmp_path, monkeypatch, get, hq_key=""):
    assert new_town.main([*BAY, "--towns-dir", str(tmp_path)]) == 0
    if hq_key:
        monkeypatch.setenv("HQ_API_KEY", hq_key)
    else:
        monkeypatch.delenv("HQ_API_KEY", raising=False)
    return launch_check.main(["--town", "bay", "--towns-dir", str(tmp_path)], get=get)


def test_a_ready_town_passes(tmp_path, monkeypatch, capsys):
    get, seen = fake_site()
    assert run(tmp_path, monkeypatch, get, hq_key="k" * 20) == 0
    out = capsys.readouterr().out
    assert "All automatic checks passed." in out and "❌" not in out
    assert "delivered@resend.dev" in out
    assert ("/api/hq/summary", "Bearer " + "k" * 20) in seen
    assert all(auth is None for path, auth in seen if path != "/api/hq/summary")   # the key goes only to HQ


def test_a_copy_of_victoria_fails(tmp_path, monkeypatch, capsys):
    get, _ = fake_site(**{
        "/api/health?deep=1": (200, json.dumps({"ok": True, "storage": "file"})),
        "/api/config": (200, json.dumps({"town": {"id": "victoria", "domain": "thevic361.com"}, "github_events_path": "docs/events.json"})),
        "/about": (200, "About The Vic 361, Victoria, TX"),
        "/": (200, '<script src="https://www.googletagmanager.com/gtag/js?id=G-52YHD3X3C2"></script>'),
        "/robots.txt": (200, "Sitemap: https://www.thevic361.com/sitemap.xml"),
        "/events.json": (500, "oops"),
    })
    assert run(tmp_path, monkeypatch, get) == 1
    out = capsys.readouterr().out
    for line in ["❌ runs on its own Postgres (storage: file)", "❌ runs as TOWN=bay (says 'victoria')",
                 "❌ /about answers without Victoria's name (found The Vic 361, Vic 361, Victoria, TX)",
                 "❌ / answers without Victoria's name (found G-52YHD3X3C2)", "❌ robots.txt points at its own sitemap",
                 "❌ /events.json answers (HTTP 500)", "(HQ feed not checked"]:
        assert line in out, line


def test_refuses_victoria_and_an_unknown_town(tmp_path, capsys):
    assert launch_check.main(["--town", "victoria"], get=lambda *a, **k: None) == 2
    assert launch_check.main(["--town", "nope", "--towns-dir", str(tmp_path)], get=lambda *a, **k: None) == 2
    assert "Can't read the town" in capsys.readouterr().err
