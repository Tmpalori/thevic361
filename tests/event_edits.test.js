// @vitest-environment node
//
// Tests for the admin event editor (PR #22).
//
// Endpoint: POST /api/admin/event-edits
//   - Auth required
//   - Validates payload (required fields, ISO date, URL shape)
//   - Persists an overlay keyed by original_key
//   - Overlay is applied to /api/admin/candidates so the edited shape
//     replaces the original event without producing duplicates
//   - Overlay is applied to /api/admin/published-events so a correction
//     reflects on the live site immediately

import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../server/index.js';
import { FileStore, applyEventEdits, eventKeyOf } from '../server/db.js';
import { validateEventEdit } from '../server/validate.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let tmpDir, appBundle, server, baseUrl;

async function startApp(opts = {}) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vic361-edits-'));
  const file = path.join(tmpDir, 'submissions.json');
  const storeBundle = { kind: 'file', store: new FileStore(file), file };
  // Isolate the bundled candidate/events files from the real repo so a test
  // that publishes "Original Title" doesn't compete with the 100+ candidates
  // in the real candidates.json.
  const candidatesFile = path.join(tmpDir, 'candidates.json');
  const eventsFile = path.join(tmpDir, 'events.json');
  if (opts.seedCandidates !== undefined) {
    await fs.writeFile(candidatesFile,
      JSON.stringify({ events: opts.seedCandidates }), 'utf8');
  } else {
    await fs.writeFile(candidatesFile, JSON.stringify({ events: [] }), 'utf8');
  }
  appBundle = await createApp(Object.assign({
    storeBundle,
    adminUsername: 'tristen',
    adminPassword: 'pw',
    adminSessionSecret: 'test-secret',
    trustProxy: false,
    githubToken: null,
    candidatesFile,
    eventsFile
  }, opts));
  server = http.createServer(appBundle.app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return appBundle;
}

async function stopApp() {
  if (server) await new Promise(r => server.close(r));
  if (tmpDir) try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  server = null; tmpDir = null; appBundle = null; baseUrl = null;
}

function fetchJson(method, p, body, headers) {
  const init = { method, headers: Object.assign({}, headers || {}) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  return fetch(baseUrl + p, init).then(async r => {
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, json };
  });
}

async function loginToken() {
  const r = await fetchJson('POST', '/api/admin/login',
    { username: 'tristen', password: 'pw' });
  return r.json.token;
}

const VALID_EDIT = {
  name: 'Patient Experience Week at DeTar',
  date: '2026-04-27',
  time: '1:00 PM',
  end_time: '4:00 PM',
  venue: 'DeTar Hospital',
  address: '506 E San Antonio St, Victoria, TX 77901',
  description: 'Celebrating National Patient Experience Week with talks and food.',
  url: 'https://detarhealthcare.com/events/patient-experience',
  icons: ['community', 'free'],
  free: true
};

describe('validateEventEdit', () => {
  it('accepts a fully-populated, valid edit', () => {
    const v = validateEventEdit(VALID_EDIT);
    expect(v.ok).toBe(true);
    expect(v.data.name).toBe(VALID_EDIT.name);
    expect(v.data.icons).toContain('free');
  });

  it('rejects missing required fields with per-field messages', () => {
    const v = validateEventEdit({});
    expect(v.ok).toBe(false);
    expect(v.errors.name).toBeDefined();
    expect(v.errors.date).toBeDefined();
    expect(v.errors.time).toBeDefined();
    expect(v.errors.venue).toBeDefined();
    expect(v.errors.description).toBeDefined();
  });

  it('rejects malformed dates', () => {
    const v = validateEventEdit({ ...VALID_EDIT, date: '04/27/2026' });
    expect(v.ok).toBe(false);
    expect(v.errors.date).toMatch(/YYYY-MM-DD/);
  });

  it('rejects javascript: URLs', () => {
    const v = validateEventEdit({ ...VALID_EDIT, url: 'javascript:alert(1)' });
    expect(v.ok).toBe(false);
    expect(v.errors.url).toBeDefined();
  });

  it('normalises bare hostnames into https://', () => {
    const v = validateEventEdit({ ...VALID_EDIT, url: 'example.com/foo' });
    expect(v.ok).toBe(true);
    expect(v.data.url).toBe('https://example.com/foo');
  });

  it('drops unknown icons and dedupes the array', () => {
    const v = validateEventEdit({
      ...VALID_EDIT,
      icons: ['music', 'music', 'bogus', 'free']
    });
    expect(v.ok).toBe(true);
    expect(v.data.icons).toEqual(expect.arrayContaining(['music', 'free']));
    expect(v.data.icons).not.toContain('bogus');
  });

  it('auto-adds the free icon when free is true', () => {
    const v = validateEventEdit({ ...VALID_EDIT, icons: ['music'], free: true });
    expect(v.ok).toBe(true);
    expect(v.data.icons).toContain('free');
  });
});

describe('applyEventEdits helper', () => {
  it('replaces an event matching original_key with the edited payload', () => {
    const events = [
      { date: '2026-04-27', name: 'Old Name', venue: 'Old Hall', time: '7pm' },
      { date: '2026-04-28', name: 'Untouched', venue: 'Other' }
    ];
    const edits = [{
      original_key: '2026-04-27|Old Name|Old Hall',
      payload: { date: '2026-04-27', name: 'New Name', venue: 'Old Hall', time: '8pm' }
    }];
    const out = applyEventEdits(events, edits);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('New Name');
    expect(out[0].time).toBe('8pm');
    expect(out[1].name).toBe('Untouched');
  });

  it('dedupes when an edit produces a key that collides with another event', () => {
    const events = [
      { date: '2026-04-27', name: 'Bingo', venue: 'Palace' },
      { date: '2026-04-27', name: 'Bingo Night', venue: 'Palace' }
    ];
    const edits = [{
      original_key: '2026-04-27|Bingo Night|Palace',
      payload: { date: '2026-04-27', name: 'Bingo', venue: 'Palace' }
    }];
    const out = applyEventEdits(events, edits);
    // Both rows now have the same key — only one should survive.
    expect(out).toHaveLength(1);
  });

  it('returns the events unchanged when there are no edits', () => {
    const events = [{ date: '2026-04-27', name: 'A', venue: 'B' }];
    expect(applyEventEdits(events, [])).toEqual(events);
  });
});

describe('eventKeyOf', () => {
  it('joins date|name|venue, defaulting blanks to empty strings', () => {
    expect(eventKeyOf({ date: 'd', name: 'n', venue: 'v' })).toBe('d|n|v');
    expect(eventKeyOf({ date: 'd' })).toBe('d||');
    expect(eventKeyOf(null)).toBe('||');
  });
});

describe('POST /api/admin/event-edits', () => {
  afterEach(stopApp);

  it('requires admin auth', async () => {
    await startApp();
    const r = await fetchJson('POST', '/api/admin/event-edits', {
      original_key: 'd|n|v', payload: VALID_EDIT
    });
    expect(r.status).toBe(401);
  });

  it('rejects a malformed original_key', async () => {
    await startApp();
    const tok = await loginToken();
    const r = await fetchJson('POST', '/api/admin/event-edits',
      { original_key: 'no-pipes', payload: VALID_EDIT },
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('bad-original-key');
  });

  it('returns per-field validation errors with 400', async () => {
    await startApp();
    const tok = await loginToken();
    const r = await fetchJson('POST', '/api/admin/event-edits',
      { original_key: 'd|n|v', payload: { name: '', date: '', time: '', venue: '', description: '' } },
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(400);
    expect(r.json.errors).toBeDefined();
    expect(r.json.errors.name).toBeDefined();
    expect(r.json.errors.date).toBeDefined();
  });

  it('persists an edit and reports the new event key', async () => {
    await startApp();
    const tok = await loginToken();
    const r = await fetchJson('POST', '/api/admin/event-edits', {
      original_key: '2026-04-27|Old Name|DeTar Hospital',
      payload: VALID_EDIT
    }, { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.edit.original_key).toBe('2026-04-27|Old Name|DeTar Hospital');
    expect(r.json.edit.payload.name).toBe(VALID_EDIT.name);
    expect(typeof r.json.edit.updated_at).toBe('string');
    expect(r.json.new_key).toBe('2026-04-27|Patient Experience Week at DeTar|DeTar Hospital');
  });

  it('upserts on the same original_key (does not stack overlays)', async () => {
    await startApp();
    const tok = await loginToken();
    await fetchJson('POST', '/api/admin/event-edits', {
      original_key: '2026-04-27|Old|DeTar',
      payload: { ...VALID_EDIT, name: 'First Edit', venue: 'DeTar' }
    }, { Authorization: 'Bearer ' + tok });
    await fetchJson('POST', '/api/admin/event-edits', {
      original_key: '2026-04-27|Old|DeTar',
      payload: { ...VALID_EDIT, name: 'Second Edit', venue: 'DeTar' }
    }, { Authorization: 'Bearer ' + tok });

    // Reach into the FileStore directly to confirm only one overlay is
    // stored — repeated edits must not accumulate.
    const edits = await appBundle.store.listEventEdits();
    expect(edits).toHaveLength(1);
    expect(edits[0].payload.name).toBe('Second Edit');
  });
});

describe('overlay applies to live data', () => {
  afterEach(stopApp);

  it('rewrites the published-events response when a matching edit exists', async () => {
    await startApp();
    const tok = await loginToken();

    const events = [
      { date: '2026-05-12', name: 'Original Name', venue: 'Palace Bingo',
        time: '6pm', description: 'Old' }
    ];
    const pub = await fetchJson('POST', '/api/admin/publish-events', { events },
      { Authorization: 'Bearer ' + tok });
    expect(pub.json.ok).toBe(true);

    await fetchJson('POST', '/api/admin/event-edits', {
      original_key: '2026-05-12|Original Name|Palace Bingo',
      payload: {
        name: 'Corrected Bingo Night',
        date: '2026-05-12',
        time: '6:30 PM',
        end_time: '10:30 PM',
        venue: 'Palace Bingo',
        address: '5306 Houston Hwy',
        description: 'Updated description.',
        url: '',
        icons: ['community'],
        free: false
      }
    }, { Authorization: 'Bearer ' + tok });

    const r = await fetchJson('GET', '/api/admin/published-events', undefined,
      { Authorization: 'Bearer ' + tok });
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(1);
    expect(r.json.events[0].name).toBe('Corrected Bingo Night');
    expect(r.json.events[0].time).toBe('6:30 PM');
    expect(r.json.events[0].end_time).toBe('10:30 PM');
  });

  it('public /events.json reflects the overlay too', async () => {
    await startApp();
    const tok = await loginToken();
    const events = [
      { date: '2026-05-12', name: 'Typo Eveent', venue: 'Hall' }
    ];
    await fetchJson('POST', '/api/admin/publish-events', { events },
      { Authorization: 'Bearer ' + tok });
    await fetchJson('POST', '/api/admin/event-edits', {
      original_key: '2026-05-12|Typo Eveent|Hall',
      payload: {
        name: 'Fixed Event',
        date: '2026-05-12',
        time: '6 PM',
        venue: 'Hall',
        description: 'desc here'
      }
    }, { Authorization: 'Bearer ' + tok });

    const r = await fetch(baseUrl + '/events.json');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe('Fixed Event');
  });

  it('candidates and published-events agree on identity after overlay edits', async () => {
    // The user-reported bug: after editing an event, candidates show the
    // post-edit shape (because the candidates endpoint applies the overlay),
    // but published-events still showed the pre-edit shape — so the admin
    // picker rendered the row unchecked even though the live site had it.
    //
    // This test reproduces the scenario end-to-end: seed the same event in
    // candidates.json AND publish it, edit it via the overlay, then assert
    // that BOTH /api/admin/candidates and /api/admin/published-events return
    // the same eventKey for the same row. The admin picker pre-checks rows
    // by intersecting these two key sets.
    const original = {
      date: '2026-05-15', name: 'Original Title', venue: 'Town Hall'
    };
    await startApp({ seedCandidates: [original] });
    const tok = await loginToken();

    // Publish the same event so the local store has a published payload.
    await fetchJson('POST', '/api/admin/publish-events',
      { events: [original] }, { Authorization: 'Bearer ' + tok });

    // Now edit it. The overlay's original_key is the pre-edit identity; the
    // payload changes the name (so the post-edit identity is different).
    const newPayload = {
      name: 'Corrected Title',
      date: '2026-05-15',
      time: '7 PM',
      venue: 'Town Hall',
      description: 'Updated description.'
    };
    await fetchJson('POST', '/api/admin/event-edits', {
      original_key: '2026-05-15|Original Title|Town Hall',
      payload: newPayload
    }, { Authorization: 'Bearer ' + tok });

    // Hit both endpoints and compare keys.
    const cand = await fetchJson('GET', '/api/admin/candidates', undefined,
      { Authorization: 'Bearer ' + tok });
    const pub = await fetchJson('GET', '/api/admin/published-events', undefined,
      { Authorization: 'Bearer ' + tok });
    expect(cand.status).toBe(200);
    expect(pub.status).toBe(200);

    const keyOf = (e) => [e.date || '', e.name || '', e.venue || ''].join('|');
    const candKeys = new Set(cand.json.data.events.map(keyOf));
    const pubKeys = new Set(pub.json.events.map(keyOf));
    const expectedKey = '2026-05-15|Corrected Title|Town Hall';
    // Both endpoints must surface the post-edit key — that's what makes the
    // checkbox appear pre-checked in the admin picker.
    expect(candKeys.has(expectedKey)).toBe(true);
    expect(pubKeys.has(expectedKey)).toBe(true);
  });

  it('published-events matching survives a date change in the overlay', async () => {
    const original = {
      date: '2026-06-01', name: 'Wrong Date', venue: 'Library'
    };
    await startApp({ seedCandidates: [original] });
    const tok = await loginToken();
    await fetchJson('POST', '/api/admin/publish-events',
      { events: [original] }, { Authorization: 'Bearer ' + tok });
    await fetchJson('POST', '/api/admin/event-edits', {
      original_key: '2026-06-01|Wrong Date|Library',
      payload: {
        name: 'Wrong Date',
        date: '2026-06-02', // operator fixes the date
        time: '5 PM',
        venue: 'Library',
        description: 'desc'
      }
    }, { Authorization: 'Bearer ' + tok });
    const cand = await fetchJson('GET', '/api/admin/candidates', undefined,
      { Authorization: 'Bearer ' + tok });
    const pub = await fetchJson('GET', '/api/admin/published-events', undefined,
      { Authorization: 'Bearer ' + tok });
    const keyOf = (e) => [e.date || '', e.name || '', e.venue || ''].join('|');
    const expectedKey = '2026-06-02|Wrong Date|Library';
    expect(cand.json.data.events.map(keyOf)).toContain(expectedKey);
    expect(pub.json.events.map(keyOf)).toContain(expectedKey);
  });

  it('published-events matching survives a venue/time change in the overlay', async () => {
    const original = {
      date: '2026-06-05', name: 'Open Mic', venue: 'Wrong Venue'
    };
    await startApp({ seedCandidates: [original] });
    const tok = await loginToken();
    await fetchJson('POST', '/api/admin/publish-events',
      { events: [original] }, { Authorization: 'Bearer ' + tok });
    await fetchJson('POST', '/api/admin/event-edits', {
      original_key: '2026-06-05|Open Mic|Wrong Venue',
      payload: {
        name: 'Open Mic',
        date: '2026-06-05',
        time: '8:00 PM',
        venue: 'Right Venue',
        description: 'desc'
      }
    }, { Authorization: 'Bearer ' + tok });
    const cand = await fetchJson('GET', '/api/admin/candidates', undefined,
      { Authorization: 'Bearer ' + tok });
    const pub = await fetchJson('GET', '/api/admin/published-events', undefined,
      { Authorization: 'Bearer ' + tok });
    const keyOf = (e) => [e.date || '', e.name || '', e.venue || ''].join('|');
    const expectedKey = '2026-06-05|Open Mic|Right Venue';
    expect(cand.json.data.events.map(keyOf)).toContain(expectedKey);
    expect(pub.json.events.map(keyOf)).toContain(expectedKey);
    // Keep the time on the published copy so the admin sees the corrected
    // time without having to re-publish.
    const editedPub = pub.json.events.find(e => keyOf(e) === expectedKey);
    expect(editedPub.time).toBe('8:00 PM');
  });
});
