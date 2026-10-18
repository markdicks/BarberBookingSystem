import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import { normalizePhone, safeName } from './config.js';
import { query } from './db.js';

const localCodes = new Map();
const requests = new Map();
const COOKIE = 'bsb_session';
const SESSION_DAYS = 30;

function twilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

export function validateProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  for (const key of ['DATABASE_URL', 'PUBLIC_BASE_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID']) {
    if (!process.env[key]) throw new Error(`${key} is required in production.`);
  }
  if (!process.env.PUBLIC_BASE_URL.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export async function requestCode(phoneInput, ip = '') {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw Object.assign(new Error('Enter a valid mobile number.'), { status: 400 });
  const now = Date.now();
  for (const [key, value] of requests) if (now - value > 3600000) requests.delete(key);
  for (const key of [phone, `ip:${ip}`]) {
    const last = requests.get(key);
    if (last && now - last < 60000) throw Object.assign(new Error('Please wait a minute before requesting another code.'), { status: 429 });
  }
  if (process.env.NODE_ENV === 'production') {
    await twilioClient().verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: phone, channel: 'whatsapp' });
  } else {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    localCodes.set(phone, { hash: hash(code), expires: now + 10 * 60000, attempts: 0 });
    console.log(`Development OTP for ${phone}: ${code}`);
  }
  requests.set(phone, now);
  requests.set(`ip:${ip}`, now);
  return phone;
}

async function verifyCode(phone, code) {
  if (!/^\d{4,8}$/.test(String(code || ''))) return false;
  if (process.env.NODE_ENV === 'production') {
    const result = await twilioClient().verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({ to: phone, code: String(code) });
    return result.status === 'approved';
  }
  const record = localCodes.get(phone);
  if (!record || record.expires < Date.now() || record.attempts >= 5) return false;
  record.attempts++;
  const good = timingSafeEqual(Buffer.from(record.hash), Buffer.from(hash(String(code))));
  if (good) localCodes.delete(phone);
  return good;
}

export async function customerByPhone(phone) {
  return (await query('SELECT id, phone, name FROM customers WHERE phone = ?', [phone]))[0] || null;
}

export async function ensureCustomer(phone, name) {
  const existing = await customerByPhone(phone);
  if (existing) return existing;
  const cleanName = safeName(name);
  if (!cleanName) throw Object.assign(new Error('Enter your name to create your account.'), { status: 400 });
  const id = randomUUID();
  try {
    await query('INSERT INTO customers (id, phone, name, created_at) VALUES (?, ?, ?, ?)', [id, phone, cleanName, new Date().toISOString()]);
    return { id, phone, name: cleanName };
  } catch (error) {
    const raced = await customerByPhone(phone);
    if (raced) return raced;
    throw error;
  }
}

export async function authenticate(phoneInput, code, name) {
  const phone = normalizePhone(phoneInput);
  if (phone && !(await customerByPhone(phone)) && !safeName(name)) {
    throw Object.assign(new Error('Enter your name to create your account.'), { status: 400 });
  }
  if (!phone || !(await verifyCode(phone, code))) {
    throw Object.assign(new Error('The code is incorrect or expired.'), { status: 401 });
  }
  const customer = await ensureCustomer(phone, name);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await query('INSERT INTO sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)', [hash(token), customer.id, expiresAt]);
  return { customer, token };
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: SESSION_DAYS * 86400000, path: '/' });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
}

function readCookie(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)bsb_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function currentCustomer(req) {
  const token = readCookie(req);
  if (!token) return null;
  const rows = await query('SELECT customers.id, customers.phone, customers.name FROM sessions JOIN customers ON customers.id = sessions.customer_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?', [hash(token), new Date().toISOString()]);
  return rows[0] || null;
}

export async function logout(req) {
  const token = readCookie(req);
  if (token) await query('DELETE FROM sessions WHERE token_hash = ?', [hash(token)]);
}
