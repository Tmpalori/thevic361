// @vitest-environment node
//
// A town's job start times (town.schedule, MULTI_CITY_PLAN.md 1.2g): it can
// move a job's start (to stagger several towns' sends and collects), never
// its day, and a bad schedule stops the boot.

import { describe, it, expect, afterAll } from 'vitest';
import { townConfig, useTown, VICTORIA } from '../server/town.js';
import { JOBS, dueSlot, lastSlot, startOf, startLabel, checkTownSchedule } from '../server/scheduler.js';

const BAY = { id: 'bay', siteName: 'The Bay 979', domain: 'thebay979.com', city: 'Bay City', state: 'TX', stateName: 'Texas', timezone: 'America/Chicago' };
const job = name => JOBS.find(j => j.name === name);
// Monday Oct 5, 2026, in Central time (UTC-5).
const at = hhmm => new Date(`2026-10-05T${hhmm}:00-05:00`);

afterAll(() => useTown(VICTORIA));

describe('Victoria', () => {
  it('runs the default times', () => {
    useTown(VICTORIA);
    expect(VICTORIA.schedule).toEqual({});
    expect(startOf(job('newsletter'))).toBe('07:43');
    expect([startLabel('newsletter'), startLabel('newsletter-weekend')]).toEqual(['7:43 AM', '7:00 AM']);
    expect(dueSlot(job('newsletter'), at('07:42'))).toBe(null);
    expect(dueSlot(job('newsletter'), at('07:43'))).toBe('2026-10-05');
  });
});

describe('another town', () => {
  it('starts a job at its own time, on the same day', () => {
    useTown(townConfig({}, { town: { ...BAY, schedule: { newsletter: '07:13', 'social-kit': '09:17' } } }));
    expect(startOf(job('newsletter'))).toBe('07:13');
    expect(startOf(job('newsletter-weekend'))).toBe('07:00');   // not moved
    expect(startLabel('newsletter')).toBe('7:13 AM');
    expect(dueSlot(job('newsletter'), at('07:12'))).toBe(null);
    expect(dueSlot(job('newsletter'), at('07:13'))).toBe('2026-10-05');
    expect(lastSlot(job('newsletter'), at('07:20'))).toBe('2026-10-05');
    expect(dueSlot(job('newsletter'), new Date('2026-10-06T12:13:00Z'))).toBe(null); // Tuesday: still Mondays only
    expect(dueSlot(job('social-kit'), at('09:00'))).toBe(null);
    expect(dueSlot(job('social-kit'), at('09:17'))).toBe('2026-10-05');
    expect(() => checkTownSchedule()).not.toThrow();
  });

  it('a bad schedule stops the boot', () => {
    expect(() => townConfig({}, { town: { ...BAY, schedule: { newsletter: '7:13' } } })).toThrow(/HH:MM/);
    expect(() => townConfig({}, { town: { ...BAY, schedule: { newsletter: '24:00' } } })).toThrow(/HH:MM/);
    useTown(townConfig({}, { town: { ...BAY, schedule: { newsleter: '07:13' } } }));
    expect(() => checkTownSchedule()).toThrow(/newsleter isn't a daily or weekly job/);
    useTown(townConfig({}, { town: { ...BAY, schedule: { health: '07:13' } } }));
    expect(() => checkTownSchedule()).toThrow(/health isn't/);
    useTown(townConfig({}, { town: { ...BAY, schedule: { newsletter: '13:00' } } }));
    expect(() => checkTownSchedule()).toThrow(/after its cutoff \(12:00\)/);
  });
});
