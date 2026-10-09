// The archive read is fully ordered (date, then page), so same-time events
// on venue pages keep their order across deploys (seen on production on
// 2026-10-09: two 6:30 PM events at one venue swapped after a redeploy,
// because Postgres returned same-day rows in physical order).

import { it, expect } from 'vitest';
import { PgStore } from '../server/db.js';

it('listArchivedEvents orders by date, then page', async () => {
  const seen = [];
  const pool = { query: async (text) => {
    seen.push(text);
    if (/information_schema\.tables/.test(text)) return { rows: [{ table_name: 'subscribers' }, { table_name: 'sponsor_orders' }] };
    return { rows: [] };
  } };
  await new PgStore(pool).listArchivedEvents();
  const sql = seen.find(t => /FROM event_archive WHERE event_date IS NULL/.test(t));
  expect(sql).toMatch(/ORDER BY event_date DESC NULLS LAST, page$/);
});
