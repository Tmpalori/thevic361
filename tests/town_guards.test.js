// @vitest-environment node
//
// MULTI_CITY_PLAN.md 2.5: another town won't start on settings or a
// database copied from Victoria's. Victoria skips every check, so its boot
// can't change.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { townConfig, townBootProblems, useTown, VICTORIA } from '../server/town.js';
import { createApp } from '../server/index.js';
import { FileStore, PgStore } from '../server/db.js';

const BAY = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
const bay = townConfig({}, { town: BAY });
const OK = { siteUrl: 'https://www.thebay979.com', emailFrom: 'The Bay 979 <news@thebay979.com>' };

let tmpDir;
afterEach(async () => {
  useTown(VICTORIA);
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('townBootProblems', () => {
  it('passes Victoria and a town on its own settings', () => {
    expect(townBootProblems(VICTORIA, { siteUrl: 'https://www.thevic361.com', emailFrom: VICTORIA.emailFrom })).toEqual([]);
    expect(townBootProblems(bay, OK)).toEqual([]);
  });

  it("stops another town on Victoria's URL, sender or Google tag", () => {
    expect(townBootProblems(bay, { ...OK, siteUrl: 'https://www.thevic361.com' })).toEqual([expect.stringMatching(/^SITE_URL is Victoria's/)]);
    expect(townBootProblems(bay, { ...OK, siteUrl: 'https://thevic361.com' })).toHaveLength(1);
    expect(townBootProblems(bay, { ...OK, emailFrom: 'The Vic 361 <news@thevic361.com>' })).toEqual([expect.stringMatching(/^NEWSLETTER_FROM/)]);
    expect(townBootProblems(townConfig({}, { town: { ...BAY, gaId: VICTORIA.gaId } }), OK)).toEqual([expect.stringMatching(/^gaId is Victoria's/)]);
    expect(townBootProblems(bay, { ...OK, siteUrl: 'https://www.notthevic361.com' })).toEqual([]);
  });
});

async function boot(extra) {
  tmpDir = tmpDir || await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const store = extra.store || new FileStore(path.join(tmpDir, 's.json'));
  const { store: _, ...rest } = extra;
  return createApp({ storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false,
    adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', ...rest });
}

describe('createApp', () => {
  it("won't start another town on Victoria's settings", async () => {
    await expect(boot({ town: BAY, siteUrl: 'https://www.thevic361.com' })).rejects.toThrow(/TOWN=bay won't start: SITE_URL is Victoria's/);
    await expect(boot({ town: BAY, siteUrl: OK.siteUrl, newsletterFrom: VICTORIA.emailFrom })).rejects.toThrow(/NEWSLETTER_FROM/);
  });

  it('claims a new database, then only starts the town that owns it', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
    const file = path.join(tmpDir, 's.json');
    await boot({ town: BAY, siteUrl: OK.siteUrl, store: new FileStore(file) });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).town_meta).toEqual({ town: 'bay' });
    await boot({ town: BAY, siteUrl: OK.siteUrl, store: new FileStore(file) });   // its own again: fine
    const tulsa = { ...BAY, id: 'tulsa', domain: 'tulsatoday.com', city: 'Tulsa', state: 'OK', stateName: 'Oklahoma' };
    await expect(boot({ town: tulsa, siteUrl: 'https://www.tulsatoday.com', store: new FileStore(file) }))
      .rejects.toThrow(/TOWN=tulsa won't start: its database belongs to TOWN=bay/);
  });

  it("won't take over a database with people in it from before towns", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    await store.addSubscriber({ email: 'reader@example.com', source: 'test' });
    await expect(boot({ town: BAY, siteUrl: OK.siteUrl, store })).rejects.toThrow(/from before towns \(Victoria's\)/);
    expect((await store._read()).town_meta).toBeUndefined();
  });

  it('Victoria starts without claiming anything', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-guards-'));
    const store = new FileStore(path.join(tmpDir, 's.json'));
    await store.addSubscriber({ email: 'reader@example.com', source: 'test' });
    await boot({ store, siteUrl: 'https://www.thevic361.com' });
    expect((await store._read()).town_meta).toBeUndefined();
  });
});

describe('PgStore.claimTown', () => {
  const pool = ({ owner = null, people = 0 } = {}) => {
    const seen = [];
    let town = owner;
    return { seen, query: async (text, params) => {
      seen.push(text);
      if (/information_schema\.tables/.test(text)) return { rows: [{ table_name: 'subscribers' }, { table_name: 'sponsor_orders' }] };
      if (/SELECT value FROM town_meta/.test(text)) return { rows: town ? [{ value: town }] : [] };
      if (/AS n$/.test(text.trim())) return { rows: [{ n: String(people) }] };
      if (/INSERT INTO town_meta/.test(text)) { town = town || params[0]; return { rows: [] }; }
      return { rows: [] };
    } };
  };

  it('claims an empty database once', async () => {
    const p = pool();
    expect(await new PgStore(p).claimTown('bay')).toEqual({ town: 'bay', claimed: true, hasData: false });
    expect(p.seen.some(t => /CREATE TABLE IF NOT EXISTS town_meta/.test(t))).toBe(true);
  });

  it('reports the owner, or the people already in it', async () => {
    expect(await new PgStore(pool({ owner: 'tulsa' })).claimTown('bay')).toEqual({ town: 'tulsa', claimed: false, hasData: null });
    const full = pool({ people: 3 });
    expect(await new PgStore(full).claimTown('bay')).toEqual({ town: null, claimed: false, hasData: true });
    expect(full.seen.some(t => /INSERT INTO town_meta/.test(t))).toBe(false);
  });

  it("isn't part of ready(), so Victoria's database gets no new table", async () => {
    const p = pool();
    await new PgStore(p).ready();
    expect(p.seen.some(t => /town_meta/.test(t))).toBe(false);
  });
});
