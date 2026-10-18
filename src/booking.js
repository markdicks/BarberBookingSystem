import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { candidateSlots, isValidDate, serviceByKey, surchargeForTime, ZONE } from './config.js';
import { isUniqueError, query, transaction } from './db.js';

export async function availableSlots(date) {
  if (!isValidDate(date)) return [];
  const candidates = candidateSlots(date);
  if (!candidates.length) return [];
  const taken = await query("SELECT slot_time FROM bookings WHERE slot_date = ? AND status = 'confirmed'", [date]);
  const unavailable = new Set(taken.map(row => row.slot_time));
  return candidates.filter(time => !unavailable.has(time));
}

export async function createBooking(customerId, date, time, serviceKey, source = 'website') {
  const service = serviceByKey(serviceKey);
  if (!service) throw Object.assign(new Error('Please choose a service.'), { status: 400 });
  if (!candidateSlots(date).includes(time)) {
    const error = new Error('Please choose an available future time.');
    error.status = 400;
    throw error;
  }
  try {
    return await transaction(async client => {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const surcharge = surchargeForTime(time);
      await query('INSERT INTO bookings (id, customer_id, slot_date, slot_time, slot_key, service_key, price_zar, surcharge_zar, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, customerId, date, time, `${date}T${time}`, serviceKey, service.price, surcharge, 'confirmed', source, createdAt], client);
      return { id, date, time, service: service.name, total: service.price + surcharge, status: 'confirmed' };
    });
  } catch (error) {
    if (isUniqueError(error)) {
      const conflict = new Error('That time has just been booked. Please choose another.');
      conflict.status = 409;
      throw conflict;
    }
    throw error;
  }
}

export async function bookingsForCustomer(customerId) {
  return query('SELECT id, slot_date AS date, slot_time AS time, service_key AS serviceKey, price_zar AS price, surcharge_zar AS surcharge, cancellation_fee_zar AS cancellationFee, status, source FROM bookings WHERE customer_id = ? ORDER BY slot_date DESC, slot_time DESC LIMIT 50', [customerId]);
}

export async function cancelBooking(customerId, bookingId) {
  return transaction(async client => {
    const rows = await query('SELECT id, slot_date, slot_time, status FROM bookings WHERE id = ? AND customer_id = ?', [bookingId, customerId], client);
    const booking = rows[0];
    if (!booking || booking.status !== 'confirmed') return null;
    const appointment = DateTime.fromISO(`${booking.slot_date}T${booking.slot_time}`, { zone: ZONE });
    const hours = appointment.diffNow('hours').hours;
    if (hours <= 0) return null;
    const fee = hours < 3 ? 80 : 0;
    await query("UPDATE bookings SET status = 'cancelled', slot_key = NULL, cancellation_fee_zar = ? WHERE id = ? AND customer_id = ?", [fee, bookingId, customerId], client);
    return { cancellationFee: fee };
  });
}
