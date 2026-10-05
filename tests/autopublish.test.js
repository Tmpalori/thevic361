// @vitest-environment node
//
// Auto-publish (server/autopublish.js): collector candidates go live without
// the admin, but the admin's removals stick.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-05T15:00:00Z'); // Mon Oct 5

let tmpDir, server, baseUrl, store, sent;

async function start({ candidates, published = null, extra = {}, storeKind = 'file' } = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-auto-'));
  const candidatesFile = path.join(tmpDir, 'candidates.json');
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(candidatesFile, JSON.stringify(candidates));
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  if (published) await store.setPublished(published);
  sent = [];
  const { app } = await createApp({
    storeBundle: { kind: storeKind, store }, eventsFile, candidatesFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c',
    slack: { enabled: true, notify: async (m) => { sent.push(m); return true; }, alert: async () => {} },
    ...extra
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

async function auth() {
  const r = await fetch(baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
  return { Authorization: `Bearer ${(await r.json()).token}`, 'Content-Type': 'application/json' };
}
const runNow = async () => (await fetch(baseUrl + '/api/admin/auto-publish', { method: 'POST', headers: await auth() })).json();
const live = async () => (await fetch(baseUrl + '/events.json')).json();

const CANDIDATES = {
  last_updated: '2026-10-04T23:40:00-05:00',
  events: [
    { date: '2026-10-01', name: 'Already Happened', time: '7:00 PM', venue: 'X' },
    { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters', _source: 'apify_facebook' },
    { date: '2026-10-10', name: 'Farmers Market', time: '8:00 AM', venue: 'Market Square' },
    { date: '2026-10-10', name: 'Fall Festival 2026', time: '11:00 AM', venue: 'De Leon Plaza' }
  ]
};

describe('auto-publish', () => {
  it('publishes upcoming candidates, keeps prior events and extras, hides bookkeeping', async () => {
    await start({
      candidates: CANDIDATES,
      published: {
        last_updated: '2026-09-28T00:00:00Z',
        sponsor: { name: 'Acme' },
        events: [
          { date: '2026-10-10', name: 'Fall Festival', time: '11:00 AM', venue: 'De Leon Plaza' }, // hand-picked, same event
          { date: '2026-09-20', name: 'Old Event', time: '1 PM', venue: 'Y' }
        ]
      }
    });
    const r = await runNow();
    expect(r).toMatchObject({ ok: true, published: 3, added: 2, kept: 1 });

    const d = await live();
    expect(d.events.map(e => e.name)).toEqual(['Friday Live Music', 'Farmers Market', 'Fall Festival']);
    expect(d.sponsor.name).toBe('Acme');
    expect(d.auto_publish).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('_source');
    expect(sent[0].title).toBe('🗓️ Published 3 events automatically');
  });

  it("doesn't re-add an event the admin removed", async () => {
    await start({ candidates: CANDIDATES });
    await runNow();
    const h = await auth();
    // Admin takes Farmers Market down with Save & Publish.
    const keep = (await live()).events.filter(e => e.name !== 'Farmers Market');
    await fetch(baseUrl + '/api/admin/publish-events', { method: 'POST', headers: h, body: JSON.stringify({ events: keep }) });

    const r = await runNow();
    expect(r.skipped_removed).toBe(1);
    expect((await live()).events.map(e => e.name)).not.toContain('Farmers Market');
  });

  it('includes approved submissions', async () => {
    await start({ candidates: { last_updated: 'x', events: [] } });
    await store.insert({
      id: 's1', status: 'approved', source: 'submission', created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      payload: { date: '2026-10-08', name: 'Church Fish Fry', time: '5:00 PM', venue: 'St. Mary', description: 'Fish.', icons: ['food'] }
    });
    await runNow();
    expect((await live()).events.map(e => e.name)).toEqual(['Church Fish Fry']);
  });

  it('runs on boot once per candidates file', async () => {
    await start({ candidates: CANDIDATES, extra: { autoPublish: true, autoPublishDelayMs: 0 } });
    await new Promise(r => setTimeout(r, 100));
    expect((await live()).events).toHaveLength(3);
    const at = (await store.getPublished()).auto_publish.at;

    // Same candidates on the next boot: nothing changes.
    await new Promise(r => server.close(r));
    const { app } = await createApp({
      storeBundle: { kind: 'file', store }, eventsFile: path.join(tmpDir, 'events.json'),
      candidatesFile: path.join(tmpDir, 'candidates.json'), trustProxy: false, now: () => NOW,
      siteUrl: 'https://www.thevic361.com', autoPublish: true, autoPublishDelayMs: 0,
      slack: { enabled: false, notify: async () => false, alert: async () => false }
    });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    await new Promise(r => setTimeout(r, 100));
    expect((await store.getPublished()).auto_publish.at).toBe(at);
  });

  it('takes down auto-added events the new run no longer finds, but never hand-added or edited ones', async () => {
    const key = ev => [ev.date, ev.name, ev.venue].join('|');
    const wrongBingo = { date: '2026-10-05', name: 'Bingo Night', time: '7:00 PM', venue: 'J Welch Farms' };
    const wrongMusic = { date: '2026-10-11', name: 'Live Music', time: '7:00 PM', venue: 'J Welch Farms' };
    const editedAuto = { date: '2026-10-07', name: 'Trivia', time: '7:00 PM', venue: 'Shooters' };
    const stillFound = { date: '2026-10-09', name: 'Friday Live Music', time: '8:00 PM', venue: 'Aero Crafters' };
    const handAdded = { date: '2026-10-12', name: 'Hand Pick', time: '6:00 PM', venue: 'Somewhere' };
    await start({
      candidates: CANDIDATES,
      published: {
        last_updated: '2026-10-03T00:00:00Z',
        events: [wrongBingo, wrongMusic, editedAuto, stillFound, handAdded],
        auto_publish: { from: 'older', keys: [wrongBingo, wrongMusic, editedAuto, stillFound].map(key), rejected: [] }
      }
    });
    await store.upsertEventEdit({ original_key: key(editedAuto), payload: { ...editedAuto, time: '8:00 PM' } });

    const r = await runNow();
    expect(r.retired).toBe(2);
    const names = (await live()).events.map(e => `${e.date} ${e.name}`);
    expect(names).not.toContain('2026-10-05 Bingo Night');
    expect(names).not.toContain('2026-10-11 Live Music');
    expect(names).toEqual(expect.arrayContaining(['2026-10-07 Trivia', '2026-10-09 Friday Live Music', '2026-10-12 Hand Pick']));
    expect(sent[0].fields).toContainEqual(['Taken down (no longer found)', 2]);

    // Retired isn't "removed by the admin": a later run that finds it again brings it back.
    const state = (await store.getPublished()).auto_publish;
    expect(state.rejected).not.toContain(key(wrongBingo));
    await fs.writeFile(path.join(tmpDir, 'candidates.json'), JSON.stringify({
      last_updated: 'next', events: [...CANDIDATES.events, wrongBingo]
    }));
    await runNow();
    expect((await live()).events.map(e => `${e.date} ${e.name}`)).toContain('2026-10-05 Bingo Night');
  });

  it('takes nothing down when the new run looks broken', async () => {
    const ours = Array.from({ length: 10 }, (_, i) => ({ date: '2026-10-08', name: `Event ${i}`, time: '7:00 PM', venue: `V${i}` }));
    await start({
      candidates: { last_updated: 'broken', events: [{ date: '2026-10-09', name: 'Lonely', venue: 'X' }] },
      published: { events: ours, auto_publish: { from: 'older', keys: ours.map(e => [e.date, e.name, e.venue].join('|')) } }
    });
    const r = await runNow();
    expect(r.retired).toBe(0);
    expect((await live()).events).toHaveLength(11);
  });

  it('re-applies new publish rules on boot even when candidates are unchanged', async () => {
    const wrong = { date: '2026-10-05', name: 'Bingo Night', time: '7:00 PM', venue: 'J Welch Farms' };
    await start({
      candidates: CANDIDATES,
      // Published by the old rules from these same candidates (no "rules" marker).
      published: {
        events: [wrong, ...CANDIDATES.events.slice(1).map(({ _source, ...e }) => e)],
        auto_publish: { from: CANDIDATES.last_updated, keys: [[wrong.date, wrong.name, wrong.venue].join('|')] }
      },
      extra: { autoPublish: true, autoPublishDelayMs: 0 }
    });
    await new Promise(r => setTimeout(r, 100));
    expect((await live()).events.map(e => e.name)).not.toContain('Bingo Night');
    expect((await store.getPublished()).auto_publish.rules).toBe(2);
  });

  it('publishes New & Notable from the collector and keeps recent earlier finds for three weeks', async () => {
    const recent = { name: 'Arcade opens on Navarro', description: 'x', tag: 'new', icon: 'music', url: 'https://a.example', added: '2026-09-25' };
    const stale = { name: 'Old opening', description: 'x', tag: 'new', icon: 'food', url: 'https://b.example', added: '2026-09-01' };
    const legacy = { name: 'Hand item from before', description: 'x', tag: 'coming', icon: 'food' }; // no date
    const fresh = { name: 'Ellianos Coffee opens', description: 'y', tag: 'new', icon: 'food', url: 'https://c.example', added: '2026-10-05' };
    await start({
      candidates: { ...CANDIDATES, new_and_notable: [fresh, { ...recent, description: 'dupe by name' }] },
      published: { events: [], new_and_notable: [recent, stale, legacy] }
    });
    await runNow();
    const d = await live();
    expect(d.new_and_notable.map(n => n.name)).toEqual(['Ellianos Coffee opens', 'Arcade opens on Navarro']);
  });

  it('leaves New & Notable alone when the candidates predate it', async () => {
    const item = { name: 'Kept as is', description: 'x', tag: 'new', icon: 'food' };
    await start({ candidates: CANDIDATES, published: { events: [], new_and_notable: [item] } });
    await runNow();
    expect((await live()).new_and_notable).toEqual([item]);
  });

  it('is off by default outside production', async () => {
    await start({ candidates: CANDIDATES });
    await new Promise(r => setTimeout(r, 50));
    expect(await store.getPublished()).toBeNull();
  });
});

describe('admin setup checklist', () => {
  it('needs a login and reports presence only', async () => {
    await start({ candidates: CANDIDATES });
    expect((await fetch(baseUrl + '/api/admin/setup')).status).toBe(401);
    await runNow();
    const r = await (await fetch(baseUrl + '/api/admin/setup', { headers: await auth() })).json();
    expect(r.ok).toBe(true);
    const byKey = Object.fromEntries(r.checks.map(c => [c.key, c]));
    expect(byKey.login.ok).toBe(true);
    expect(byKey.slack.ok).toBe(true);
    expect(byKey.database.ok).toBe(false);
    expect(byKey.social.ok).toBeNull();
    expect(r.status.upcoming_events).toBe(3);
    expect(r.status.collected_at).toBe(CANDIDATES.last_updated);
    expect(JSON.stringify(r)).not.toMatch(/"b"|"c"/); // no password/secret values
  });

  it('counts the Postgres store as set up', async () => {
    // server/db.js names it 'postgres'; the check once looked for 'pg' and always warned.
    await start({ candidates: CANDIDATES, storeKind: 'postgres' });
    const r = await (await fetch(baseUrl + '/api/admin/setup', { headers: await auth() })).json();
    expect(r.checks.find(c => c.key === 'database').ok).toBe(true);
  });
});

describe('client IP behind Railway', () => {
  it('ignores a forged X-Forwarded-For and uses the edge X-Real-IP', async () => {
    const { createApp: make } = await import('../server/index.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-ip-'));
    const { app } = await make({ storeBundle: { kind: 'file', store: new FileStore(path.join(dir, 's.json')) },
      trustProxy: 1, railway: true, adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c' });
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, r));
    const url = `http://127.0.0.1:${srv.address().port}/api/admin/login`;
    const tryLogin = (xff) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff, 'X-Real-IP': '203.0.113.9' },
      body: JSON.stringify({ username: 'a', password: 'wrong' }) });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await tryLogin(`10.0.0.${i}`)).status);
    expect(codes).toContain(429);
    await new Promise(r => srv.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
});
