/* server/town.js — Which town this site is (MULTI_CITY_PLAN.md, Phase 1).
 *
 * Each town runs as its own Railway service with its own database, so the
 * town is chosen once per process: TOWN (Railway variable) names it, and
 * unset or "victoria" is The Vic 361 with exactly today's values. Any other
 * town reads towns/<slug>/town.json; a missing file or field stops the boot
 * rather than quietly showing Victoria's name on another town's site.
 *
 * Renderers read `town` at call time (town.siteName, town.domain, …), so
 * createApp({ town }) or useTown() switches every page and email at once.
 * Fields arrive with the step that moves their literals (plan 1.2a–g).
 *
 * Names and domains go into pages and attributes as they are, so they're
 * checked here: no <, >, & or ", and the GA ID is G-XXXX or empty.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VICTORIA = Object.freeze({
  id: 'victoria',
  // Identity
  siteName: 'The Vic 361',
  siteNameHtml: 'The Vic <span>361</span>',   // the header's two-tone title
  shortName: 'Vic 361',                        // "Confirm your Vic 361 subscription"
  pickName: 'Vic’s Pick',                      // the paid pick; pickNamePlain is the plain-text twin
  pickNamePlain: "Vic's Pick",
  domain: 'thevic361.com',
  siteUrl: 'https://www.thevic361.com',
  emailFrom: 'The Vic 361 <news@thevic361.com>',
  gaId: 'G-52YHD3X3C2',
  icalDomain: 'thevic361.com',
  // Geography
  city: 'Victoria',
  state: 'TX',
  stateName: 'Texas',
  cityState: 'Victoria, TX',          // place labels, footers, page text
  cityStateLong: 'Victoria, Texas',   // schema.org areaServed, about text
  // Copy only a local would write: who we gather from (about page) and the
  // area code people know the region by (llms.txt).
  localSources: 'the City of Victoria, the Victoria Public Library, the Chamber of Commerce',
  areaCode: '361',
  timezone: 'America/Chicago',
  // Money and limits. Amounts are in cents (what Stripe charges); the
  // price text on pages and emails is generated from them (dollars()).
  business: Object.freeze({
    weeklyAmount: 30000,                        // weekly sponsor
    pickAmount: { weekday: 4900, weekend: 8900 },   // a pick, Mon–Thu / Fri–Sun
    pickCap: { weekday: 3, weekend: 4 },        // picks sold per day
    dayMax: { weekday: 15, weekend: 20 },       // events the curator lists per day
    picks: { weekday: 2, weekend: 3 },          // editor's picks per day
    picksMin: { weekday: 1, weekend: 2 },
    drawingAmount: 25,                          // monthly referral drawing, dollars
    rewardCards: [{ n: 5, amount: 10 }, { n: 10, amount: 25 }],   // referral gift cards, dollars
    showSubscribersFrom: 100                    // say "N+ subscribers" only from here
  }),
  // Job start times that differ from server/scheduler.js JOBS (Central-style
  // "HH:MM" in the town's timezone). Victoria runs the defaults.
  schedule: Object.freeze({})
});

// What another town starts from when its town.json leaves a number out.
const SHARED_BUSINESS = VICTORIA.business;

const REQUIRED = ['siteName', 'domain', 'city', 'state', 'stateName', 'timezone'];
const SAFE_TEXT = /^[^<>&"]+$/;

// A town from its own settings plus what follows from them (never from
// Victoria's: a forgotten field must not show Victoria's domain or GA ID).
function complete(id, raw) {
  raw = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const missing = REQUIRED.filter(k => !raw[k]);
  if (missing.length) throw new Error(`TOWN=${id}: town.json is missing ${missing.join(', ')}`);
  const domain = String(raw.domain);
  return {
    siteNameHtml: raw.siteName,
    shortName: String(raw.siteName).replace(/^the\s+/i, ''),
    pickName: 'Local Pick',
    pickNamePlain: String(raw.pickName || 'Local Pick').replace(/[’‘]/g, "'"),
    localSources: 'the city, the library, the chamber of commerce',
    areaCode: '',
    siteUrl: `https://www.${domain}`,
    emailFrom: `${raw.siteName} <news@${domain}>`,
    gaId: '',
    icalDomain: domain,
    cityState: `${raw.city}, ${raw.state}`,
    cityStateLong: `${raw.city}, ${raw.stateName}`,
    ...raw,
    business: { ...SHARED_BUSINESS, ...(raw.business || {}) },
    schedule: { ...(raw.schedule || {}) },
    id
  };
}

function fromFile(id, dir) {
  const file = path.join(dir, id, 'town.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new Error(`TOWN=${id}: can't read ${path.relative(ROOT, file) || file} (${err.code || err.message})`);
  }
  return complete(id, raw);
}

function check(t) {
  for (const k of ['siteName', 'shortName', 'pickName', 'pickNamePlain', 'city', 'state', 'stateName', 'cityState', 'cityStateLong', 'localSources']) {
    if (!SAFE_TEXT.test(String(t[k] || ''))) throw new Error(`TOWN=${t.id}: ${k} can't be empty or contain < > & "`);
  }
  for (const k of ['domain', 'icalDomain']) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(String(t[k]))) throw new Error(`TOWN=${t.id}: ${k} "${t[k]}" doesn't look like a domain`);
  }
  if (!/^[^<>&"]+ <[^<>&"\s@]+@[a-z0-9.-]+>$/.test(String(t.emailFrom))) throw new Error(`TOWN=${t.id}: emailFrom must look like Name <news@domain>`);
  if (!/^https:\/\/[a-z0-9.-]+$/.test(t.siteUrl)) throw new Error(`TOWN=${t.id}: siteUrl must be https://host with no path`);
  if (t.areaCode && !/^\d{3}$/.test(t.areaCode)) throw new Error(`TOWN=${t.id}: areaCode must be 3 digits or empty`);
  if (t.gaId && !/^G-[A-Z0-9]+$/.test(t.gaId)) throw new Error(`TOWN=${t.id}: gaId must look like G-XXXXXXX`);
  const b = t.business || {};
  const cents = v => Number.isInteger(v) && v >= 100;
  const pair = (v, ok) => v && ok(v.weekday) && ok(v.weekend);
  const count = v => Number.isInteger(v) && v >= 0 && v <= 100;
  if (!cents(b.weeklyAmount) || !pair(b.pickAmount, cents)) throw new Error(`TOWN=${t.id}: business amounts must be whole cents, at least 100`);
  if (![b.pickCap, b.dayMax, b.picks, b.picksMin].every(v => pair(v, count))) throw new Error(`TOWN=${t.id}: business caps need weekday and weekend counts`);
  if (!Number.isInteger(b.drawingAmount) || !Array.isArray(b.rewardCards) || !Number.isInteger(b.showSubscribersFrom)) {
    throw new Error(`TOWN=${t.id}: business needs drawingAmount, rewardCards and showSubscribersFrom`);
  }
  for (const [job, at] of Object.entries(t.schedule || {})) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at))) throw new Error(`TOWN=${t.id}: schedule.${job} must be "HH:MM"`);
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: t.timezone }); } catch (_) {
    throw new Error(`TOWN=${t.id}: unknown timezone "${t.timezone}"`);
  }
  return Object.freeze(t);
}

// The town for these settings. overrides.town (a town.json-shaped object)
// wins, for tests.
export function townConfig(env = process.env, overrides = {}) {
  if (overrides.town) return check(complete(overrides.town.id || 'test', overrides.town));
  const id = String(env.TOWN || 'victoria').trim().toLowerCase();
  if (id === 'victoria') return VICTORIA;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`TOWN="${env.TOWN}" isn't a town slug (lowercase letters, digits, dashes)`);
  return check(fromFile(id, overrides.townsDir || path.join(ROOT, 'towns')));
}

// The process's town. A live binding: modules that import it see useTown's
// change, so read its fields when rendering, never copy them at load.
export let town = townConfig();

// "$49", or "$49.50" when there are cents.
export function dollars(cents) {
  return '$' + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));
}

export function useTown(t) {
  town = t || VICTORIA;
  return town;
}
