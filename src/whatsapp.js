import twilio from 'twilio';
import { DateTime } from 'luxon';
import { BOOKING_DAYS_AHEAD, SERVICES, ZONE, normalizePhone, safeName, serviceByKey } from './config.js';
import { availableSlots, bookingsForCustomer, cancelBooking, createBooking } from './booking.js';
import { customerByPhone, ensureCustomer } from './auth.js';
import { query } from './db.js';

export function validTwilioRequest(req) {
  if (process.env.NODE_ENV !== 'production') return true;
  const signature = req.headers['x-twilio-signature'];
  const url = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/whatsapp/webhook`;
  return Boolean(signature && twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body));
}

function twiml(message) {
  const response = new twilio.twiml.MessagingResponse();
  response.message(message);
  return response.toString();
}

async function getState(phone) {
  return (await query('SELECT step, service_key, slot_date, slot_time FROM chat_state WHERE phone = ?', [phone]))[0] || null;
}

async function setState(phone, step, serviceKey = null, date = null, time = null) {
  await query('INSERT INTO chat_state (phone, step, service_key, slot_date, slot_time, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (phone) DO UPDATE SET step = excluded.step, service_key = excluded.service_key, slot_date = excluded.slot_date, slot_time = excluded.slot_time, updated_at = excluded.updated_at',
    [phone, step, serviceKey, date, time, new Date().toISOString()]);
}

async function upcomingDates() {
  const now = DateTime.now().setZone(ZONE);
  const dates = [];
  for (let offset = 0; offset <= BOOKING_DAYS_AHEAD && dates.length < 7; offset++) {
    const day = now.plus({ days: offset }).toISODate();
    if ((await availableSlots(day)).length) dates.push(day);
  }
  return dates;
}

function serviceMenu() {
  return `Welcome to Braam Street Barbers. Choose a service:\n${SERVICES.map((s, i) => `${i + 1}. ${s.name} — R${s.price}`).join('\n')}\nReply with a number. All bookings are 30 minutes. Reply RESET to restart.`;
}

function confirmation(state) {
  const service = serviceByKey(state.service_key);
  const extra = state.slot_time >= '20:00' ? 30 : state.slot_time >= '19:00' ? 20 : state.slot_time >= '18:00' ? 10 : 0;
  return `${service.name} on ${state.slot_date} at ${state.slot_time}. Total R${service.price + extra}${extra ? ` (includes R${extra} after-hours)` : ''}. Late arrival (7+ min): R30. Cancellation within 3 hours or no-show: R80. Reply YES to confirm or RESET to start again.`;
}

async function replyTo(phone, body) {
  const input = body.trim();
  const command = input.toUpperCase();
  if (['BOOK', 'HI', 'HELLO', 'START', 'RESET'].includes(command)) {
    await setState(phone, 'service');
    return serviceMenu();
  }
  if (command === 'MY BOOKINGS') {
    const customer = await customerByPhone(phone);
    if (!customer) return 'No bookings found yet. Reply BOOK to make one.';
    const items = (await bookingsForCustomer(customer.id)).filter(b => b.status === 'confirmed' && DateTime.fromISO(`${b.date}T${b.time}`, { zone: ZONE }) > DateTime.now().setZone(ZONE));
    return items.length ? `Your upcoming bookings:\n${items.slice(0, 5).map(b => `${b.date} at ${b.time} — ${serviceByKey(b.serviceKey)?.name || b.serviceKey}`).join('\n')}\nReply CANCEL to cancel one.` : 'No upcoming bookings. Reply BOOK to make one.';
  }
  if (command === 'CANCEL') {
    const customer = await customerByPhone(phone);
    if (!customer) return 'No bookings found. Reply BOOK to make one.';
    const items = (await bookingsForCustomer(customer.id)).filter(b => b.status === 'confirmed' && DateTime.fromISO(`${b.date}T${b.time}`, { zone: ZONE }) > DateTime.now().setZone(ZONE)).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).slice(0, 5);
    if (!items.length) return 'No upcoming bookings to cancel.';
    await setState(phone, 'cancel');
    return `Which booking should we cancel?\n${items.map((b, i) => `${i + 1}. ${b.date} at ${b.time} — ${serviceByKey(b.serviceKey)?.name || b.serviceKey}`).join('\n')}\nReply with a number. A R80 fee applies within 3 hours.`;
  }

  const state = await getState(phone);
  if (!state) return 'Reply BOOK to make an appointment, MY BOOKINGS to see yours, or CANCEL to cancel.';
  if (state.step === 'service') {
    const service = SERVICES[Number(input) - 1];
    if (!service || !/^[1-5]$/.test(input)) return serviceMenu();
    await setState(phone, 'date', service.key);
    const dates = await upcomingDates();
    return `Great, ${service.name}. Send a date in YYYY-MM-DD format. Available dates include:\n${dates.join('\n')}`;
  }
  if (state.step === 'date') {
    const slots = await availableSlots(input);
    if (!slots.length) return 'No openings on that date. Please send another date in YYYY-MM-DD format.';
    await setState(phone, 'time', state.service_key, input);
    return `Available 30-minute starts on ${input}:\n${slots.join('  ')}\nReply with a time in HH:mm format.`;
  }
  if (state.step === 'time') {
    const slots = await availableSlots(state.slot_date);
    if (!slots.includes(input)) return `That time is unavailable. Choose one of:\n${slots.join('  ')}`;
    const customer = await customerByPhone(phone);
    if (!customer) {
      await setState(phone, 'name', state.service_key, state.slot_date, input);
      return 'What name should we put on your booking?';
    }
    await setState(phone, 'confirm', state.service_key, state.slot_date, input);
    return confirmation({ ...state, slot_time: input });
  }
  if (state.step === 'name') {
    const name = safeName(input);
    if (!name) return 'Please send your name (2–80 characters).';
    await ensureCustomer(phone, name);
    await setState(phone, 'confirm', state.service_key, state.slot_date, state.slot_time);
    return confirmation(state);
  }
  if (state.step === 'confirm') {
    if (command !== 'YES') return 'Reply YES to confirm, or RESET to start again.';
    const customer = await customerByPhone(phone);
    const booking = await createBooking(customer.id, state.slot_date, state.slot_time, state.service_key, 'whatsapp');
    await setState(phone, 'idle');
    return `Booked, ${customer.name}! ${booking.service} on ${booking.date} at ${booking.time}. Total R${booking.total}. See you at 1 Braam Street, Alberton. Reply MY BOOKINGS any time.`;
  }
  if (state.step === 'cancel') {
    const customer = await customerByPhone(phone);
    const items = (await bookingsForCustomer(customer.id)).filter(b => b.status === 'confirmed' && DateTime.fromISO(`${b.date}T${b.time}`, { zone: ZONE }) > DateTime.now().setZone(ZONE)).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).slice(0, 5);
    const selected = items[Number(input) - 1];
    if (!selected || !/^\d$/.test(input)) return 'Please reply with the booking number shown, or BOOK to start over.';
    const result = await cancelBooking(customer.id, selected.id);
    await setState(phone, 'idle');
    return result ? `Your ${selected.date} at ${selected.time} booking is cancelled.${result.cancellationFee ? ' A R80 late cancellation fee applies.' : ''}` : 'That booking could not be cancelled.';
  }
  return 'Reply BOOK to make an appointment, MY BOOKINGS to see yours, or CANCEL to cancel.';
}

export async function whatsappWebhook(req, res) {
  if (!validTwilioRequest(req)) return res.sendStatus(403);
  const phone = normalizePhone(String(req.body.From || '').replace(/^whatsapp:/, ''));
  if (!phone) return res.sendStatus(400);
  const sid = String(req.body.MessageSid || '');
  const previous = sid ? (await query('SELECT response_text FROM processed_messages WHERE sid = ?', [sid]))[0] : null;
  if (previous) return res.type('text/xml').send(twiml(previous.response_text));
  let response;
  try { response = await replyTo(phone, String(req.body.Body || '')); }
  catch (error) {
    if (error.status === 409) response = 'That slot was just taken. Reply BOOK to choose another.';
    else throw error;
  }
  if (sid) await query('INSERT INTO processed_messages (sid, response_text, processed_at) VALUES (?, ?, ?)', [sid, response, new Date().toISOString()]);
  res.type('text/xml').send(twiml(response));
}
