import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import app from '../app.js';
import { closeDb, initDb } from '../src/db.js';
import { ZONE } from '../src/config.js';

let server;
let base;
let tempDir;
before(async () => {
  process.env.NODE_ENV = 'test';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'braam-booking-test-'));
  process.env.BOOKING_DB_PATH = path.join(tempDir, 'test.sqlite');
  await initDb();
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(route, options = {}) {
  const response = await fetch(`${base}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  return { response, data: await response.json() };
}

test('first visit verifies, books, blocks a duplicate, and releases a cancelled slot', async () => {
  let date;
  let time;
  for (let offset = 1; offset < 8; offset++) {
    date = DateTime.now().setZone(ZONE).plus({ days: offset }).toISODate();
    const result = await request(`/api/availability?date=${date}`);
    if (result.data.slots.length) { time = result.data.slots[0]; break; }
  }
  assert.ok(time, 'at least one slot opens in the next week');
  let printed = '';
  const originalLog = console.log;
  console.log = (value) => { printed += value; };
  try {
    const started = await request('/api/auth/start', { method: 'POST', body: JSON.stringify({ phone: '072 123 4567' }) });
    assert.equal(started.response.status, 200);
  } finally { console.log = originalLog; }
  const code = printed.match(/: (\d{6})$/)?.[1];
  assert.ok(code);
  const verified = await request('/api/auth/verify', { method: 'POST', body: JSON.stringify({ phone: '072 123 4567', name: 'Test Customer', code }) });
  assert.equal(verified.response.status, 200);
  const cookie = verified.response.headers.get('set-cookie').split(';')[0];
  const bookingData = { date, time, serviceKey: 'full-cut' };
  const first = await request('/api/bookings', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(bookingData) });
  assert.equal(first.response.status, 201);
  assert.equal(first.data.booking.total, time >= '19:00' ? 170 : time >= '18:00' ? 160 : 150);
  const duplicate = await request('/api/bookings', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(bookingData) });
  assert.equal(duplicate.response.status, 409);
  const cancelled = await request(`/api/bookings/${first.data.booking.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(cancelled.response.status, 200);
  const second = await request('/api/bookings', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(bookingData) });
  assert.equal(second.response.status, 201);
});

test('WhatsApp chat quotes a price and waits for confirmation before booking', async () => {
  let counter = 0;
  async function say(body, sid = `SM-test-${++counter}`) {
    const response = await fetch(`${base}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: 'whatsapp:+27721234568', Body: body, MessageSid: sid })
    });
    assert.equal(response.status, 200);
    return response.text();
  }
  assert.match(await say('BOOK'), /Choose a service/);
  assert.match(await say('5'), /Line ups/);
  let date;
  let time;
  for (let offset = 1; offset < 8; offset++) {
    const candidate = DateTime.now().setZone(ZONE).plus({ days: offset }).toISODate();
    const result = await request(`/api/availability?date=${candidate}`);
    if (result.data.slots.length) { date = candidate; time = result.data.slots.at(-1); break; }
  }
  assert.ok(date);
  assert.match(await say(date), /Available 30-minute starts/);
  assert.match(await say(time), /What name/);
  const quote = await say('WhatsApp Customer');
  assert.match(quote, /Reply YES to confirm/);
  const before = await request(`/api/availability?date=${date}`);
  assert.ok(before.data.slots.includes(time));
  const confirmation = await say('YES', 'SM-final-confirm');
  assert.match(confirmation, /Booked, WhatsApp Customer/);
  assert.equal(await say('YES', 'SM-final-confirm'), confirmation);
  const afterBooking = await request(`/api/availability?date=${date}`);
  assert.ok(!afterBooking.data.slots.includes(time));
});
