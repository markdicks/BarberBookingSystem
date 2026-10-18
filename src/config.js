import { DateTime } from 'luxon';

export const ZONE = 'Africa/Johannesburg';
export const SLOT_MINUTES = 30;
export const BOOKING_DAYS_AHEAD = 30;
export const SCHEDULE = {
  1: ['08:00', '20:00'], 2: ['08:00', '20:00'],
  3: ['08:00', '20:00'], 4: ['08:00', '20:00'],
  5: ['08:00', '17:30'], 6: ['08:00', '14:30']
};
export const ADDRESS = process.env.BUSINESS_ADDRESS || '1 Braam Street, Alberton, GP, 1449, South Africa';
export const SERVICES = [
  { key: 'full-cut', name: 'Full cut', price: 150 },
  { key: 'fade', name: 'Only Fade', price: 130 },
  { key: 'mullet-taper', name: 'Mullet taper', price: 100 },
  { key: 'beard', name: 'Full beard work', price: 20 },
  { key: 'line-up', name: 'Line ups', price: 10 }
];

export function serviceByKey(key) { return SERVICES.find(service => service.key === key); }

export function surchargeForTime(time) {
  if (time >= '20:00') return 30;
  if (time >= '19:00') return 20;
  if (time >= '18:00') return 10;
  return 0;
}

export function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') &&
    DateTime.fromISO(date, { zone: ZONE }).isValid;
}

export function candidateSlots(date, now = DateTime.now().setZone(ZONE)) {
  if (!isValidDate(date)) return [];
  const day = DateTime.fromISO(date, { zone: ZONE });
  if (day < now.startOf('day') || day > now.startOf('day').plus({ days: BOOKING_DAYS_AHEAD })) return [];
  const hours = SCHEDULE[day.weekday];
  if (!hours) return [];
  let cursor = DateTime.fromISO(`${date}T${hours[0]}`, { zone: ZONE });
  const closing = DateTime.fromISO(`${date}T${hours[1]}`, { zone: ZONE });
  const slots = [];
  while (cursor.plus({ minutes: SLOT_MINUTES }) <= closing) {
    if (cursor > now.plus({ minutes: 60 })) slots.push(cursor.toFormat('HH:mm'));
    cursor = cursor.plus({ minutes: SLOT_MINUTES });
  }
  return slots;
}

export function normalizePhone(input) {
  const cleaned = String(input || '').replace(/[\s()-]/g, '');
  const phone = cleaned.startsWith('0') ? `+27${cleaned.slice(1)}` :
    cleaned.startsWith('27') ? `+${cleaned}` : cleaned;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

export function safeName(input) {
  const name = String(input || '').trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= 80 && !/[<>\r\n]/.test(name) ? name : null;
}
