// @vitest-environment node
//
// Direct unit tests for server/turnstile.js and server/metaPixel.js helpers
// (the route tests in growth.test.js / traffic.test.js only cover them
// through the app).

import { describe, it, expect } from 'vitest';
import { verifyTurnstile } from '../server/turnstile.js';
import { pixelId, metaPixelJs } from '../server/metaPixel.js';

const reply = (json, ok = true) => async () => ({ ok, json: async () => json });

describe('verifyTurnstile', () => {
  it('is disabled without a secret', async () => {
    expect(await verifyTurnstile('', { secret: '' })).toEqual({ ok: true, disabled: true });
  });

  it('never accepts a missing token once the secret is set', async () => {
    const fetch = async () => { throw new Error('must not call Cloudflare'); };
    expect(await verifyTurnstile('', { secret: 's', fetch })).toEqual({ ok: false, error: 'missing-token' });
    expect(await verifyTurnstile({ token: 'x' }, { secret: 's', fetch })).toEqual({ ok: false, error: 'missing-token' });
  });

  it('posts the secret, token and IP to siteverify', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return { json: async () => ({ success: true }) }; };
    expect((await verifyTurnstile('tok', { secret: 's', remoteip: '1.2.3.4', fetch })).ok).toBe(true);
    expect(calls[0].url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body))).toEqual({ secret: 's', response: 'tok', remoteip: '1.2.3.4' });
  });

  it('fails closed on a rejection, a bad body or a network error', async () => {
    expect(await verifyTurnstile('tok', { secret: 's', fetch: reply({ success: false, 'error-codes': ['timeout-or-duplicate'] }) }))
      .toEqual({ ok: false, error: 'verification-failed', codes: ['timeout-or-duplicate'] });
    const badJson = async () => ({ json: async () => { throw new SyntaxError('html'); } });
    expect((await verifyTurnstile('tok', { secret: 's', fetch: badJson })).error).toBe('verification-failed');
    const down = async () => { throw new Error('ECONNRESET'); };
    expect(await verifyTurnstile('tok', { secret: 's', fetch: down })).toMatchObject({ ok: false, error: 'network-error' });
  });
});

describe('Meta Pixel helpers', () => {
  it('accepts only numeric pixel IDs', () => {
    expect(pixelId(' 1234567890 ')).toBe('1234567890');
    expect(pixelId('123')).toBeNull();
    expect(pixelId("123456');alert(1)//")).toBeNull();
    expect(pixelId(undefined)).toBeNull();
  });

  it('serves an empty script while off and the ID once set', () => {
    expect(metaPixelJs(null)).not.toContain('fbevents');
    const js = metaPixelJs('1234567890');
    expect(js).toContain("fbq('init', '1234567890')");
    expect(js).toContain('vic361_admin_session'); // skips the signed-in owner
  });
});
