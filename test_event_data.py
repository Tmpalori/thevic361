"""Event data fixes from the 2026-10-05 review of the live site.

Fixtures are trimmed copies of the real pages (victoriatx.gov CivicPlus
calendar, theatrevictoria.org) and the listings that were live on
thevic361.com that week.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import collect_events as ce


def setup_module(_):
    ce._WINDOW_START = datetime.date(2026, 10, 5)
    ce._WINDOW_END = datetime.date(2026, 10, 18)


def ev(name, date="2026-10-08", venue="", address="", source=None, **kw):
    e = {"date": date, "name": name, "venue": venue, "address": address,
         "time": kw.pop("time", ""), "description": kw.pop("description", ""),
         "url": kw.pop("url", ""), "icons": kw.pop("icons", []), "free": kw.pop("free", False)}
    if source:
        e["_source"] = source
    e.update(kw)
    return e


class Resp:
    def __init__(self, text="", status_code=200, url=None):
        self.text, self.status_code, self.url = text, status_code, url

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


# ─── City calendar (CivicPlus) ────────────────────────────────────────────

CITY_DETAIL = """<html><head><title>Calendar • {short}</title></head><body>
<div class="detailsBody selfClear"><div class="detailSpecifics">
 <div class="specificDetail"><div class="specificDetailHeader">Date:</div>
  <div class="specificDetailItem">October&nbsp;13,&nbsp;2026</div>
  <div itemprop="startDate" class="hidden">2026-10-13T17:30:00</div></div>
 <div class="specificDetail"><div class="specificDetailHeader">Time:</div>
  <div class="specificDetailItem">5:30 PM&thinsp;-&thinsp;6:30 PM</div></div>
 <div itemprop="location" class="fr-view"><div class="specificDetail">
  <div class="specificDetailHeader">Location:</div><div class="specificDetailItem">
  <a class="button" href="/Facilities/Facility/Details/Victoria-Public-Library-33"><span>View Facility</span></a>
  <div itemprop="name">Victoria Public Library</div></div></div>
 <div class="specificDetail"><div class="specificDetailHeader">Address:</div><div class="specificDetailItem">
  <span itemprop="streetAddress">302 N. Main Street</span><br/><span>Victoria</span>, <span>TX</span> <span>77901</span>
 </div></div></div></div>
<div id="divDetailTitle" class="detailTitle"><span itemprop="name">
<h2 id="ctl00_ctl00_MainContent_ModuleContent_ctl00_ctl04_eventTitle">{full}</h2></span>
<div class="detailDateDesc"><h3>Tuesday, October 13, 2026</h3></div></div>
<div itemprop="description" class="fr-view"><p>Cooking Well Exploring Cultures is a four-lesson series on nutrition and healthy cooking.</p></div>
</div></body></html>"""

FULL = "Healthy South Texas Cooking Well Exploring Cultures"
SHORT = "Healthy South Texas Cooking Well Exploring Cultur"   # CivicPlus cuts <title> at ~50
EIDS = list(range(3948, 3991))   # 43 listings, as many as the live month view (3909-3990)


def _city_get(fetched):
    month = "".join(f'<a href="/Calendar.aspx?EID={e}">x</a>' for e in EIDS)

    def get(url, headers=None, timeout=None):
        if url.endswith("Calendar.aspx"):
            return Resp(month)
        eid = int(url.rsplit("=", 1)[1])
        fetched.append(eid)
        if eid == 3974:
            return Resp(CITY_DETAIL.format(short=SHORT, full=FULL))
        return Resp("<html><title>Calendar • Old</title><body>Date: March 1, 2026</body></html>")
    return get


def test_city_calendar_uses_the_full_heading_not_the_cut_title(monkeypatch):
    fetched = []
    monkeypatch.setattr(ce.requests, "get", _city_get(fetched))
    out = ce.fetch_city_calendar(14)
    assert [e["name"] for e in out] == [FULL]
    assert out[0]["time"] == "5:30 PM – 6:30 PM" and out[0]["date"] == "2026-10-13"
    assert out[0]["url"].endswith("EID=3974")
    assert out[0]["description"].startswith("Cooking Well Exploring Cultures is a four-lesson series")


def test_city_calendar_fetches_every_listing_newest_first(monkeypatch):
    fetched = []
    monkeypatch.setattr(ce.requests, "get", _city_get(fetched))
    ce.reset_source_stats()
    ce.safe_fetch("city_calendar", ce.fetch_city_calendar, args=(14,))
    # sorted(eids)[:30] used to stop at 3967 and never see 3986 Wags-O-Ween.
    assert sorted(fetched) == sorted(EIDS) and fetched[0] == 3990
    assert "message" not in ce.get_source_stats()[0]

    # If the cap ever bites, the oldest are skipped and it says so.
    fetched.clear()
    monkeypatch.setattr(ce, "CITY_CALENDAR_MAX_PAGES", 5)
    ce.reset_source_stats()
    ce.safe_fetch("city_calendar", ce.fetch_city_calendar, args=(14,))
    assert fetched == sorted(EIDS, reverse=True)[:5]
    assert "38 skipped" in ce.get_source_stats()[0]["message"]


def test_city_calendar_falls_back_to_the_title_without_a_heading(monkeypatch):
    page = CITY_DETAIL.format(short="Wags-O-Ween", full="").replace(
        '<h2 id="ctl00_ctl00_MainContent_ModuleContent_ctl00_ctl04_eventTitle"></h2>', "")

    def get(url, headers=None, timeout=None):
        return Resp('<a href="/Calendar.aspx?EID=3986">x</a>' if url.endswith("Calendar.aspx") else page)
    monkeypatch.setattr(ce.requests, "get", get)
    assert [e["name"] for e in ce.fetch_city_calendar(14)] == ["Wags-O-Ween"]


# ─── Theatre Victoria ─────────────────────────────────────────────────────

# theatrevictoria.org home page, Oct 2026 (season cards trimmed to three).
THEATRE_HOME = """<html><body>
<div id="sidebar1"><p>Box Office Hours<br />Thursday-Friday<br />Noon- 5:30 p.m.<br /></p>
<p><a href="/images/SeatingChart.gif">Welder Center<br />Seating Chart</a></p>
<p><a href="https://lp.constantcontactpages.com/su/x">Are you On Cue?<br />Sign up for our<br />newsletter</a></p></div>
<div id="maincontent">
 <div class="divpad"><a href="season/2027season/2027season.htm"><img src="images/season27/heb1.png" alt="Thank you to HEB for their support"/></a></div>
 <div id="halfleft"><a href="/season/2027season/nemo.htm"><img src="/images/Season27/nemo375.png" alt="Finding Nemo Jr."/></a>
  <p class="center"><a href="https://www.etix.com/ticket/c/x/tv-finding-nemo-jr"><img src="images/ticketsred.png" alt="Buy Tickets"/></a></p>
  <p class="showtitle">October 8-10, 2026</p>
  <p class="center"><img src="images/season27/VFAA.png" alt=""/><br />Thank you to Victoria Fine Arts Association<br />
  Directed by Michael Teer<br />Theatre Victoria Youth Production</p></div>
 <div id="halfright2"><a href="/ season/2027season/littleshop.htm"><img src="/images/Season27/littleshop375.png" alt="Little Shop of Horrors"/></a>
  <p class="showtitle">October 15-18, 2026</p>
  <p class="center">Book By Howard Ashman<br>Music By Alan Menken<br>Lyrics By Howard Ashman</p></div>
 <div id="halfright3"><a href="season/2027season/frozen.htm"><img src="images/season27/frozen375.png" alt="Disney Frozen"/></a>
  <p class="showtitle">July 23-25, July 29-August 1, 2027</p>
  <p class="center">Music and Lyrics by<br />Kristen Anderson-Lopez,<br />Robert Lopez<br />Book by<br />Jennifer Lee</p></div>
</div>
<div id="footer"><p>Theatre Victoria<br />Leo J. Welder Center for the Performing Arts<br />214 N. Main Street Victoria, TX 77901</p></div>
</body></html>"""


def test_theatre_victoria_takes_the_show_name_from_the_poster():
    out = ce.parse_theatre_victoria(THEATRE_HOME, datetime.date(2026, 10, 5), datetime.date(2026, 10, 18))
    assert [(e["date"], e["name"]) for e in out] == [
        ("2026-10-08", "Finding Nemo Jr."), ("2026-10-09", "Finding Nemo Jr."), ("2026-10-10", "Finding Nemo Jr."),
        ("2026-10-15", "Little Shop of Horrors"), ("2026-10-16", "Little Shop of Horrors"),
        ("2026-10-17", "Little Shop of Horrors"), ("2026-10-18", "Little Shop of Horrors")]
    nemo = out[0]
    assert nemo["venue"] == "Leo J. Welder Center for the Performing Arts" and nemo["address"] == "214 N. Main St."
    assert "Constitution" not in str(out)
    assert nemo["url"] == "https://theatrevictoria.org/season/2027season/nemo.htm"
    assert out[3]["url"] == "https://theatrevictoria.org/season/2027season/littleshop.htm"
    # No curtain time on the site: Sunday (a matinee) isn't given 7:30 PM.
    assert [e["time"] for e in out[3:]] == ["7:30 PM", "7:30 PM", "7:30 PM", ""]
    assert not any("lyrics" in e["name"].lower() or " by " in e["name"].lower() for e in out)


def test_theatre_victoria_reads_split_date_runs():
    assert ce._tv_dates("February 12-14, 18-21, 2027")[3:5] == [datetime.date(2027, 2, 18), datetime.date(2027, 2, 19)]
    assert len(ce._tv_dates("July 23-25, July 29-August 1, 2027")) == 7
    assert ce._tv_dates("October 8-10, 2026") == [datetime.date(2026, 10, d) for d in (8, 9, 10)]


def test_theatre_victoria_text_fallback_skips_credit_lines():
    # Without posters, the nearest clean line above the date wins, never a
    # credit line ("Music and Lyrics by ..." was live Oct 8-10 as a show).
    page = """<div><p>Sign up for our newsletter</p><h3>Finding Nemo Jr.</h3>
      <p>Music and Lyrics by</p><p>Kristen Anderson-Lopez</p><p>Book Adapted by</p><p>Lindsay Anderson</p>
      <p>October 8-10, 2026</p></div>"""
    out = ce.parse_theatre_victoria(page, datetime.date(2026, 10, 5), datetime.date(2026, 10, 18))
    assert {e["name"] for e in out} == {"Finding Nemo Jr."}


def test_theatre_listing_merges_with_the_social_posts_of_the_same_show():
    # Oct 8 had three listings for one show.
    out = ce.merge_events([
        ev("Finding Nemo Jr.", venue="Leo J. Welder Center for the Performing Arts", address="214 N. Main St.",
           time="7:30 PM", source="theatre_victoria", url="https://theatrevictoria.org/season/2027season/nemo.htm"),
        ev("Disney’s Finding Nemo JR.", venue="Theatre Victoria", source="apify_facebook_posts",
           url="https://www.facebook.com/TheatreVictoria/posts/x"),
        ev("Theatre Victoria: FINDING NEMO JR.", venue="Leo J. Welder Center for the Performing Arts",
           source="apify_facebook_posts", url="https://www.facebook.com/discovervictoriatexas/posts/y"),
    ], venues=[])
    assert len(out) == 1
    assert out[0]["name"] == "Finding Nemo Jr." and out[0]["time"] == "7:30 PM"


# ─── Dedupe (live duplicates, Oct 2026) ──────────────────────────────────

def test_organiser_prefix_and_city_suffix_duplicates_merge():
    a = ev("MOWSTX Mahjong for Meals", date="2026-10-17", venue="306 E Commercial St",
           address="306 E Commercial St", time="10:00 AM", source="allevents")
    b = ev("Mahjong for Meals- Victoria, TX", date="2026-10-17", venue="306 E Commercial St",
           address="306 E Commercial St", time="10:00 AM", source="apify_facebook")
    assert ce.is_same_event(a, b)
    assert len(ce.merge_events([a, b], venues=[])) == 1
    nave_a = ev("The Nave Museum: 'i want to talk about you--stella alesi'", date="2026-10-09",
                venue="The Nave Museum", source="gemini_search")
    nave_b = ev("I want to talk about you — the art of stella alesi (exhibit opening)", date="2026-10-09",
                venue="The Nave Museum", source="apify_facebook_posts")
    assert ce.is_same_event(nave_a, nave_b)
    # Gemini's lowercase paraphrase doesn't replace the post's name.
    assert ce.merge_events([nave_a, nave_b], venues=[])[0]["name"].startswith("I want to talk about you")
    # The live check's own pair (street address as the venue on both).
    assert ce.is_same_event(ev("Disney’s Finding Nemo JR.", venue="Theatre Victoria"),
                            ev("Theatre Victoria: FINDING NEMO JR.", venue="Leo J. Welder Center for the Performing Arts"))


def test_generic_names_at_different_places_stay_apart():
    for x, y in [(("Live Music", "Moonshine Drinkery"), ("Live Music", "Aero Crafters")),
                 (("Karaoke Night", "Shooters"), ("Karaoke", "La Cantina")),
                 (("Bingo", "Palace Bingo"), ("Bingo Night", "VFW Post 4146")),
                 (("Sunday Brunch", "J Welch Farms"), ("Brunch", "Pumphouse"))]:
        assert not ce.is_same_event(ev(x[0], venue=x[1]), ev(y[0], venue=y[1])), (x, y)
    # A street-only listing at another address is another place.
    assert not ce.is_same_event(ev("Live Music", address="402 E North St"),
                                ev("Live Music", venue="Aero Crafters", address="309 E Crestwood Dr"))
    # Two words left over is the minimum: "Mahjong" alone isn't enough.
    assert not ce.is_same_event(ev("Mahjong", venue="Vida Cafe"), ev("Mahjong Open Play @ Vida Cafe", venue="Nave"))


def test_merge_keeps_the_whole_name_over_a_cut_off_one():
    # Live 10-15 showed the city calendar's 49-character cut.
    out = ce.merge_events([
        ev("Sugar Skull Embroidery with Quilt Guild of Greater Victoria", venue="Victoria Public Library",
           address="302 N. Main St.", time="5:30PM – 6:30PM", source="library"),
        ev("Sugar Skull Embroidery with Quilt Guild of Greate", venue="Victoria Public Library",
           address="302 N. Main Street", time="5:30 PM – 6:30 PM", source="city_calendar"),
    ], venues=[])
    assert [e["name"] for e in out] == ["Sugar Skull Embroidery with Quilt Guild of Greater Victoria"]
    out = ce.merge_events([
        ev("Healthy South Texas - Cooking Well Exploring Cult", venue="Victoria Public Library", source="city_calendar"),
        ev("Healthy South Texas Cooking Well Exploring Cultures", venue="Victoria Public Library", source="library"),
    ], venues=[])
    assert [e["name"] for e in out] == ["Healthy South Texas Cooking Well Exploring Cultures"]
    # A whole-word shorter name is still the clean one.
    out = ce.merge_events([ev("Tejas Fest 2026 - Presented by H-E-B", source="allevents"),
                           ev("Tejas Fest", source="library")], venues=[])
    assert [e["name"] for e in out] == ["Tejas Fest"]
    assert "_name_from" not in out[0]


def test_library_and_city_calendar_copies_merge_whatever_the_time_spacing():
    # Live 10-06 / 10-07: the library's "6:00PM" vs the city's "6:00 PM".
    for name, place, addr, t1, t2 in [
            ("Bookish Society Book Club", "Vida Cafe", "105 Spring Green Blvd", "6:00PM – 7:00PM", "6:00 PM – 7:00 PM"),
            ("Pickleball Games", "Youth Sports Complex", "107 N Ben Wilson", "6:00PM – 7:30PM", "6:00 PM – 7:30 PM")]:
        lib = ev(name, venue="Victoria Public Library", address="302 N. Main St.", time=t1, source="library",
                 _venue_guess=True)
        city = ev(name, venue=place, address=addr, time=t2, source="city_calendar")
        out = ce.merge_events([dict(city), dict(lib)], venues=[])
        assert [(e["name"], e["venue"]) for e in out] == [(name, place)]


# ─── Religious filter false positives ────────────────────────────────────

def test_secular_uses_of_religious_words_pass():
    for e in [ev("Creedence Clearwater Revival Tribute"), ev("Critical Mass Bike Ride"),
              ev("Downtown Revival Market"), ev("Rosary Lane Car Show"),
              ev("Live Music", description="Come hear Hope Revival play country hits"),
              ev("Halloween Bash", description="Pray for good weather!"),
              ev("Blood Drive", venue="Methodist Hospital"),
              ev("Pancake Breakfast", description="Benefiting a Catholic school's band program."),
              ev("Gala", description="Proceeds go to Catholic Charities."),
              ev("5K Fun Run", description="Hosted by Baptist Health.")]:
        assert ce.non_event_reason(e) is None, e["name"]
    for e in [ev("Fall Revival"), ev("Sunday Mass"), ev("Rosary"), ev("Praise Night"),
              ev("Community Night", description="A worship service with praise and worship."),
              ev("Potluck", venue="First Baptist Church"), ev("Bible Study")]:
        assert ce.non_event_reason(e), e["name"]


# ─── Icons and times ──────────────────────────────────────────────────────

def test_adult_trainings_are_not_kid_friendly():
    assert "family" not in ce.classify_icons("Youth Mental Health First Aid Training Course",
                                             "An 8-hour course for adults who work with youth.")
    assert "family" not in ce.classify_icons("The ABC’s of Behavior: A Parent Seminar", "For parents of young children.")
    assert "family" in ce.classify_icons("Kids Cooking Course", "For children 6-12.")
    assert "family" in ce.classify_icons("Teen Lego Night")
    # Icons a source already set are cleaned at merge too.
    out = ce.merge_events([ev("Youth Mental Health First Aid Training Course", icons=["family", "community"],
                              time="08:00 AM", source="allevents")], venues=[])
    assert out[0]["icons"] == ["community"]


def test_night_events_listed_in_the_morning_lose_the_wrong_time():
    out = ce.merge_events([
        ev("Comedy Night in Victoria w/Crux Crawford", date="2026-10-07", venue="Moonshine Drinkery",
           time="10:00 AM", source="allevents"),
        ev("Karaoke Brunch", date="2026-10-07", venue="Pumphouse", time="10:00 AM", source="allevents"),
        ev("Comedy Night", date="2026-10-07", venue="La Cantina", time="9:00 PM", source="allevents"),
    ], venues=[])
    times = {e["name"]: e["time"] for e in out}
    assert times == {"Comedy Night in Victoria w/Crux Crawford": "", "Karaoke Brunch": "10:00 AM",
                     "Comedy Night": "9:00 PM"}
    # The event check's softer report-only rule.
    assert ce.evening_venue_morning_reason(ev("Live Band Karaoke", time="10:00 AM"))
    assert ce.evening_venue_morning_reason(ev("Sunday Brunch", venue="Moonshine Drinkery", time="10:00 AM")) is None
    assert ce.evening_venue_morning_reason(ev("Paint Night", venue="Moonshine Drinkery", time="9:00 AM"))
    assert ce.evening_venue_morning_reason(ev("Farmers Market", venue="Market Square", time="8:00 AM")) is None
    assert ce.evening_venue_morning_reason(ev("Comedy Show", time="7:00 PM")) is None


# ─── Gemini links ─────────────────────────────────────────────────────────

def _gemini_reply(items, hosts):
    import json as _json

    class R:
        status_code = 200
        text = ""

        def json(self):
            return {"candidates": [{
                "content": {"parts": [{"text": _json.dumps(items)}]},
                "groundingMetadata": {"groundingChunks": [{"web": {"title": h}} for h in hosts]},
            }]}
    return R()


def test_gemini_links_on_cited_sites_are_checked(monkeypatch):
    from datetime import timedelta
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    today = ce.now_central().date()
    monkeypatch.setattr(ce, "_WINDOW_START", today)
    monkeypatch.setattr(ce, "_WINDOW_END", today + timedelta(days=14))
    d = (today + timedelta(days=3)).isoformat()
    made_up = "https://www.victoriatx.gov/Calendar.aspx?EID=12089&view=detail"
    items = [
        # A made-up deep link: the city redirects it to the calendar home.
        {"name": "Wags-O-Ween", "date": d, "venue": "Riverside Bark", "url": made_up},
        # A department page that doesn't mention the event.
        {"name": "Citizens Run Against Cancer", "date": d, "venue": "Riverside Park",
         "url": "https://www.victoriatx.gov/1330/Parks-Recreation"},
        # A search page.
        {"name": "Fall Baseball League", "date": d, "venue": "Youth Complex",
         "url": "https://www.perfectgame.org/Events/Default.aspx?city=Victoria&state=TX"},
        # The real thing.
        {"name": "Stroller Barre", "date": d, "venue": "Ethel Lee Tracy Park",
         "url": "https://www.victoriatx.gov/Calendar.aspx?EID=3988"},
        # Facebook answers bots with a login page: an event's own page is
        # trusted as before.
        {"name": "Band Night", "date": d, "venue": "Bar", "url": "https://www.facebook.com/events/123/"},
        # ...but a bare page root confirms nothing (The Hideaway, Oct 2026).
        {"name": "Weekly Karaoke", "date": d, "venue": "The Hideaway Bar",
         "url": "https://www.facebook.com/TheHideawayVictoriaTX"},
        # A post is the venue announcing it: kept.
        {"name": "Trivia Night", "date": d, "venue": "Bar",
         "url": "https://www.facebook.com/somebar/posts/pfbid0abc"},
        # A bot block can't tell us anything: kept.
        {"name": "Pumpkin Patch", "date": d, "venue": "Farm", "url": "https://www.eventbrite.com/e/pumpkin-123"},
    ]
    pages = {
        made_up: Resp("<li>Wags-O-Ween</li><li>Stroller Barre</li>", url="https://www.victoriatx.gov/Calendar.aspx"),
        "https://www.victoriatx.gov/1330/Parks-Recreation": Resp("Parks and Recreation programs"),
        "https://www.victoriatx.gov/Calendar.aspx?EID=3988": Resp("<h2>Stroller Barre</h2>"),
        "https://www.eventbrite.com/e/pumpkin-123": Resp("", status_code=403),
    }
    seen = []

    def get(url):
        seen.append(url)
        return pages[url]
    out = ce.fetch_gemini_events(14, post=lambda *a, **k: _gemini_reply(
        items, ("victoriatx.gov", "facebook.com", "eventbrite.com", "perfectgame.org")),
        categories=["x"], get=get, workers=1)
    links = {e["name"]: e["url"] for e in out}
    # A failed link was the event's only evidence: the event goes too (it
    # used to stay up with no link).
    assert links == {"Stroller Barre": "https://www.victoriatx.gov/Calendar.aspx?EID=3988",
                     "Band Night": "https://www.facebook.com/events/123/",
                     "Trivia Night": "https://www.facebook.com/somebar/posts/pfbid0abc",
                     "Pumpkin Patch": "https://www.eventbrite.com/e/pumpkin-123"}
    assert not any("facebook.com" in u for u in seen)


def test_social_event_urls_vs_page_roots():
    for u in ["https://www.facebook.com/events/123456/", "https://www.facebook.com/moonshinedrinkery/posts/pfbid0j8S",
              "https://www.facebook.com/permalink.php?story_fbid=1&id=2", "https://www.facebook.com/groups/38460/posts/24195/",
              "https://www.facebook.com/share/p/1AbCd/", "https://www.instagram.com/p/DeIZju3ieSu/",
              "https://www.instagram.com/reel/Cx1/"]:
        assert ce._is_social_event_url(u), u
    for u in ["https://www.facebook.com/TheHideawayVictoriaTX", "https://www.facebook.com/TheHideawayVictoriaTX/",
              "https://www.facebook.com/moonshinedrinkery/events", "https://www.instagram.com/lacantinavictoria/",
              "https://www.facebook.com/events/", ""]:
        assert not ce._is_social_event_url(u), u


def test_city_calendar_home_and_search_pages_are_listing_urls():
    for u in ["https://www.victoriatx.gov/calendar?view=detail&id=12089", "https://www.victoriatx.gov/calendar",
              "https://www.victoriatx.gov/Calendar.aspx", "https://www.victoriatx.gov/Calendar.aspx?CID=14",
              "https://www.perfectgame.org/Events/Default.aspx?sort=startdate&city=Victoria&state=TX"]:
        assert ce.is_listing_url(u), u
    assert not ce.is_listing_url("https://www.victoriatx.gov/Calendar.aspx?EID=3974")
