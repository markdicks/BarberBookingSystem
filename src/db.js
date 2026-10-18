import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const postgres = Boolean(process.env.DATABASE_URL);
let pool;
let sqlite;
let sqliteQueue = Promise.resolve();

const schema = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), slot_date TEXT NOT NULL,
  slot_time TEXT NOT NULL, service_key TEXT NOT NULL, price_zar INTEGER NOT NULL,
  surcharge_zar INTEGER NOT NULL, cancellation_fee_zar INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed', source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings(slot_date, slot_time) WHERE status = 'confirmed';
CREATE TABLE IF NOT EXISTS chat_state (
  phone TEXT PRIMARY KEY, step TEXT NOT NULL, service_key TEXT, slot_date TEXT, slot_time TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_messages (
  sid TEXT PRIMARY KEY, response_text TEXT NOT NULL, processed_at TEXT NOT NULL
);
`;

function pgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function initDb() {
  if (postgres) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
      max: 5
    });
    const client = await pool.connect();
    try { for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await client.query(statement); }
    finally { client.release(); }
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production.');
    const filename = path.resolve(process.env.BOOKING_DB_PATH || 'data/bookings.sqlite');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    sqlite = new DatabaseSync(filename);
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    sqlite.exec(schema);
  }
}

export async function query(sql, params = [], client = null) {
  if (postgres) {
    const result = await (client || pool).query(pgSql(sql), params);
    return result.rows;
  }
  const statement = sqlite.prepare(sql);
  if (/^\s*(SELECT|WITH)\b/i.test(sql)) return statement.all(...params);
  statement.run(...params);
  return [];
}

export async function transaction(fn) {
  if (postgres) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  let release;
  const previous = sqliteQueue;
  sqliteQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(null);
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  } finally {
    release();
  }
}

export function isUniqueError(error) {
  return error?.code === '23505' || String(error?.code || '').startsWith('SQLITE_CONSTRAINT') ||
    /UNIQUE constraint failed/i.test(String(error?.message || ''));
}

export async function closeDb() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}
