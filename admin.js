'use strict';

const express = require("express");
const router = express.Router();
const logger = require("./logger");
const { sendError } = require("./apiResponses");
const { runTransaction } = require("./dbHelper");
const metrics = require("./metrics");

logger.info("admin.routes.load_attempt", { ts: new Date().toISOString() });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-this-admin-token";

function requireAdmin(req, res, next) {
  const t = req.get("x-admin-token") || "";
  if (!t || t !== ADMIN_TOKEN) {
    return sendError(res, 401, "Missing or invalid admin token");
  }
  next();
}

/* =================== RESET DB (DROP ALL TABLES) =================== */
router.post("/reset-db", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  if (!db || typeof db.query !== "function") {
    logger.error("admin.reset_db.no_db_connection");
    return sendError(res, 500, "Database not initialized on server");
  }

  try {
    logger.info("admin.reset_db.starting");

    // DROP all tables in correct order (respect foreign keys)
    const dropStatements = [
      `DROP TABLE IF EXISTS self_exclusion CASCADE`,
      `DROP TABLE IF EXISTS legal_compliance CASCADE`,
      `DROP TABLE IF EXISTS kill_switch_log CASCADE`,
      `DROP TABLE IF EXISTS monitoring_snapshots CASCADE`,
      `DROP TABLE IF EXISTS payments CASCADE`,
      `DROP TABLE IF EXISTS bets CASCADE`,
      `DROP TABLE IF EXISTS seed_commits CASCADE`,
      `DROP TABLE IF EXISTS rounds CASCADE`,
      `DROP TABLE IF EXISTS users CASCADE`
    ];

    for (const dropStmt of dropStatements) {
      await db.query(dropStmt);
      logger.info("admin.reset_db.dropped_table", { statement: dropStmt.split("IF EXISTS")[1]?.trim() });
    }

    logger.info("admin.reset_db.all_tables_dropped");
    return res.json({ 
      ok: true, 
      message: "All tables dropped successfully. Run /api/admin/init-db next to recreate them.",
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    logger.error("admin.reset_db.error", { 
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined
    });
    return sendError(res, 500, "Reset DB failed", err && err.message ? err.message : String(err));
  }
});

/* =================== INIT DB (RECREATE ALL TABLES) =================== */
router.post("/init-db", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  if (!db || typeof db.query !== "function") {
    logger.error("admin.init_db.no_db_connection");
    return sendError(res, 500, "Database not initialized on server");
  }

  try {
    logger.info("admin.init_db.starting");

    // 1. Create users table
    await db.query(`
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
    `);
    logger.info("admin.init_db.users_table_created");

    // 2. Create rounds table
    await db.query(`
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
        settlement_window_seconds INTEGER DEFAULT 300,
        settlement_closed_at TIMESTAMPTZ,
        meta JSONB DEFAULT '{}'::jsonb,
        createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    logger.info("admin.init_db.rounds_table_created");

    // 3. Create bets table (WITH claimed_at column defined)
    await db.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id UUID PRIMARY KEY,
        round_id TEXT NOT NULL,
        user_id UUID,
        bet_amount NUMERIC(18,2) NOT NULL,
        payout NUMERIC(18,2),
        status TEXT NOT NULL DEFAULT 'active',
        bet_placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ,
        meta JSONB DEFAULT '{}'::jsonb,
        createdat TIMESTAMPTZ NOT NULL,
        updatedat TIMESTAMPTZ NOT NULL
      );
    `);
    logger.info("admin.init_db.bets_table_created");

    // 4. Create seed_commits table
    await db.query(`
      CREATE TABLE IF NOT EXISTS seed_commits (
        id SERIAL PRIMARY KEY,
        idx BIGINT UNIQUE NOT NULL,
        seed_hash TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    logger.info("admin.init_db.seed_commits_table_created");

    // 5. Create payments table
    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw')),
        amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
        phone TEXT NOT NULL,
        mtn_transaction_id TEXT UNIQUE NOT NULL,
        external_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
        mtn_status TEXT,
        error_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    logger.info("admin.init_db.payments_table_created");

    // 6. Create monitoring_snapshots table
    await db.query(`
      CREATE TABLE IF NOT EXISTS monitoring_snapshots (
        id UUID PRIMARY KEY,
        rtp NUMERIC(5, 2) NOT NULL DEFAULT 95.00,
        total_bets NUMERIC(18, 2) NOT NULL DEFAULT 0,
        total_payouts NUMERIC(18, 2) NOT NULL DEFAULT 0,
        active_rounds INTEGER NOT NULL DEFAULT 0,
        pending_payments INTEGER NOT NULL DEFAULT 0,
        user_count INTEGER NOT NULL DEFAULT 0,
        anomalies_detected INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    logger.info("admin.init_db.monitoring_snapshots_table_created");

    // 7. Create kill_switch_log table
    await db.query(`
      CREATE TABLE IF NOT EXISTS kill_switch_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
        target TEXT NOT NULL CHECK (target IN ('game_rounds', 'payments', 'all')),
        reason TEXT,
        activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    logger.info("admin.init_db.kill_switch_log_table_created");

    // 8. Create legal_compliance table
    await db.query(`
      CREATE TABLE IF NOT EXISTS legal_compliance (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        terms_accepted BOOLEAN NOT NULL DEFAULT false,
        terms_accepted_at TIMESTAMPTZ,
        terms_version VARCHAR(50) DEFAULT 'v1.0',
        age_verified BOOLEAN NOT NULL DEFAULT false,
        age_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    logger.info("admin.init_db.legal_compliance_table_created");

    // 9. Create self_exclusion table
    await db.query(`
      CREATE TABLE IF NOT EXISTS self_exclusion (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        excluded_until TIMESTAMPTZ NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cancelled_at TIMESTAMPTZ
      );
    `);
    logger.info("admin.init_db.self_exclusion_table_created");

    // 10. Create indexes
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone)`,
      `CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets (user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_bets_round_id ON bets (round_id)`,
      `CREATE INDEX IF NOT EXISTS idx_bets_createdat ON bets (createdat DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_bets_claimed_at ON bets (claimed_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_user_round ON bets (user_id, round_id) WHERE status = 'active'`,
      `CREATE INDEX IF NOT EXISTS idx_rounds_round_id ON rounds (round_id)`,
      `CREATE INDEX IF NOT EXISTS idx_rounds_started_at ON rounds (started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_rounds_settlement_closed_at ON rounds (settlement_closed_at)`,
      `CREATE INDEX IF NOT EXISTS idx_seed_commits_idx ON seed_commits (idx DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_created_at ON monitoring_snapshots (created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_kill_switch_log_activated_at ON kill_switch_log (activated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_legal_compliance_user_id ON legal_compliance (user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_self_exclusion_excluded_until ON self_exclusion (excluded_until)`
    ];

    for (const indexQuery of indexes) {
      await db.query(indexQuery);
    }
    logger.info("admin.init_db.indexes_created");

    logger.info("admin.init_db.completed");
    return res.json({ 
      ok: true, 
      message: "All tables and indexes created successfully",
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    logger.error("admin.init_db.error", { 
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined
    });
    return sendError(res, 500, "Init DB failed", err && err.message ? err.message : String(err));
  }
});

/* =================== METRICS =================== */
router.get("/metrics", requireAdmin, async (req, res) => {
  try {
    const m = metrics.getMetrics();
    return res.json({ ok: true, metrics: m });
  } catch (err) {
    logger.error("admin.metrics.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* =================== USERS LIST =================== */
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

/* =================== ROUNDS LIST =================== */
router.get("/rounds", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = await db.query(
      `SELECT round_id, crash_point, server_seed_hash, server_seed, commit_idx, server_seed_revealed_at, started_at, ended_at, settlement_closed_at, meta, createdat
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

/* =================== ROUND DETAILS =================== */
router.get("/rounds/:roundId", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const roundId = req.params.roundId;
  if (!roundId) return sendError(res, 400, "roundId required");

  try {
    const r = await db.query(
      `SELECT round_id, crash_point, server_seed_hash, server_seed, commit_idx, server_seed_revealed_at, started_at, ended_at, settlement_closed_at, meta, createdat 
       FROM rounds WHERE round_id = $1`, 
      [roundId]
    );
    if (!r.rowCount) return sendError(res, 404, "Round not found");

    const bets = await db.query(
      `SELECT id, user_id, bet_amount, payout, status, bet_placed_at, claimed_at, meta, createdat, updatedat 
       FROM bets WHERE round_id = $1 ORDER BY createdat ASC`, 
      [roundId]
    );

    return res.json({ round: r.rows[0], bets: bets.rows || [] });
  } catch (err) {
    logger.error("admin.rounds.detail.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* =================== BETS LIST =================== */
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
      `SELECT id, round_id, user_id, bet_amount, payout, status, bet_placed_at, claimed_at, meta, createdat, updatedat
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

/* =================== REFUND BET =================== */
router.post("/bets/:betId/refund", requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const betId = req.params.betId;
  if (!betId) return sendError(res, 400, "betId required");

  try {
    const result = await runTransaction(db, async (client) => {
      const br = await client.query(
        `SELECT id, user_id, bet_amount, payout, status FROM bets WHERE id = $1 FOR UPDATE`, 
        [betId]
      );
      if (!br.rowCount) {
        const e = new Error("Bet not found");
        e.status = 404;
        throw e;
      }

      const bet = br.rows[0];
      if (bet.status === 'refunded') {
        return { alreadyRefunded: true, betId: bet.id };
      }

      if (bet.status === 'cashed') {
        const e = new Error("Cannot refund a cashed bet");
        e.status = 400;
        throw e;
      }

      await client.query(
        `UPDATE bets SET status = 'refunded', updatedat = NOW() WHERE id = $1`, 
        [betId]
      );

      if (bet.user_id && Number(bet.bet_amount) > 0) {
        await client.query(
          `UPDATE users SET balance = balance + $1, updatedat = NOW() WHERE id = $2`, 
          [bet.bet_amount, bet.user_id]
        );
      }

      return { betId: bet.id, refundedAmount: Number(bet.bet_amount || 0), userId: bet.user_id };
    });

    if (result.alreadyRefunded) {
      logger.info('admin.bet.refund.noop', { betId });
      return res.json({ ok: true, message: "Bet already refunded", betId });
    }

    logger.info('admin.bet.refund.success', { ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err && err.status) return sendError(res, err.status, err.message);
    logger.error("admin.bet.refund.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

/* =================== MARK BET REFUNDED =================== */
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

logger.info("admin.routes.loaded", { ts: new Date().toISOString() });

/**
 * GET /api/admin/payments
 * List all payments with optional filtering
 */
router.get('/payments', requireAdmin, wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  try {
    const status = req.query.status || null;
    const type = req.query.type || null; // 'deposit' or 'withdraw'
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    let query = `
      SELECT 
        id,
        user_id,
        type,
        amount,
        phone,
        mtn_transaction_id,
        external_id,
        status,
        mtn_status,
        error_reason,
        created_at,
        updated_at
      FROM payments
      WHERE 1=1
    `;

    const params = [];

    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    if (type) {
      params.push(type);
      query += ` AND type = $${params.length}`;
    }

    params.push(limit);
    params.push(offset);

    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.query(query, params);

    logger.info('admin.payments.list', { 
      count: result.rowCount, 
      status, 
      type, 
      limit, 
      offset 
    });

    return res.json({
      ok: true,
      payments: result.rows || [],
      count: result.rowCount,
      limit,
      offset
    });
  } catch (err) {
    logger.error('admin.payments.list.error', { message: err.message });
    return sendError(res, 500, 'Failed to fetch payments');
  }
}));

/**
 * GET /api/admin/payments/:paymentId
 * Get detailed payment info
 */
router.get('/payments/:paymentId', requireAdmin, wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const paymentId = req.params.paymentId;

  if (!paymentId) {
    return sendError(res, 400, 'paymentId required');
  }

  try {
    const result = await db.query(
      `SELECT 
        id,
        user_id,
        type,
        amount,
        phone,
        mtn_transaction_id,
        external_id,
        status,
        mtn_status,
        error_reason,
        created_at,
        updated_at
       FROM payments 
       WHERE id = $1`,
      [paymentId]
    );

    if (!result.rowCount) {
      return sendError(res, 404, 'Payment not found');
    }

    const payment = result.rows[0];

    // Get user info
    const userResult = await db.query(
      `SELECT id, username, phone, balance FROM users WHERE id = $1`,
      [payment.user_id]
    );

    logger.info('admin.payment.detail', { paymentId, status: payment.status });

    return res.json({
      ok: true,
      payment,
      user: userResult.rows[0] || null
    });
  } catch (err) {
    logger.error('admin.payment.detail.error', { message: err.message });
    return sendError(err, 500, 'Failed to fetch payment');
  }
}));

/**
 * POST /api/admin/payments/:paymentId/check-zils-status
 * Manually check transaction status with ZILS API
 */
router.post('/payments/:paymentId/check-zils-status', requireAdmin, express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const zils = require('./zils');
  const paymentId = req.params.paymentId;

  if (!paymentId) {
    return sendError(res, 400, 'paymentId required');
  }

  try {
    // Get payment from DB
    const paymentResult = await db.query(
      `SELECT 
        id,
        user_id,
        type,
        amount,
        phone,
        mtn_transaction_id,
        external_id,
        status,
        mtn_status,
        created_at,
        updated_at
       FROM payments 
       WHERE id = $1`,
      [paymentId]
    );

    if (!paymentResult.rowCount) {
      return sendError(res, 404, 'Payment not found');
    }

    const payment = paymentResult.rows[0];
    const transactionId = payment.mtn_transaction_id; // The ZILS transaction ID

    logger.info('admin.payment.check_zils_status.start', { paymentId, transactionId });

    // Call ZILS to check status
    const statusCheck = await zils.checkTransactionStatus(transactionId);

    logger.info('admin.payment.check_zils_status.result', { 
      paymentId, 
      transactionId,
      zilsStatus: statusCheck.status 
    });

    return res.json({
      ok: true,
      payment,
      zilsCheck: {
        transactionId,
        status: statusCheck.status,
        details: statusCheck.details,
        checkedAt: new Date().toISOString()
      },
      message: `ZILS reports status: ${statusCheck.status}`
    });
  } catch (err) {
    logger.error('admin.payment.check_zils_status.error', { 
      paymentId, 
      message: err.message 
    });
    return sendError(res, 500, 'Failed to check ZILS status', err.message);
  }
}));

/**
 * POST /api/admin/payments/:paymentId/mark-confirmed
 * Manually mark payment as confirmed (if ZILS API confirms but polling missed it)
 */
router.post('/payments/:paymentId/mark-confirmed', requireAdmin, express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const paymentId = req.params.paymentId;

  if (!paymentId) {
    return sendError(res, 400, 'paymentId required');
  }

  try {
    const result = await runTransaction(db, async (client) => {
      const paymentResult = await client.query(
        `SELECT id, user_id, type, amount, status FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId]
      );

      if (!paymentResult.rowCount) {
        const err = new Error('Payment not found');
        err.status = 404;
        throw err;
      }

      const payment = paymentResult.rows[0];

      // Update payment status
      await client.query(
        `UPDATE payments SET status = 'confirmed', mtn_status = 'CONFIRMED', updated_at = NOW() WHERE id = $1`,
        [paymentId]
      );

      // If deposit, credit user balance
      if (payment.type === 'deposit') {
        await client.query(
          `UPDATE users SET balance = balance + $1, updatedat = NOW() WHERE id = $2`,
          [payment.amount, payment.user_id]
        );
      }

      return { paymentId, type: payment.type, amount: payment.amount, userId: payment.user_id };
    });

    logger.warn('admin.payment.manually_confirmed', { 
      paymentId,
      type: result.type,
      amount: result.amount
    });

    return res.json({
      ok: true,
      message: `Payment ${paymentId} manually marked as confirmed`,
      ...result
    });
  } catch (err) {
    if (err && err.status) return sendError(res, err.status, err.message);
    logger.error('admin.payment.mark_confirmed.error', { message: err.message });
    return sendError(res, 500, 'Failed to mark payment confirmed', err.message);
  }
}));

/**
 * POST /api/admin/payments/:paymentId/mark-failed
 * Manually mark payment as failed (if user says it failed)
 */
router.post('/payments/:paymentId/mark-failed', requireAdmin, express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const paymentId = req.params.paymentId;
  const { reason } = req.body || {};

  if (!paymentId) {
    return sendError(res, 400, 'paymentId required');
  }

  try {
    const result = await runTransaction(db, async (client) => {
      const paymentResult = await client.query(
        `SELECT id, user_id, type, amount, status FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId]
      );

      if (!paymentResult.rowCount) {
        const err = new Error('Payment not found');
        err.status = 404;
        throw err;
      }

      const payment = paymentResult.rows[0];

      // Update payment status
      await client.query(
        `UPDATE payments SET status = 'failed', mtn_status = 'FAILED', error_reason = $1, updated_at = NOW() WHERE id = $2`,
        [reason || 'Manually marked as failed by admin', paymentId]
      );

      // If withdrawal, refund user balance
      if (payment.type === 'withdraw') {
        await client.query(
          `UPDATE users SET balance = balance + $1, updatedat = NOW() WHERE id = $2`,
          [payment.amount, payment.user_id]
        );
      }

      return { paymentId, type: payment.type, amount: payment.amount, userId: payment.user_id };
    });

    logger.warn('admin.payment.manually_failed', { 
      paymentId,
      type: result.type,
      amount: result.amount,
      reason
    });

    return res.json({
      ok: true,
      message: `Payment ${paymentId} manually marked as failed`,
      ...result
    });
  } catch (err) {
    if (err && err.status) return sendError(res, err.status, err.message);
    logger.error('admin.payment.mark_failed.error', { message: err.message });
    return sendError(res, 500, 'Failed to mark payment failed', err.message);
  }
}));

module.exports = router;
