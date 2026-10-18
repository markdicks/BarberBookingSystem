import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { ADDRESS, SCHEDULE, SERVICES, SLOT_MINUTES, ZONE } from './config.js';
import { accessAccount, clearSessionCookie, currentCustomer, logout, setSessionCookie } from './auth.js';
import { availableSlots, bookingsForCustomer, cancelBooking, createBooking } from './booking.js';

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  const allowed = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  if (origin && origin !== new URL(allowed).origin) return res.status(403).json({ error: 'Request origin is not allowed.' });
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({
  businessName: 'Braam Street Barbers', address: ADDRESS, timezone: ZONE,
  slotMinutes: SLOT_MINUTES, services: SERVICES, schedule: SCHEDULE,
  today: DateTime.now().setZone(ZONE).toISODate(), maxDate: DateTime.now().setZone(ZONE).plus({ days: 30 }).toISODate(),
  whatsappNumber: process.env.BUSINESS_WHATSAPP_NUMBER || null,
  policies: { lateArrival: 'R30 after 7 minutes', lateCancellation: 'R80 within 3 hours or for a no-show', afterHours: '18:00–18:59 +R10; 19:00–19:59 +R20; 20:00+ +R30 by arrangement' }
}));
app.get('/api/availability', async (req, res) => res.json({ date: req.query.date || null, slots: await availableSlots(req.query.date) }));
app.get('/api/me', async (req, res) => res.json({ customer: await currentCustomer(req) }));
app.post('/api/auth/access', async (req, res) => {
  const { customer, token } = await accessAccount(req.body?.phone, req.body?.name, req.body?.password, req.ip);
  setSessionCookie(res, token);
  res.json({ customer });
});
app.post('/api/auth/logout', async (req, res) => {
  await logout(req);
  clearSessionCookie(res);
  res.json({ ok: true });
});
async function requireCustomer(req, res, next) {
  const customer = await currentCustomer(req);
  if (!customer) return res.status(401).json({ error: 'Please log in to continue.' });
  req.customer = customer;
  next();
}
app.get('/api/bookings', requireCustomer, async (req, res) => res.json({ bookings: await bookingsForCustomer(req.customer.id) }));
app.post('/api/bookings', requireCustomer, async (req, res) => {
  const { date, time, serviceKey } = req.body || {};
  const booking = await createBooking(req.customer.id, date, time, serviceKey);
  res.status(201).json({ booking });
});
app.delete('/api/bookings/:id', requireCustomer, async (req, res) => {
  const result = await cancelBooking(req.customer.id, req.params.id);
  if (!result) return res.status(404).json({ error: 'This booking cannot be cancelled.' });
  res.json({ ok: true, ...result });
});
app.use('/assets', express.static(path.join(root, 'public/assets'), { maxAge: '1d' }));
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
app.use((error, _req, res, _next) => {
  if (!error.status || error.status >= 500) console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong. Please try again.' });
});

export default app;
