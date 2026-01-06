const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const path = require("path");
const fs = require("fs");

const PG_URL = process.env.DATABASE_URL || '';
const SQLITE_PATH = path.join(__dirname, "db", "ka-ndeke.db");

// Helper: ensure local db folder exists (for sqlite)
function ensureSqliteDir() {
  const dir = path.dirname(SQLITE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Create the users table SQL (works for both sqlite and postgres - uses compatible types)
const USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  phone TEXT UNIQUE,
  password_hash TEXT,
  balance REAL DEFAULT 0,
  freeRounds INTEGER DEFAULT 0,
  createdAt TEXT,
  updatedAt TEXT
);
`;

async function initSqlite() {
  ensureSqliteDir();

  const db = await open({
    filename: SQLITE_PATH,
    driver: sqlite3.Database,
  });

  await db.exec("PRAGMA foreign_keys = ON;");
  // create or migrate users table (existing logic kept simple)
  await db.exec(USERS_TABLE_SQL);

  return db; // db has run/get/all/exec via sqlite package
}

// Small Postgres wrapper that exposes run/get/all/exec similar to sqlite API
async function initPostgres() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: PG_URL, ssl: PG_URL.startsWith('postgres://') ? { rejectUnauthorized: false } : false });

  // Helper to run a query and return rows
  async function all(sql, params = []) {
    const res = await pool.query(sql, params);
    return res.rows;
  }
  // Return first row or undefined
  async function get(sql, params = []) {
    const res = await pool.query(sql, params);
    return res.rows[0];
  }
  // Run a command (INSERT/UPDATE). Return result-like object
  async function run(sql, params = []) {
    const res = await pool.query(sql, params);
    return res;
  }
  // Exec: allow running multiple statements; split by semicolon safely (simple)
  async function exec(sql) {
    // naive split: run sequentially for non-empty statements
    const parts = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      await pool.query(p);
    }
  }

  // Ensure users table exists (Postgres-compatible)
  await exec(USERS_TABLE_SQL);

  // Return wrapper with same method names used by the app
  return { pool, all, get, run, exec, query: pool.query.bind(pool) };
}

async function initDb() {
  if (PG_URL) {
    console.log('Using Postgres DB at', PG_URL.startsWith('postgres') ? '(postgres)' : PG_URL);
    return await initPostgres();
  } else {
    console.log('Using local SQLite DB at', SQLITE_PATH);
    return await initSqlite();
  }
}

module.exports = { initDb, SQLITE_PATH };
