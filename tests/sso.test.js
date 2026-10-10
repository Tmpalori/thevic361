// @vitest-environment node
//
// Sign-in from HQ (server/sso.js): HQ's POST /go/<slug> mints a one-time
// pass for one town and posts it from the browser; the town's POST
// /api/admin/sso checks it and hands back an ordinary admin session. A
// pass is for one town, lives a minute and works once; anything else is
// refused, and the feature is off unless both sides hold the secret.

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mintPass, verifyPass, TTL_S, SKEW_S } from '../server/sso.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { createHqApp, hqConfig } from '../hq/server.js';

const SECRET = 'sso-'.repeat(12);
const VIC = { slug: 'victoria', siteUrl: 'https://www.thevic361.com' };
const NOW = Date.UTC(2026, 9, 10, 18, 0, 0);

describe('passes', () => {
  const pass = (o = {}) => mintPass(SECRET, { ...VIC, sub: 'tristen', now: NOW, ...o });

  it('a fresh pass for this town checks out', () => {
    const v = verifyPass(SECRET, pass(), { ...VIC, now: NOW + 5000 });
    expect(v.ok).toBe(true);
    expect(v.payload).toMatchObject({ v: 1, aud: 'victoria@www.thevic361.com', sub: 'tristen' });
    expect(v.payload.exp - v.payload.iat).toBe(TTL_S);
  });

  it('every pass carries its own nonce', () => {
    const n = new Set(Array.from({ length: 20 }, () => verifyPass(SECRET, pass(), { ...VIC, now: NOW }).payload.n));
    expect(n.size).toBe(20);
  });

  it('refuses another town, another host, another secret, or a changed byte', () => {
    expect(verifyPass(SECRET, pass(), { slug: 'bay', siteUrl: VIC.siteUrl, now: NOW }).reason).toBe('wrong-town');
    expect(verifyPass(SECRET, pass(), { slug: 'victoria', siteUrl: 'https://evil.example', now: NOW }).reason).toBe('wrong-town');
    expect(verifyPass('x'.repeat(48), pass(), { ...VIC, now: NOW }).reason).toBe('bad-signature');
    const p = pass();
    const flipped = (p[3] === 'A' ? 'B' : 'A');
    expect(verifyPass(SECRET, p.slice(0, 3) + flipped + p.slice(4), { ...VIC, now: NOW }).ok).toBe(false);
    expect(verifyPass(SECRET, p + 'x', { ...VIC, now: NOW }).reason).toBe('bad-signature');
  });

  it('refuses a pass from another town relabelled for this one', () => {
    const bay = mintPass(SECRET, { slug: 'bay', siteUrl: 'https://www.thebay979.com', sub: 'tristen', now: NOW });
    const [body, mac] = bay.split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    const relabelled = Buffer.from(JSON.stringify({ ...p, aud: 'victoria@www.thevic361.com' })).toString('base64url');
    expect(verifyPass(SECRET, `${relabelled}.${mac}`, { ...VIC, now: NOW }).reason).toBe('bad-signature');
  });

  it('expires after its minute (plus a little clock difference), and never starts in the future', () => {
    expect(verifyPass(SECRET, pass(), { ...VIC, now: NOW + (TTL_S + SKEW_S) * 1000 }).ok).toBe(true);
    expect(verifyPass(SECRET, pass(), { ...VIC, now: NOW + (TTL_S + SKEW_S + 2) * 1000 }).reason).toBe('expired');
    expect(verifyPass(SECRET, pass({ now: NOW + (SKEW_S + 5) * 1000 }), { ...VIC, now: NOW }).reason).toBe('not-yet-valid');
  });

  it('refuses a pass that claims a long life, even one signed with the right secret', () => {
    const key = crypto.createHmac('sha256', SECRET).update('hq-sso-v1\0key').digest();
    const body = Buffer.from(JSON.stringify({ v: 1, aud: 'victoria@www.thevic361.com', sub: 'x', iat: NOW / 1000, exp: NOW / 1000 + 86400,
      n: 'n'.repeat(24) })).toString('base64url');
    const mac = crypto.createHmac('sha256', key).update(`hq-sso-v1\0${body}`).digest('base64url');
    expect(verifyPass(SECRET, `${body}.${mac}`, { ...VIC, now: NOW }).reason).toBe('malformed');
  });

  it('is off without a long enough secret, and refuses junk', () => {
    expect(() => mintPass('short', { ...VIC, sub: 'x' })).toThrow();
    expect(verifyPass('short', pass(), { ...VIC, now: NOW }).reason).toBe('off');
    for (const junk of [undefined, '', 'a', 'a.b.c', 'x'.repeat(5000), '.abc']) {
      expect(verifyPass(SECRET, junk, { ...VIC, now: NOW }).ok).toBe(false);
    }
  });
});

describe('the town signs in with a pass', () => {
  let tmpDir, server, base;
  afterEach(async () => {
    if (server) await new Promise(r => server.close(r));
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    server = null; tmpDir = null;
  });
  async function start(opts = {}) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-sso-'));
    const file = path.join(tmpDir, 's.json');
    const { app } = await createApp({ storeBundle: { kind: 'file', store: new FileStore(file), file }, trustProxy: false,
      adminUsername: 'tristen', adminPassword: 'correct horse battery staple', adminSessionSecret: 'a'.repeat(40),
      ssoSecret: SECRET, siteUrl: VIC.siteUrl, slack: { enabled: false, notify: async () => false, alert: async () => false }, ...opts });
    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const post = pass => fetch(base + '/api/admin/sso', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(pass === undefined ? {} : { pass }).toString() });
  const fresh = () => mintPass(SECRET, { ...VIC, sub: 'tristen' });

  it('a good pass gives a working admin session, once', async () => {
    await start();
    const pass = fresh();
    const r = await post(pass);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+'/);
    expect(r.headers.get('content-security-policy')).not.toMatch(/unsafe-inline/);
    const html = await r.text();
    const token = /setItem\('vic361_admin_session',"([^"]+)"\)/.exec(html)[1];
    expect(html).toContain("location.replace('/admin.html')");
    const me = await fetch(base + '/api/admin/me', { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    // The same pass again (copied, or replayed): refused.
    expect((await post(pass)).status).toBe(401);
  });

  it('refuses a missing, wrong-town or forged pass', async () => {
    await start();
    expect((await post(undefined)).status).toBe(401);
    expect((await post(mintPass(SECRET, { slug: 'bay', siteUrl: 'https://www.thebay979.com', sub: 'x' }))).status).toBe(401);
    expect((await post(mintPass('z'.repeat(48), { ...VIC, sub: 'x' }))).status).toBe(401);
  });

  it('is off (404) without HQ_SSO_SECRET, and needs the admin login set up', async () => {
    await start({ ssoSecret: '' });
    expect((await post(fresh())).status).toBe(404);
    await new Promise(r => server.close(r)); server = null;
    await fs.rm(tmpDir, { recursive: true, force: true }); tmpDir = null;
    await start({ adminPassword: '', adminUsername: '' });
    expect((await post(fresh())).status).toBe(503);
  });
});

describe('HQ opens a town signed in', () => {
  const ENV = {
    HQ_TOWNS: JSON.stringify([
      { slug: 'victoria', site_url: 'https://www.thevic361.com', key: 'vic-key-0123456789abcdef', sso: SECRET },
      { slug: 'bay', site_url: 'https://www.thebay979.com', key: 'bay-key-0123456789abcdef' }
    ]),
    HQ_USERNAME: 'tristen', HQ_PASSWORD: 'correct horse battery', HQ_SESSION_SECRET: 's'.repeat(40)
  };
  let server, base;
  afterEach(async () => { if (server) await new Promise(r => server.close(r)); server = null; });
  async function start() {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, town: { name: 'T' } }) });
    server = http.createServer(createHqApp(hqConfig(ENV), { fetchImpl, railway: false }));
    await new Promise(r => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function cookie() {
    const r = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'tristen', password: 'correct horse battery' }).toString() });
    return r.headers.get('set-cookie').split(';')[0];
  }
  const go = (slug, headers = {}) => fetch(base + `/go/${slug}`, { method: 'POST', redirect: 'manual', headers });

  it('posts a pass for that town only, from a page that submits itself', async () => {
    await start();
    const r = await go('victoria', { Cookie: await cookie(), Origin: base });
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy');
    expect(csp).toContain('form-action https://www.thevic361.com');
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    const html = await r.text();
    expect(html).toContain('action="https://www.thevic361.com/api/admin/sso"');
    const pass = /name="pass" value="([^"]+)"/.exec(html)[1];
    expect(verifyPass(SECRET, pass, { ...VIC }).ok).toBe(true);
    expect(html).not.toContain('vic-key-0123456789abcdef');
  });

  it('only for a signed-in owner, from HQ itself, to a town with a secret', async () => {
    await start();
    expect((await go('victoria')).status).toBe(401);
    const c = await cookie();
    expect((await go('victoria', { Cookie: c, Origin: 'https://evil.example' })).status).toBe(403);
    expect((await go('bay', { Cookie: c, Origin: base })).status).toBe(404);
    expect((await go('nope', { Cookie: c, Origin: base })).status).toBe(404);
  });

  it('the dashboard has a sign-in button for a town with a secret, a plain link otherwise', async () => {
    await start();
    const html = await (await fetch(base + '/', { headers: { Cookie: await cookie() } })).text();
    expect(html).toContain('action="/go/victoria"');
    expect(html).not.toContain('action="/go/bay"');
    expect(html).not.toContain(SECRET);
  });

  it('takes a town and its secret from their own variables too', () => {
    const c = hqConfig({ ...ENV, HQ_SSO_BAY: 'b'.repeat(40),
      HQ_TOWN_ST_JOE: JSON.stringify({ site_url: 'https://www.stjoe.example', key: 'j'.repeat(40), sso: 'j2'.repeat(20) }) });
    expect(c.towns.map(t => [t.slug, Boolean(t.sso)])).toEqual([['victoria', true], ['bay', true], ['st-joe', true]]);
    expect(() => hqConfig({ ...ENV, HQ_TOWN_VICTORIA: JSON.stringify({ site_url: 'https://x.example', key: 'k'.repeat(40) }) })).toThrow(/twice/);
    expect(() => hqConfig({ ...ENV, HQ_TOWN_X: 'nope' })).toThrow(/HQ_TOWN_X/);
  });

  it('checks the secrets it is given', () => {
    const towns = sso => JSON.stringify([{ slug: 'a', site_url: 'https://a.example', key: 'k'.repeat(40), sso }]);
    expect(() => hqConfig({ ...ENV, HQ_TOWNS: towns('short') })).toThrow(/sso/);
    expect(() => hqConfig({ ...ENV, HQ_TOWNS: towns('k'.repeat(40)) })).toThrow(/differ/);
  });
});
