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
  timezone: 'America/Chicago'
});

const REQUIRED = ['siteName', 'domain', 'city', 'state', 'stateName', 'timezone'];
const SAFE_TEXT = /^[^<>&"]+$/;

// A town from its own settings plus what follows from them (never from
// Victoria's: a forgotten field must not show Victoria's domain or GA ID).
function complete(id, raw) {
  const missing = REQUIRED.filter(k => !raw[k]);
  if (missing.length) throw new Error(`TOWN=${id}: town.json is missing ${missing.join(', ')}`);
  const domain = String(raw.domain);
  return {
    siteNameHtml: raw.siteName,
    siteUrl: `https://www.${domain}`,
    emailFrom: `${raw.siteName} <news@${domain}>`,
    gaId: '',
    icalDomain: domain,
    cityState: `${raw.city}, ${raw.state}`,
    cityStateLong: `${raw.city}, ${raw.stateName}`,
    ...raw,
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
  for (const k of ['siteName', 'city', 'state', 'stateName', 'cityState', 'cityStateLong']) {
    if (!SAFE_TEXT.test(String(t[k] || ''))) throw new Error(`TOWN=${t.id}: ${k} can't be empty or contain < > & "`);
  }
  for (const k of ['domain', 'icalDomain']) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(String(t[k]))) throw new Error(`TOWN=${t.id}: ${k} "${t[k]}" doesn't look like a domain`);
  }
  if (!/^[^<>&"]+ <[^<>&"\s@]+@[a-z0-9.-]+>$/.test(String(t.emailFrom))) throw new Error(`TOWN=${t.id}: emailFrom must look like Name <news@domain>`);
  if (!/^https:\/\/[a-z0-9.-]+$/.test(t.siteUrl)) throw new Error(`TOWN=${t.id}: siteUrl must be https://host with no path`);
  if (t.gaId && !/^G-[A-Z0-9]+$/.test(t.gaId)) throw new Error(`TOWN=${t.id}: gaId must look like G-XXXXXXX`);
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

export function useTown(t) {
  town = t || VICTORIA;
  return town;
}
