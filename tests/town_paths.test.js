// @vitest-environment node
//
// MULTI_CITY_PLAN.md 2.4: a town's data files. Victoria's stay at the repo
// root and in docs/ (exactly where they always were); another town's live
// under towns/<slug>/, its public ones in towns/<slug>/public/ (served
// before docs/). The admin reads and writes them on GitHub at these paths.

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { townConfig, townPaths, useTown, VICTORIA } from '../server/town.js';
import { createApp } from '../server/index.js';
import { FileStore } from '../server/db.js';

const BAY = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };

let server, tmpDir;
afterEach(async () => {
  useTown(VICTORIA);
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  server = null; tmpDir = null;
});

async function config(extra) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-paths-'));
  const eventsFile = path.join(tmpDir, 'events.json');
  await fs.writeFile(eventsFile, JSON.stringify({ events: [] }));
  const { app } = await createApp({ storeBundle: { kind: 'file', store: new FileStore(path.join(tmpDir, 's.json')) }, eventsFile,
    trustProxy: false, adminUsername: 'a', adminPassword: 'b', adminSessionSecret: 'c', ...extra });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  return (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
}

describe('townPaths', () => {
  it("keeps Victoria's files where they are", () => {
    expect(townPaths(VICTORIA)).toEqual({
      candidates: 'candidates.json', collectionMetadata: 'collection_metadata.json', enrichmentCache: 'enrichment_cache.json',
      venues: 'venues.json', localEvents: 'local_events.yaml', extras: 'extras.yaml',
      events: 'docs/events.json', social: 'docs/social/latest/'
    });
  });

  it("puts another town's under towns/<slug>/", () => {
    const p = townPaths(townConfig({}, { town: BAY }));
    expect(p).toEqual({
      candidates: 'towns/bay/candidates.json', collectionMetadata: 'towns/bay/collection_metadata.json',
      enrichmentCache: 'towns/bay/enrichment_cache.json', venues: 'towns/bay/venues.json',
      localEvents: 'towns/bay/local_events.yaml', extras: 'towns/bay/extras.yaml',
      events: 'towns/bay/public/events.json', social: 'towns/bay/public/social/latest/'
    });
  });
});

describe('/api/config', () => {
  it('tells the admin where to read and publish', async () => {
    expect(await config({})).toMatchObject({ github_events_path: 'docs/events.json', github_candidates_path: 'candidates.json' });
    await new Promise(r => server.close(r)); server = null;
    expect(await config({ town: BAY, siteUrl: 'https://www.thebay979.com' }))
      .toMatchObject({ github_events_path: 'towns/bay/public/events.json', github_candidates_path: 'towns/bay/candidates.json' });
  });
});
