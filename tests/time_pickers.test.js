// Start/end times are chosen from a list (required start, optional end) on
// the Vic's Pick form and the admin event editor, like the submit form.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { renderCheckoutPage, validateOrder, renderPreview, timeChoice, TIME_CHOICES } from '../server/sponsors.js';

const NOW = new Date('2026-10-08T15:00:00Z');
const featured = { key: 'featured', name: 'Vic’s Pick', price: '$15', blurb: '' };

function page(values = {}) {
  const html = renderCheckoutPage(featured, { siteUrl: 'https://x', now: NOW, orders: [], venues: [], values });
  return new JSDOM(html).window.document;
}

describe('Vic’s Pick form times', () => {
  it('has a required start select and an optional end select with the submit form’s choices', () => {
    const doc = page();
    const start = doc.querySelector('select[name="time"]');
    const end = doc.querySelector('select[name="end_time"]');
    expect(start.required).toBe(true);
    expect(end.required).toBe(false);
    const opts = Array.from(start.options).map(o => o.value);
    expect(opts[0]).toBe('');
    expect(opts.slice(1)).toEqual(TIME_CHOICES);
    expect(TIME_CHOICES[0]).toBe('5:00 AM');
    expect(TIME_CHOICES).toContain('12:00 PM');
    expect(TIME_CHOICES[TIME_CHOICES.length - 1]).toBe('1:30 AM');
    expect(doc.querySelector('input[name="time"]')).toBeNull();
  });

  it('a prefilled time selects its choice; an off-list one is kept', () => {
    expect(timeChoice('06:30 PM')).toBe('6:30 PM');
    expect(timeChoice('7pm')).toBe('7:00 PM');
    let doc = page({ time: '06:30 PM', end_time: '9:00 PM' });
    expect(doc.querySelector('select[name="time"]').value).toBe('6:30 PM');
    expect(doc.querySelector('select[name="end_time"]').value).toBe('9:00 PM');
    doc = page({ time: '6:45 PM' });
    expect(doc.querySelector('select[name="time"]').value).toBe('6:45 PM');
  });

  it('the order keeps the end time and the preview shows it', () => {
    const v = validateOrder('featured', {
      event_name: 'Show', date: '2026-10-12', time: '7:00 PM', end_time: '9:00 PM', venue: 'Hall', address: '1 Main St',
      description: 'A show.', business: 'Me', email: 'me@example.com'
    }, { now: NOW, orders: [], venues: [] });
    expect(v.ok).toBe(true);
    expect(v.order.event).toMatchObject({ time: '7:00 PM', end_time: '9:00 PM' });
    expect(renderPreview('featured', { time: '7:00 PM', end_time: '9:00 PM', date: '2026-10-12' }, { now: NOW })).toContain('9');
  });

  it('a missing start time is still an error', () => {
    const v = validateOrder('featured', {
      event_name: 'Show', date: '2026-10-12', time: '', venue: 'Hall', description: 'A show.', business: 'Me', email: 'me@example.com'
    }, { now: NOW, orders: [], venues: [] });
    expect(v.ok).toBe(false);
    expect(v.errors.time).toBeTruthy();
  });
});

describe('admin event editor times', () => {
  it('uses selects for start and end', async () => {
    const html = await fs.readFile(path.join(process.cwd(), 'docs/admin.html'), 'utf8');
    const doc = new JSDOM(html).window.document;
    const form = doc.getElementById('event-edit-form');
    expect(form.querySelector('select[name="time"]').required).toBe(true);
    expect(form.querySelector('select[name="end_time"]').required).toBe(false);
  });
});
