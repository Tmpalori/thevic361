// @vitest-environment node
//
// First-party visitor stats (server/analytics.js): beacon endpoint, crawler
// logging, and the admin Traffic summary.

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { botName, referrerSource, beaconRow, summarize } from '../server/analytics.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = new Date('2026-10-07T17:00:00Z');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';

let tmpDir, server, baseUrl, store;

async function startApp() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-traffic-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  store = new FileStore(path.join(tmpDir, 's.json'));
  const { app } = await createApp({
    storeBundle: { kind: 'file', store }, eventsFile, trustProxy: false, now: () => NOW,
    siteUrl: 'https://www.thevic361.com', analyticsSecret: 'test',
    adminUsername: 'tristen', adminPassword: 'pw', adminSessionSecret: 'secret'
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

const beacon = (body, ua = UA) => fetch(baseUrl + '/api/track', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify(body)
});

async function token() {
  const r = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tristen', password: 'pw' })
  });
  return (await r.json()).token;
}

// Writes land after the 204, so wait for them.
const settle = () => new Promise(r => setTimeout(r, 50));

describe('analytics helpers', () => {
  it('names crawlers and lets browsers through', () => {
    expect(botName('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)')).toBe('GPTBot (ChatGPT)');
    expect(botName('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)')).toBe('ClaudeBot');
    expect(botName('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe('Googlebot');
    expect(botName('curl/8.6.0')).toBe('Other bot');
    expect(botName(UA)).toBeNull();
  });

  it('groups referrers', () => {
    expect(referrerSource('https://www.google.com/', 'www.thevic361.com').source).toBe('Google');
    expect(referrerSource('https://chatgpt.com/', 'www.thevic361.com').source).toBe('ChatGPT');
    expect(referrerSource('https://l.facebook.com/l.php?u=x', 'www.thevic361.com').source).toBe('Facebook');
    expect(referrerSource('https://www.thevic361.com/live-music', 'www.thevic361.com').source).toBe('Direct');
    expect(referrerSource('', 'www.thevic361.com').source).toBe('Direct');
    expect(referrerSource('https://victoriaadvocate.com/x', 'www.thevic361.com'))
      .toEqual({ source: 'Other sites', host: 'victoriaadvocate.com' });
  });

  it('rejects unknown click types and bot beacons', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    expect(beaconRow({ kind: 'click', type: 'drop_tables' }, ctx)).toBeNull();
    expect(beaconRow({ kind: 'view' }, { ...ctx, ua: 'HeadlessChrome' })).toBeNull();
    expect(beaconRow({ kind: 'view', path: '/x?secret=1' }, ctx).path).toBe('/x');
  });

  it('counts one visitor per person per day', () => {
    const ctx = { ip: '1.1.1.1', ua: UA, secret: 's', siteHost: 'www.thevic361.com', now: NOW };
    const a = beaconRow({ kind: 'view', path: '/' }, ctx);
    const b = beaconRow({ kind: 'view', path: '/live-music' }, ctx);
    const c = beaconRow({ kind: 'view', path: '/' }, { ...ctx, ip: '2.2.2.2' });
    expect(a.visitor).toBe(b.visitor);
    expect(a.visitor).not.toBe(c.visitor);
    const t = summarize([a, b, c], { now: NOW, days: 7 });
    expect(t.totals.today).toEqual({ visitors: 2, views: 3 });
    expect(t.top_pages[0]).toEqual({ key: '/', count: 2 });
    expect(t.daily).toHaveLength(7);
  });
});

describe('traffic endpoints', () => {
  it('records views, clicks and crawler hits, and summarizes them for the admin', async () => {
    await startApp();
    expect((await beacon({ kind: 'view', path: '/this-weekend', ref: 'https://www.google.com/' })).status).toBe(204);
    await beacon({ kind: 'view', path: '/', ref: '' });
    await beacon({ kind: 'click', type: 'sponsor_click', url: 'https://acme.example', path: '/' });
    await beacon({ kind: 'view', path: '/' }, 'curl/8.6.0'); // ignored
    await fetch(baseUrl + '/about', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GPTBot/1.2)' } });
    await fetch(baseUrl + '/about', { headers: { 'User-Agent': UA } }); // humans come via beacon only
    await settle();

    const unauth = await fetch(baseUrl + '/api/admin/traffic');
    expect(unauth.status).toBe(401);

    const r = await fetch(baseUrl + '/api/admin/traffic?days=7', { headers: { Authorization: `Bearer ${await token()}` } });
    const t = await r.json();
    expect(t.ok).toBe(true);
    expect(t.totals.today).toEqual({ visitors: 1, views: 2 });
    expect(t.sources.map(s => s.key).sort()).toEqual(['Direct', 'Google']);
    expect(t.clicks).toEqual([{ key: 'sponsor_click', count: 1, label: 'Sponsor clicks' }]);
    expect(t.crawlers).toEqual([{ key: 'GPTBot (ChatGPT)', count: 1 }]);
    expect(t.crawler_pages).toEqual([{ key: '/about', count: 1 }]);
  });

  it('ignores malformed beacons', async () => {
    await startApp();
    const r = await fetch(baseUrl + '/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    expect(r.status).toBe(204);
    await beacon({ kind: 'nope' });
    await settle();
    expect(await store.listTraffic('2026-01-01')).toEqual([]);
  });
});
