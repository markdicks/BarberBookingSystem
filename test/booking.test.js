import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import app from '../src/app.js';
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

test('first visit creates an account, books, blocks a duplicate, and releases a cancelled slot', async () => {
  let date;
  let time;
  for (let offset = 1; offset < 8; offset++) {
    date = DateTime.now().setZone(ZONE).plus({ days: offset }).toISODate();
    const result = await request(`/api/availability?date=${date}`);
    if (result.data.slots.length) { time = result.data.slots[0]; break; }
  }
  assert.ok(time, 'at least one slot opens in the next week');
  const registered = await request('/api/auth/access', { method: 'POST', body: JSON.stringify({ phone: '072 123 4567', name: 'Test Customer', password: 'correct horse staple' }) });
  assert.equal(registered.response.status, 200);
  const cookie = registered.response.headers.get('set-cookie').split(';')[0];
  const badLogin = await request('/api/auth/access', { method: 'POST', body: JSON.stringify({ phone: '072 123 4567', password: 'wrong password' }) });
  assert.equal(badLogin.response.status, 401);
  const returning = await request('/api/auth/access', { method: 'POST', body: JSON.stringify({ phone: '072 123 4567', password: 'correct horse staple' }) });
  assert.equal(returning.response.status, 200);
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
  const remaining = await request(`/api/availability?date=${date}`);
  const concurrentData = { ...bookingData, time: remaining.data.slots[0] };
  const attempts = await Promise.all([1, 2].map(() => request('/api/bookings', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(concurrentData) })));
  assert.deepEqual(attempts.map(attempt => attempt.response.status).sort(), [201, 409]);
});
