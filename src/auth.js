import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizePhone, safeName } from './config.js';
import { isUniqueError, query } from './db.js';

const scrypt = promisify(scryptCallback);
const COOKIE = 'bsb_session';
const SESSION_DAYS = 30;
const failedLogins = new Map();

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }

export function validateProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const hasUrl = Boolean(process.env.DATABASE_URL);
  const hasSeparateValues = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].every(key => process.env[key]);
  if (!hasUrl && !hasSeparateValues) throw new Error('Set DATABASE_URL or the Hostinger DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME variables.');
  if (!process.env.PUBLIC_BASE_URL?.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be your HTTPS site URL in production.');
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  if (!validPassword(password) || !stored?.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  const actual = await scrypt(password, parts[1], 64);
  return timingSafeEqual(actual, Buffer.from(parts[2], 'hex'));
}

function checkLoginLimit(phone) {
  const recent = (failedLogins.get(phone) || []).filter(time => Date.now() - time < 15 * 60000);
  failedLogins.set(phone, recent);
  if (recent.length >= 8) throw Object.assign(new Error('Too many attempts. Try again in 15 minutes.'), { status: 429 });
}

function recordFailedLogin(phone) {
  failedLogins.set(phone, [...(failedLogins.get(phone) || []), Date.now()]);
}

export async function accessAccount(phoneInput, name, password) {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw badRequest('Enter a valid mobile number.');
  if (!validPassword(password)) throw badRequest('Use a password with 8 to 128 characters.');
  checkLoginLimit(phone);

  const existing = (await query('SELECT id, phone, name, password_hash FROM customers WHERE phone = ?', [phone]))[0];
  let customer;
  if (existing) {
    if (!existing.password_hash) throw Object.assign(new Error('This account needs a password reset. Please contact the shop.'), { status: 409 });
    if (!(await passwordMatches(password, existing.password_hash))) {
      recordFailedLogin(phone);
      throw Object.assign(new Error('Incorrect mobile number or password.'), { status: 401 });
    }
    failedLogins.delete(phone);
    customer = { id: existing.id, phone: existing.phone, name: existing.name };
  } else {
    const cleanName = safeName(name);
    if (!cleanName) throw badRequest('Enter your name to create your account.');
    const id = randomUUID();
    try {
      await query('INSERT INTO customers (id, phone, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, phone, cleanName, await passwordHash(password), new Date().toISOString()]);
    } catch (error) {
      if (isUniqueError(error)) throw Object.assign(new Error('This number already has an account. Enter its password to log in.'), { status: 409 });
      throw error;
    }
    customer = { id, phone, name: cleanName };
  }

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
