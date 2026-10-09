/* server/scoring.js — Which events make each day's list.
 *
 * A busy Saturday can collect 25–30 events, and a list that long buries the
 * good ones. So each day shows its best DAY_MAX events (15 Mon–Thu, 20
 * Fri–Sun); the rest are marked `overflow` and left out of the day lists
 * (homepage, /today, /this-weekend, /next-week, /events.json, newsletter,
 * social kit) but keep their own page and stay in the guides (Halloween,
 * kids, venues...), which have no daily limit. Site lists stay in time order
 * (sortEvents), Vic's Picks included (the social kit still leads with picks);
 * the score only decides what's in.
 *
 * Always in, whatever the score: Vic's Picks / sponsored (`featured`) and
 * anything the admin chose to show anyway (`keep`, set from the admin).
 *
 * The score (0–100) favors what most people in Victoria would plan around:
 * big one-time draws, broad appeal, things several sources listed, complete
 * details. Routine weekly repeats, club meetings, classes and store promos
 * score low. Signals come from the collector (appeal from the AI review,
 * recurring, sources, big, favorite, curated) and from the event itself; an
 * event without them (a submission, one added in the admin) gets neutral
 * values, so nothing is dropped just for lacking data.
 */

import { town } from './town.js';
import { venueFor } from './guides.js';

// Per day, from the town (town.business), read when used.
export const DAY_MAX = { get weekday() { return town.business.dayMax.weekday; }, get weekend() { return town.business.dayMax.weekend; } };
// Variety: a day of 12 trunk-or-treats, or one venue's whole lineup, crowds
// out everything else. Past these, an event needs VARIETY_OVERRIDE to get
// in ahead of something different; leftover room is filled by score after.
const PER_VENUE = 2;
const PER_KIND = 3;
const VARIETY_OVERRIDE = 80;

const BIG_DRAW = /\b(festival|fest|parade|concert|fair|carnival|rodeo|tree lighting|fireworks|gala|symphony|spooktacular|bash|celebration|zoo boo|malloween)\b/i;
const NICHE = /\b(club|meeting|chess|writers?|book club|support group|bingo|orientation|class|lesson|workshop|seminar|training|bible|prayer|toddler|storytime|story time|study|webinar|registration)\b/i;
const PROMO = /\b(kids eat free|eat free|happy hour|special|deal|discount|sale|% off|giveaway|candy at|kids craft|kids workshop)\b|\b(lowe'?s|home depot|jcpenney|mccoy'?s)\b/i;
// Similar events that shouldn't fill a day on their own.
const KINDS = [
  ['trunk-or-treat', /trunk[\s-]*(or|n)[\s-]*treat|trick[\s-]*or[\s-]*treat/i],
  ['karaoke', /karaoke/i],
  ['bingo', /bingo/i],
  ['trivia', /trivia/i],
  ['kids-craft', /kids?\s+(craft|workshop)/i],
  ['run', /\b(5k|10k|fun run|half marathon)\b/i]
];

function kindOf(ev) {
  const text = `${ev.name || ''}`;
  const hit = KINDS.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}

const clamp = n => Math.max(0, Math.min(100, Math.round(n)));

// One event's score. `venues` (buildVenues in guides.js) lets popular places
// (tier HIGH) count; it's optional.
export function scoreEvent(ev, { venues = [] } = {}) {
  let s = 50;
  const parts = [];
  const add = (n, why) => { if (n) { s += n; parts.push(`${n > 0 ? '+' : ''}${n} ${why}`); } };

  const appeal = Number(ev.appeal);
  if (appeal >= 1 && appeal <= 5) add((appeal - 3) * 10, `appeal ${appeal}`);
  if (ev.big === true) add(25, 'big event');
  else if (BIG_DRAW.test(ev.name || '')) add(10, 'festival/concert/parade');

  if (ev.recurring === true) {
    if (ev.favorite === true) add(6, 'weekly favorite');
    else add(-12, 'weekly repeat');
  }
  // Name only: a description saying "hosted by The 1824 Club" or "kids eat
  // free with a ticket" isn't a club meeting or a promo.
  if (NICHE.test(ev.name || '') && ev.big !== true) add(-12, 'niche or small group');
  if (PROMO.test(ev.name || '') && ev.big !== true) add(-10, 'store promo or deal');

  const icons = ev.icons || [];
  if (icons.includes('family')) add(4, 'family');
  if (ev.free === true || icons.includes('free')) add(4, 'free');

  if (!ev.time) add(-8, 'no time');
  if (!ev.venue && !ev.address) add(-8, 'no place');
  if (String(ev.description || '').trim().length < 40) add(-4, 'thin description');
  if (ev.url) add(3, 'has a link');

  const sources = Number(ev.sources) || 1;
  if (sources > 1) add(Math.min(12, 6 + (sources - 2) * 3), `${sources} sources`);
  if (ev.curated === true && ev.recurring !== true) add(8, 'hand-added');
  if (ev.submitted === true) add(8, 'submitted');

  const venue = venues.length ? venueFor(ev, venues) : null;
  if (venue && String(venue.tier || '').toUpperCase() === 'HIGH') add(5, 'popular venue');
  if (ev.town && ev.big !== true) add(-10, 'nearby town');

  return { score: clamp(s), why: parts };
}

function isWeekend(date) {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 5 || d === 6;
}

export function dayMax(date) {
  return isWeekend(date) ? DAY_MAX.weekend : DAY_MAX.weekday;
}

const nameKey = ev => String(ev.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const venueKey = ev => String(ev.venue || ev.address || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Marks each event with `score`, and `overflow: true` on the ones that don't
// make their day's list. Returns new objects; the input isn't changed.
export function capDays(events, { venues = [] } = {}) {
  const out = (events || []).map(ev => {
    const { overflow: _o, ...rest } = ev;
    return { ...rest, score: scoreEvent(ev, { venues }).score };
  });
  const byDay = new Map();
  for (const ev of out) {
    if (!byDay.has(ev.date)) byDay.set(ev.date, []);
    byDay.get(ev.date).push(ev);
  }
  for (const [date, list] of byDay) {
    const max = dayMax(date);
    if (list.length <= max) continue;
    const pinned = list.filter(ev => ev.featured || ev.keep === true);
    const rest = list.filter(ev => !(ev.featured || ev.keep === true))
      .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
    const chosen = new Set(pinned);
    const perVenue = new Map(), perKind = new Map();
    for (const ev of pinned) {
      perVenue.set(venueKey(ev), (perVenue.get(venueKey(ev)) || 0) + 1);
      const k = kindOf(ev);
      if (k) perKind.set(k, (perKind.get(k) || 0) + 1);
    }
    // First pass: best first, with variety limits.
    for (const ev of rest) {
      if (chosen.size >= max) break;
      const v = venueKey(ev), k = kindOf(ev);
      const crowded = (v && (perVenue.get(v) || 0) >= PER_VENUE) || (k && (perKind.get(k) || 0) >= PER_KIND);
      if (crowded && ev.score < VARIETY_OVERRIDE) continue;
      chosen.add(ev);
      if (v) perVenue.set(v, (perVenue.get(v) || 0) + 1);
      if (k) perKind.set(k, (perKind.get(k) || 0) + 1);
    }
    // Room left (not enough variety to fill it): best of the rest.
    for (const ev of rest) {
      if (chosen.size >= max) break;
      chosen.add(ev);
    }
    for (const ev of list) if (!chosen.has(ev)) ev.overflow = true;
  }
  return out;
}

// The events a day list shows.
export const shown = events => (events || []).filter(ev => !ev.overflow);

// Editor's picks. With few paid Vic's Picks, a day's can't-miss events get
// the badge on merit: up to PICKS.weekday (Mon–Thu) / PICKS.weekend (Fri–Sun)
// per day, counting paid picks first, so a paid one takes an editor's spot
// (and paid capacity is counted from orders in server/sponsors.js, never
// from these). An event needs PICK_SCORE to be picked; a day with no event
// that strong still gets PICKS_MIN of its best if they reach PICK_FLOOR.
// Marked `featured` (the badge and highlight, starred in the newsletter
// and social posts) plus `editor_pick`, which keeps them out of "Coming
// up" and the paid wording in llms.txt, and off anything stored: computed
// on read like the score.
export const PICKS = { get weekday() { return town.business.picks.weekday; }, get weekend() { return town.business.picks.weekend; } };
export const PICKS_MIN = { get weekday() { return town.business.picksMin.weekday; }, get weekend() { return town.business.picksMin.weekend; } };
const PICK_SCORE = 70;
const PICK_FLOOR = 65;
// Picks are one-time Victoria events: a weekly favorite (corn maze, the
// farmers market) would be a "pick" every week, a nearby-town festival
// isn't a Victoria can't-miss, and a multi-day event is picked once, on
// its first day.
const pickable = ev => !ev.featured && ev.recurring !== true && !ev.town;

export function pickDays(events) {
  const out = (events || []).map(ev => {
    if (!ev.editor_pick) return ev;
    const { editor_pick: _p, featured: _f, ...rest } = ev; // recomputed below
    return rest;
  });
  const byDay = new Map();
  for (const ev of out) {
    if (ev.overflow) continue;
    if (!byDay.has(ev.date)) byDay.set(ev.date, []);
    byDay.get(ev.date).push(ev);
  }
  const pickedNames = new Set();
  for (const date of [...byDay.keys()].sort()) {
    const list = byDay.get(date);
    const weekend = isWeekend(date);
    const quota = weekend ? PICKS.weekend : PICKS.weekday;
    const min = weekend ? PICKS_MIN.weekend : PICKS_MIN.weekday;
    const paid = list.filter(ev => ev.featured);
    let count = paid.length;
    const venues = new Set(paid.map(venueKey).filter(Boolean));
    const pool = list.filter(ev => pickable(ev) && !pickedNames.has(nameKey(ev)))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const take = (ev) => {
      ev.featured = true;
      ev.editor_pick = true;
      pickedNames.add(nameKey(ev));
      count++;
      const v = venueKey(ev);
      if (v) venues.add(v);
    };
    for (const ev of pool) {
      if (count >= quota || (ev.score || 0) < PICK_SCORE) break;
      if (venueKey(ev) && venues.has(venueKey(ev))) continue;
      take(ev);
    }
    for (const ev of pool) {
      if (count >= min || (ev.score || 0) < PICK_FLOOR) break;
      if (ev.editor_pick || (venueKey(ev) && venues.has(venueKey(ev)))) continue;
      take(ev);
    }
  }
  return out;
}
