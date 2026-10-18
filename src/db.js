import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const hosted = Boolean(process.env.DATABASE_URL || process.env.DB_HOST);
let pool;
let sqlite;
let sqliteQueue = Promise.resolve();

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), slot_date TEXT NOT NULL,
  slot_time TEXT NOT NULL, slot_key TEXT UNIQUE, service_key TEXT NOT NULL, price_zar INTEGER NOT NULL,
  surcharge_zar INTEGER NOT NULL, cancellation_fee_zar INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed', source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings(slot_date, slot_time) WHERE status = 'confirmed';
`;

const mysqlSchema = [
  `CREATE TABLE IF NOT EXISTS customers (
    id VARCHAR(36) PRIMARY KEY, phone VARCHAR(20) NOT NULL UNIQUE, name VARCHAR(80) NOT NULL,
    password_hash VARCHAR(200), created_at VARCHAR(30) NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY, customer_id VARCHAR(36) NOT NULL,
    expires_at VARCHAR(30) NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id VARCHAR(36) PRIMARY KEY, customer_id VARCHAR(36) NOT NULL,
    slot_date CHAR(10) NOT NULL, slot_time CHAR(5) NOT NULL,
    slot_key VARCHAR(16) UNIQUE, service_key VARCHAR(40) NOT NULL,
    price_zar INT NOT NULL, surcharge_zar INT NOT NULL,
    cancellation_fee_zar INT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'confirmed', source VARCHAR(20) NOT NULL,
    created_at VARCHAR(30) NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  ) ENGINE=InnoDB`
];

function mysqlOptions() {
  let options;
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must start with mysql:// for a Hostinger database.');
    options = {
      host: url.hostname, port: Number(url.port || 3306),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1))
    };
  } else {
    options = {
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    };
  }
  return { ...options, waitForConnections: true, connectionLimit: 5,
    ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}) };
}

function migrateLocalDb() {
  const customerColumns = sqlite.prepare('PRAGMA table_info(customers)').all().map(row => row.name);
  if (!customerColumns.includes('password_hash')) sqlite.exec('ALTER TABLE customers ADD COLUMN password_hash TEXT');
  const bookingColumns = sqlite.prepare('PRAGMA table_info(bookings)').all().map(row => row.name);
  if (!bookingColumns.includes('slot_key')) sqlite.exec('ALTER TABLE bookings ADD COLUMN slot_key TEXT');
  sqlite.exec("UPDATE bookings SET slot_key = slot_date || 'T' || slot_time WHERE status = 'confirmed' AND slot_key IS NULL");
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS active_slot_key ON bookings(slot_key)');
}

export async function initDb() {
  if (hosted) {
    pool = mysql.createPool(mysqlOptions());
    const connection = await pool.getConnection();
    try { for (const statement of mysqlSchema) await connection.execute(statement); }
    finally { connection.release(); }
  } else {
    if (process.env.NODE_ENV === 'production') throw new Error('Hostinger MySQL configuration is required in production.');
    const { DatabaseSync } = await import('node:sqlite');
    const filename = path.resolve(process.env.BOOKING_DB_PATH || 'data/bookings.sqlite');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    sqlite = new DatabaseSync(filename);
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    sqlite.exec(sqliteSchema);
    migrateLocalDb();
  }
}

export async function query(sql, params = [], connection = null) {
  if (hosted) {
    const [rows] = await (connection || pool).execute(sql, params);
    return Array.isArray(rows) ? rows : [];
  }
  const statement = sqlite.prepare(sql);
  if (/^\s*(SELECT|WITH)\b/i.test(sql)) return statement.all(...params);
  statement.run(...params);
  return [];
}

export async function transaction(fn) {
  if (hosted) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
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
  } finally { release(); }
}

export function isUniqueError(error) {
  return error?.code === 'ER_DUP_ENTRY' || String(error?.code || '').startsWith('SQLITE_CONSTRAINT') ||
    /UNIQUE constraint failed/i.test(String(error?.message || ''));
}

export async function closeDb() {
  if (pool) { await pool.end(); pool = null; }
  if (sqlite) { sqlite.close(); sqlite = null; }
}
