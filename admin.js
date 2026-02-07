const express = require("express");
const path = require("path");
const router = express.Router();
const logger = require("./logger");
const { sendError } = require("./apiResponses");

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-this-admin-token"; // set a strong value in Render env

// Middleware to require admin token in header "x-admin-token"
function requireAdmin(req, res, next) {
  const t = req.get("x-admin-token") || "";
  if (!t || t !== ADMIN_TOKEN) {
    return sendError(res, 401, "Missing or invalid admin token");
  }
  next();
}

// One-time admin endpoint: create required tables (safe: uses IF NOT EXISTS)
// Add this block near the other admin routes. Remove it after you ran it successfully.
router.post("/init-db", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  if (!db || typeof db.query !== "function") {
    return sendError(res, 500, "Database not initialized on server");
  }

  // Create users table (if not present) and bets table and rounds table
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      balance NUMERIC(18,2) NOT NULL DEFAULT 0,
      freerounds INTEGER NOT NULL DEFAULT 0,
      createdat TIMESTAMPTZ NOT NULL,
      updatedat TIMESTAMPTZ NOT NULL
    );
  `;

  const createBetsTable = `
    CREATE TABLE IF NOT EXISTS bets (
      id UUID PRIMARY KEY,
      round_id TEXT NOT NULL,
      user_id UUID,
      bet_amount NUMERIC(18,2) NOT NULL,
      payout NUMERIC(18,2),
      status TEXT NOT NULL DEFAULT 'active',  -- active, cashed, lost, refunded
      meta JSONB DEFAULT '{}'::jsonb,
      createdat TIMESTAMPTZ NOT NULL,
      updatedat TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets (user_id);
    CREATE INDEX IF NOT EXISTS idx_bets_round_id ON bets (round_id);
  `;

  const createRoundsTable = `
    CREATE TABLE IF NOT EXISTS rounds (
      id UUID PRIMARY KEY,
      round_id TEXT UNIQUE NOT NULL,
      crash_point NUMERIC(10,2),
      server_seed_hash TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      meta JSONB DEFAULT '{}'::jsonb,
      createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rounds_round_id ON rounds (round_id);
    CREATE INDEX IF NOT EXISTS idx_rounds_started_at ON rounds (started_at);
  `;

  try {
    await db.query(createUsersTable);
    await db.query(createBetsTable);
    await db.query(createRoundsTable);
    return res.json({ ok: true, message: "users + bets + rounds tables created (if not already existed)" });
  } catch (err) {
    logger.error("Init DB error:", { message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : undefined });
    return sendError(res, 500, "Init DB failed", err.message);
  }
});

// GET /api/admin/users -> list all users (no password_hash)
router.get("/users", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query(
      `SELECT id, username, phone, balance, freerounds, createdat, updatedat
       FROM users
       ORDER BY createdat DESC`
    );
    return res.json({ users: result.rows || [] });
  } catch (err) {
    logger.error("Admin list users error:", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

// GET /api/admin/export-db -> optional: if you still want to download the SQLite file
// Not useful with Postgres unless you export manually. You can leave this out.
router.get("/export-db", requireAdmin, (req, res) => {
  return sendError(res, 501, "Postgres export not supported via API");
});

module.exports = router;
