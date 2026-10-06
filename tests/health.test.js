// @vitest-environment node
//
// /api/health: plain stays process-only (deploy healthchecks); ?deep=1 also
// asks the database, so the uptime check sees a dead database as down.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let tmpDir, server;

async function start(pool) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-health-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const { app } = await createApp({
    storeBundle: { kind: pool ? 'postgres' : 'file', store: new FileStore(path.join(tmpDir, 's.json')), pool },
    eventsFile, trustProxy: false
  });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  server = null; tmpDir = null;
});

describe('/api/health', () => {
  it('is ok with a working database', async () => {
    const base = await start({ query: async () => ({ rows: [{ '?column?': 1 }] }) });
    const r = await fetch(`${base}/api/health?deep=1`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, storage: 'postgres' });
  });

  it('deep check is 503 when the database errors; plain check stays 200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = await start({ query: async () => { throw new Error('connection refused'); } });
    const deep = await fetch(`${base}/api/health?deep=1`);
    expect(deep.status).toBe(503);
    expect(await deep.json()).toMatchObject({ ok: false, error: 'database' });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('deep check is 503 when the database hangs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = await start({ query: () => new Promise(() => {}) });
    const t0 = Date.now();
    const deep = await fetch(`${base}/api/health?deep=1`);
    expect(deep.status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 10000);

  it('file storage (no database) is ok', async () => {
    const base = await start(undefined);
    expect((await fetch(`${base}/api/health?deep=1`)).status).toBe(200);
  });
});
