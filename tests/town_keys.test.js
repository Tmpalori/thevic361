// @vitest-environment node
//
// MULTI_CITY_PLAN.md 2.1: every key the server hands Stripe, Resend and
// Tremendous starts with the town's keyPrefix ("vic361" for Victoria, the
// slug for another town), so two towns on one account can't collide: the
// weekly batch key would otherwise drop the second town's issue, and the
// monthly drawing's external_id would refuse the second town's card.
// Victoria's own keys are pinned by sponsors.test.js and newsletter.test.js.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { townConfig, useTown, VICTORIA } from '../server/town.js';
import { createStripe } from '../server/sponsors.js';

const BAY = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };

afterAll(() => useTown(VICTORIA));

describe('keyPrefix', () => {
  it('is vic361 for Victoria and the slug for another town', () => {
    expect(VICTORIA.keyPrefix).toBe('vic361');
    expect(townConfig({}, { town: BAY }).keyPrefix).toBe('bay');
  });

  it("can't be Victoria's or carry odd characters", () => {
    expect(() => townConfig({}, { town: { ...BAY, keyPrefix: 'vic361' } })).toThrow(/keyPrefix/);
    expect(() => townConfig({}, { town: { ...BAY, keyPrefix: 'Bay City' } })).toThrow(/keyPrefix/);
  });
});

describe('Stripe catalog keys', () => {
  it("another town's prices, products and idempotency keys carry its prefix", async () => {
    useTown(townConfig({}, { town: BAY }));
    const calls = [];
    const ok = b => ({ ok: true, status: 200, json: async () => b });
    const client = createStripe('rk_test_x', async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/prices?')) return ok({ data: [] });
      return ok({ id: url.endsWith('/products') ? 'prod_1' : 'price_1' });
    });
    await client.ensurePrice({ key: 'partner', name: 'Venue partner', amount: 15000, interval: 'month' });
    expect(calls[0].url).toContain('lookup_keys%5B%5D=bay_partner_15000_month');
    expect(calls[1].init.body).toContain('metadata%5Bbay_package%5D=partner');
    expect(calls[1].init.headers['Idempotency-Key']).toBe('bay-product-partner');
    expect(calls[2].init.headers['Idempotency-Key']).toBe('bay-price-bay_partner_15000_month');
    expect(JSON.stringify(calls)).not.toContain('vic361');
  });
});

describe('server source', () => {
  it('builds no Stripe, Resend or Tremendous key from a literal vic361', () => {
    const dir = path.resolve(__dirname, '../server');
    const hits = fs.readdirSync(dir).filter(f => f.endsWith('.js')).flatMap(f =>
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
        .map((line, i) => [`${f}:${i + 1}`, line])
        .filter(([, line]) => /`vic361[-_]/.test(line)));
    expect(hits).toEqual([]);
  });
});
