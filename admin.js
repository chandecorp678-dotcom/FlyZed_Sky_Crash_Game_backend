'use strict';

const express = require("express");
const router = express.Router();
const logger = require("./logger");
const { sendError } = require("./apiResponses");
const { runTransaction } = require("./dbHelper");
const metrics = require("./metrics");

// Log on require so we can tell from logs that admin routes were loaded
logger.info("admin.routes.load_attempt", { ts: new Date().toISOString() });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-this-admin-token"; // set a strong value in Render env

// Middleware to require admin token in header "x-admin-token"
function requireAdmin(req, res, next) {
  const t = req.get("x-admin-token") || "";
  if (!t || t !== ADMIN_TOKEN) {
    return sendError(res, 401, "Missing or invalid admin token");
  }
  next();
}

/* ----------------- Admin: DB init (idempotent) ----------------- */
/**
 * Create tables if not present and ensure recommended indexes exist.
 * Safe to call multiple times.
 */
router.post("/init-db", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  if (!db || typeof db.query !== "function") {
    return sendError(res, 500, "Database not initialized on server");
  }

  // Users table
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

  // Bets table (with indexes and unique constraint for Phase 9.1)
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
    CREATE INDEX IF NOT EXISTS idx_bets_createdat ON bets (createdat DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_user_round ON bets (user_id, round_id) WHERE status = 'active';
  `;

  // Rounds table (with columns for revealed seed and commit index)
  const createRoundsTable = `
    CREATE TABLE IF NOT EXISTS rounds (
      id UUID PRIMARY KEY,
      round_id TEXT UNIQUE NOT NULL,
      crash_point NUMERIC(10,2),
      server_seed_hash TEXT,
      server_seed TEXT,
      commit_idx BIGINT,
      server_seed_revealed_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      meta JSONB DEFAULT '{}'::jsonb,
      createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rounds_round_id ON rounds (round_id);
    CREATE INDEX IF NOT EXISTS idx_rounds_started_at ON rounds (started_at);
  `;

  // Seed commits table: stores pre-committed seed hashes and their sequential index.
  const createSeedCommitsTable = `
    CREATE TABLE IF NOT EXISTS seed_commits (
      id SERIAL PRIMARY KEY,
      idx BIGINT UNIQUE NOT NULL,
      seed_hash TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_seed_commits_idx ON seed_commits (idx DESC);
  `;

  try {
    await db.query(createUsersTable);
    await db.query(createBetsTable);
    await db.query(createRoundsTable);
    await db.query(createSeedCommitsTable);

    // Ensure columns exist if rounds table pre-existed without them (safe ALTER)
    await db.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS server_seed TEXT`);
    await db.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS server_seed_revealed_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS commit_idx BIGINT`);

    logger.info("admin.init_db.completed");
    return res.json({ ok: true, message: "users + bets + rounds + seed_commits tables and indexes created (if not existed)" });
  } catch (err) {
    logger.error("admin.init_db.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Init DB failed", err && err.message ? err.message : undefined);
  }
});

/* ----------------- Admin: metrics ----------------- */
/**
 * GET /api/admin/metrics
 * Returns aggregated in-memory metrics (admin-only).
 */
router.get("/metrics", requireAdmin, async (req, res) => {
  try {
    const m = metrics.getMetrics();
    return res.json({ ok: true, metrics: m });
  } catch (err) {
    logger.error("admin.metrics.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* ----------------- Admin: users list ----------------- */
/**
 * GET /api/admin/users
 * List users without exposing password_hash.
 */
router.get("/users", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const q = await db.query(
      `SELECT id, username, phone, balance, freerounds, createdat, updatedat
       FROM users
       ORDER BY createdat DESC`
    );
    return res.json({ users: q.rows || [] });
  } catch (err) {
    logger.error("admin.users.list.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* ----------------- Admin: list rounds (paginated) ----------------- */
/**
 * GET /api/admin/rounds?limit=50&offset=0
 */
router.get("/rounds", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = await db.query(
      `SELECT round_id, crash_point, server_seed_hash, server_seed, commit_idx, server_seed_revealed_at, started_at, ended_at, meta, createdat
       FROM rounds
       ORDER BY started_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.json({ rounds: q.rows || [] });
  } catch (err) {
    logger.error("admin.rounds.list.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* ----------------- Admin: round details ----------------- */
/**
 * GET /api/admin/rounds/:roundId
 */
router.get("/rounds/:roundId", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const roundId = req.params.roundId;
  if (!roundId) return sendError(res, 400, "roundId required");

  try {
    const r = await db.query(`SELECT round_id, crash_point, server_seed_hash, server_seed, commit_idx, server_seed_revealed_at, started_at, ended_at, meta, createdat FROM rounds WHERE round_id = $1`, [roundId]);
    if (!r.rowCount) return sendError(res, 404, "Round not found");

    const bets = await db.query(`SELECT id, user_id, bet_amount, payout, status, meta, createdat, updatedat FROM bets WHERE round_id = $1 ORDER BY createdat ASC`, [roundId]);

    return res.json({ round: r.rows[0], bets: bets.rows || [] });
  } catch (err) {
    logger.error("admin.rounds.detail.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* ----------------- Admin: list bets (filterable) ----------------- */
/**
 * GET /api/admin/bets?userId=&roundId=&status=&limit=
 */
router.get("/bets", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const params = [];
    const where = [];
    if (req.query.userId) { params.push(req.query.userId); where.push(`user_id = $${params.length}`); }
    if (req.query.roundId) { params.push(req.query.roundId); where.push(`round_id = $${params.length}`); }
    if (req.query.status)  { params.push(req.query.status); where.push(`status = $${params.length}`); }

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    params.push(limit);

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const q = await db.query(
      `SELECT id, round_id, user_id, bet_amount, payout, status, meta, createdat, updatedat
       FROM bets
       ${whereClause}
       ORDER BY createdat DESC
       LIMIT $${params.length}`,
       params
    );
    return res.json({ bets: q.rows || [] });
  } catch (err) {
    logger.error("admin.bets.list.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* ----------------- Admin: refund a bet ----------------- */
/**
 * POST /api/admin/bets/:betId/refund
 *
 * Idempotent: if already refunded, returns success.
 * Will NOT refund bets with status 'cashed' (admin reversal of cashed payouts requires a different workflow).
 */
router.post("/bets/:betId/refund", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const betId = req.params.betId;
  if (!betId) return sendError(res, 400, "betId required");

  try {
    const result = await runTransaction(db, async (client) => {
      // Lock bet row
      const br = await client.query(`SELECT id, user_id, bet_amount, payout, status FROM bets WHERE id = $1 FOR UPDATE`, [betId]);
      if (!br.rowCount) {
        const e = new Error("Bet not found");
        e.status = 404;
        throw e;
      }
      const bet = br.rows[0];

      // If already refunded, return info
      if (bet.status === 'refunded') {
        return { alreadyRefunded: true, betId: bet.id };
      }

      if (bet.status === 'cashed') {
        const e = new Error("Cannot refund a cashed bet via this endpoint");
        e.status = 400;
        throw e;
      }

      // Otherwise perform refund: mark bet refunded and credit user (if any)
      await client.query(`UPDATE bets SET status = 'refunded', updatedat = NOW() WHERE id = $1`, [betId]);

      if (bet.user_id && Number(bet.bet_amount) > 0) {
        await client.query(`UPDATE users SET balance = balance + $1, updatedat = NOW() WHERE id = $2`, [bet.bet_amount, bet.user_id]);
      }

      // Return audit info
      return { betId: bet.id, refundedAmount: Number(bet.bet_amount || 0), userId: bet.user_id };
    });

    // Log admin action
    if (result.alreadyRefunded) {
      logger.info('admin.bet.refund.noop', { betId });
      return res.json({ ok: true, message: "Bet already refunded", betId });
    }

    logger.info('admin.bet.refund.success', { betId: result.betId, refundedAmount: result.refundedAmount, userId: result.userId, admin: req.get('x-admin-token') ? 'provided' : 'none' });

    return res.json({ ok: true, betId: result.betId, refundedAmount: result.refundedAmount, userId: result.userId });
  } catch (err) {
    if (err && err.status) return sendError(res, err.status, err.message);
    logger.error("admin.bet.refund.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* ----------------- Admin: mark bet refunded (force) ----------------- */
/**
 * POST /api/admin/bets/:betId/mark-refunded
 * Use when you want to mark a bet refunded without crediting user balance (audit only).
 */
router.post("/bets/:betId/mark-refunded", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const betId = req.params.betId;
  if (!betId) return sendError(res, 400, "betId required");

  try {
    await db.query(`UPDATE bets SET status = 'refunded', updatedat = NOW() WHERE id = $1`, [betId]);
    logger.info('admin.bet.mark_refunded', { betId });
    return res.json({ ok: true, betId });
  } catch (err) {
    logger.error("admin.bet.mark_refunded.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

// Final log to confirm admin routes loaded successfully
logger.info("admin.routes.loaded", { ts: new Date().toISOString() });

module.exports = router;
