'use strict';

const express = require('express');
const router = express.Router();
const logger = require('./logger');
const { sendError, wrapAsync } = require('./apiResponses');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-this-admin-token";

function requireAdmin(req, res, next) {
  const t = req.get("x-admin-token") || "";
  if (!t || t !== ADMIN_TOKEN) {
    return sendError(res, 401, "Missing or invalid admin token");
  }
  next();
}

// ✅ Migration endpoint for ALL USERS
router.post("/migrate/all-users-outcomes", express.json(), requireAdmin, wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  
  if (!db) {
    return sendError(res, 500, "Database not initialized");
  }

  try {
    logger.info('admin.migrate.all_users_outcomes_start');

    // Add new columns to users table
    logger.info('admin.migrate.all_users.step_1_add_user_columns');
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played_today INTEGER NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played_today_reset_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_game_outcome TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_games_played INTEGER NOT NULL DEFAULT 0`);
    logger.info('admin.migrate.all_users.user_columns_added');

    // Create indexes
    logger.info('admin.migrate.all_users.step_2_create_indexes');
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_games_played_today ON users (games_played_today)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_games_played_today_reset_at ON users (games_played_today_reset_at)`);
    logger.info('admin.migrate.all_users.indexes_created');

    // Create audit table for ALL users
    logger.info('admin.migrate.all_users.step_3_create_audit_table');
    await db.query(`
      CREATE TABLE IF NOT EXISTS player_outcome_audit (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        round_id TEXT NOT NULL,
        game_number_today INTEGER NOT NULL,
        predetermined_outcome TEXT NOT NULL CHECK (predetermined_outcome IN ('win', 'loss')),
        reason TEXT NOT NULL,
        bet_amount NUMERIC(18,2),
        forced_crash_point NUMERIC(10,2),
        actual_crash_point NUMERIC(10,2),
        actual_multiplier NUMERIC(10,2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('admin.migrate.all_users.audit_table_created');

    // Create audit indexes
    logger.info('admin.migrate.all_users.step_4_create_audit_indexes');
    await db.query(`CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_user_id ON player_outcome_audit (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_round_id ON player_outcome_audit (round_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_created_at ON player_outcome_audit (created_at DESC)`);
    logger.info('admin.migrate.all_users.audit_indexes_created');

    // Verify migration
    logger.info('admin.migrate.all_users.step_5_verify');
    const userCount = await db.query(`SELECT COUNT(*) FROM users`);
    const auditTableExists = await db.query(`SELECT to_regclass('player_outcome_audit')`);
    
    const result = {
      totalUsers: Number(userCount.rows[0].count),
      auditTableExists: auditTableExists.rows[0].to_regclass !== null,
      newColumnsAdded: true
    };

    logger.info('admin.migrate.all_users_outcomes_complete', result);

    return res.json({
      ok: true,
      message: '✅ ALL USERS outcome system deployed! Predetermined outcomes now apply to everyone.',
      migration: result,
      features: {
        dailyReset: 'Games reset at 00:00 UTC per player',
        sequence: 'Lose, Lose, Win, Lose, Win, Lose...',
        crashPoints: {
          game1: '1.00x (fixed)',
          game2: '1.37x (fixed)',
          winGames: '1.50x - 4.56x (random)',
          lossGames: '1.00x - 1.37x (random)'
        },
        betLimit: 'Bets > 10 ZMW = instant loss'
      },
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    logger.error('admin.migrate.all_users_outcomes.error', { message: err.message, stack: err.stack });
    return sendError(res, 500, 'All users outcomes migration failed', err.message);
  }
}));

router.use(requireAdmin);

/**
 * GET /api/admin/player-outcomes/stats
 * Get overall player outcome statistics
 */
router.get('/player-outcomes/stats', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;

  try {
    const totalUsers = await db.query(`SELECT COUNT(*) as count FROM users`);
    
    const avgGames = await db.query(`
      SELECT AVG(games_played_today) as avg_games, MAX(games_played_today) as max_games
      FROM users
    `);

    const crashStats = await db.query(`
      SELECT 
        predetermined_outcome,
        COUNT(*) as count,
        AVG(forced_crash_point) as avg_forced_crash_point,
        MIN(forced_crash_point) as min_forced_crash_point,
        MAX(forced_crash_point) as max_forced_crash_point
      FROM player_outcome_audit
      WHERE DATE(created_at) = DATE(NOW())
      GROUP BY predetermined_outcome
    `);

    const reasonBreakdown = await db.query(`
      SELECT reason, COUNT(*) as count
      FROM player_outcome_audit
      WHERE DATE(created_at) = DATE(NOW())
      GROUP BY reason
      ORDER BY count DESC
    `);

    logger.info('admin.player_outcomes.stats', {
      totalUsers: totalUsers.rows[0]?.count,
      crashStats: crashStats.rows
    });

    return res.json({
      ok: true,
      totalUsers: Number(totalUsers.rows[0]?.count || 0),
      avgGamesToday: Number(avgGames.rows[0]?.avg_games || 0).toFixed(2),
      maxGamesToday: Number(avgGames.rows[0]?.max_games || 0),
      crashPointStats: crashStats.rows || [],
      reasonBreakdown: reasonBreakdown.rows || []
    });
  } catch (err) {
    logger.error('admin.player_outcomes.stats.error', { message: err.message });
    return sendError(res, 500, 'Failed to fetch statistics');
  }
}));

/**
 * GET /api/admin/player-outcomes/:userId
 * Get outcome history for specific player
 */
router.get('/player-outcomes/:userId', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.params.userId;

  if (!userId) {
    return sendError(res, 400, 'userId required');
  }

  try {
    const userRes = await db.query(
      `SELECT id, username, phone, games_played_today, last_game_outcome, total_games_played, balance FROM users WHERE id = $1`,
      [userId]
    );

    if (!userRes.rowCount) {
      return sendError(res, 404, 'User not found');
    }

    const user = userRes.rows[0];

    const auditRes = await db.query(`
      SELECT 
        id,
        round_id,
        game_number_today,
        predetermined_outcome,
        reason,
        bet_amount,
        forced_crash_point,
        actual_crash_point,
        actual_multiplier,
        created_at
      FROM player_outcome_audit
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [userId]);

    logger.info('admin.player_outcome.detail', { userId, outcomeCount: auditRes.rowCount });

    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        gamesPlayedToday: user.games_played_today,
        lastGameOutcome: user.last_game_outcome,
        totalGamesPlayed: user.total_games_played,
        balance: Number(user.balance)
      },
      outcomeHistory: auditRes.rows || []
    });
  } catch (err) {
    logger.error('admin.player_outcome.error', { userId, message: err.message });
    return sendError(res, 500, 'Failed to fetch outcome history');
  }
}));

// ============ NEW ADMIN ENDPOINTS ============

/**
 * ✅ GET /api/admin/users
 * Display all users with pagination
 */
router.get('/users', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const usersRes = await db.query(
      `SELECT id, username, phone, balance, freerounds, zils_uuid, createdat, updatedat 
       FROM users 
       ORDER BY createdat DESC 
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countRes = await db.query(`SELECT COUNT(*) as total FROM users`);
    const total = Number(countRes.rows[0].total);

    logger.info('admin.users.list', { total, limit, offset });

    return res.json({
      ok: true,
      users: usersRes.rows || [],
      total,
      limit,
      offset,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('admin.users.error', { message: err.message });
    return sendError(res, 500, 'Failed to fetch users');
  }
}));

/**
 * ✅ GET /api/admin/payments
 * Check payments with filters (status, type, limit)
 */
router.get('/payments', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const status = req.query.status || null; // pending, confirmed, failed, completed
  const type = req.query.type || null; // deposit, withdraw
  const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    let query = `SELECT id, user_id, type, amount, phone, mtn_transaction_id, external_id, status, mtn_status, created_at, updated_at FROM payments WHERE 1=1`;
    const params = [];

    if (status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }
    if (type) {
      query += ` AND type = $${params.length + 1}`;
      params.push(type);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const paymentsRes = await db.query(query, params);

    logger.info('admin.payments.list', { 
      count: paymentsRes.rowCount, 
      status, 
      type, 
      limit, 
      offset 
    });

    return res.json({
      ok: true,
      payments: paymentsRes.rows || [],
      count: paymentsRes.rowCount,
      limit,
      offset,
      filters: { status, type },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('admin.payments.error', { message: err.message });
    return sendError(res, 500, 'Failed to fetch payments');
  }
}));

/**
 * ✅ POST /api/admin/payments/:transaction_id/mark-failed
 * Manually fail a transaction
 */
router.post('/payments/:transaction_id/mark-failed', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const transactionId = req.params.transaction_id;
  const { reason } = req.body || {};

  if (!transactionId) {
    return sendError(res, 400, 'transaction_id required');
  }

  try {
    const paymentRes = await db.query(
      `SELECT id, user_id, type, amount, status FROM payments 
       WHERE id = $1 OR mtn_transaction_id = $1 OR external_id = $1`,
      [transactionId]
    );

    if (!paymentRes.rowCount) {
      return sendError(res, 404, 'Payment not found');
    }

    const payment = paymentRes.rows[0];

    // Update payment status to failed
    await db.query(
      `UPDATE payments 
       SET status = 'failed', mtn_status = $1, updated_at = NOW() 
       WHERE id = $2`,
      [reason || 'Manual failure', payment.id]
    );

    // If it's a withdrawal, refund the user
    if (payment.type === 'withdraw') {
      await db.query(
        `UPDATE users 
         SET balance = balance + $1, updatedat = NOW() 
         WHERE id = $2`,
        [payment.amount, payment.user_id]
      );

      logger.info('admin.payments.mark_failed.refunded', { 
        paymentId: payment.id, 
        userId: payment.user_id, 
        amount: payment.amount,
        reason
      });
    } else {
      logger.info('admin.payments.mark_failed', { 
        paymentId: payment.id, 
        reason
      });
    }

    return res.json({
      ok: true,
      message: `✅ Payment marked as failed${payment.type === 'withdraw' ? ' and user refunded' : ''}`,
      paymentId: payment.id,
      status: 'failed',
      reason,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('admin.payments.mark_failed.error', { 
      transactionId, 
      message: err.message 
    });
    return sendError(res, 500, 'Failed to mark payment as failed');
  }
}));

/**
 * ✅ POST /api/admin/payments/:transaction_id/mark-confirmed
 * Manually confirm a transaction
 */
router.post('/payments/:transaction_id/mark-confirmed', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const transactionId = req.params.transaction_id;

  if (!transactionId) {
    return sendError(res, 400, 'transaction_id required');
  }

  try {
    const paymentRes = await db.query(
      `SELECT id, user_id, type, amount, status FROM payments 
       WHERE id = $1 OR mtn_transaction_id = $1 OR external_id = $1`,
      [transactionId]
    );

    if (!paymentRes.rowCount) {
      return sendError(res, 404, 'Payment not found');
    }

    const payment = paymentRes.rows[0];

    // Update payment status to confirmed
    await db.query(
      `UPDATE payments 
       SET status = 'confirmed', mtn_status = 'CONFIRMED', updated_at = NOW() 
       WHERE id = $1`,
      [payment.id]
    );

    // If it's a deposit, credit the user
    if (payment.type === 'deposit') {
      await db.query(
        `UPDATE users 
         SET balance = balance + $1, updatedat = NOW() 
         WHERE id = $2`,
        [payment.amount, payment.user_id]
      );

      logger.info('admin.payments.mark_confirmed.credited', { 
        paymentId: payment.id, 
        userId: payment.user_id, 
        amount: payment.amount
      });
    } else {
      logger.info('admin.payments.mark_confirmed', { 
        paymentId: payment.id
      });
    }

    return res.json({
      ok: true,
      message: `✅ Payment marked as confirmed${payment.type === 'deposit' ? ' and user credited' : ''}`,
      paymentId: payment.id,
      status: 'confirmed',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('admin.payments.mark_confirmed.error', { 
      transactionId, 
      message: err.message 
    });
    return sendError(res, 500, 'Failed to mark payment as confirmed');
  }
}));

/**
 * ✅ POST /api/admin/payments/:transaction_id/check-zils-status
 * Check ZILS transaction status and update DB
 */
router.post('/payments/:transaction_id/check-zils-status', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const transactionId = req.params.transaction_id;

  if (!transactionId) {
    return sendError(res, 400, 'transaction_id required');
  }

  try {
    const zils = require('./zils');

    // Check status with ZILS
    const zilsStatus = await zils.checkTransactionStatus(transactionId);

    // Find payment in DB
    const paymentRes = await db.query(
      `SELECT id, user_id, type, amount, status FROM payments 
       WHERE mtn_transaction_id = $1 OR id = $1 OR external_id = $1`,
      [transactionId]
    );

    if (!paymentRes.rowCount) {
      return sendError(res, 404, 'Payment not found in database');
    }

    const payment = paymentRes.rows[0];
    const newStatus = (zilsStatus.status || 'unknown').toLowerCase();

    // Update DB with ZILS status
    await db.query(
      `UPDATE payments 
       SET mtn_status = $1, updated_at = NOW() 
       WHERE id = $2`,
      [zilsStatus.status, payment.id]
    );

    logger.info('admin.payments.check_zils_status', { 
      paymentId: payment.id, 
      zilsStatus: newStatus
    });

    return res.json({
      ok: true,
      paymentId: payment.id,
      dbStatus: payment.status,
      zilsStatus: zilsStatus.status,
      details: zilsStatus.details || {},
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('admin.payments.check_zils_status.error', { 
      transactionId, 
      message: err.message 
    });
    return sendError(res, 500, 'Failed to check ZILS status', err.message);
  }
}));

/**
 * ✅ GET /api/admin/rounds
 * Get rounds with limit
 */
router.get('/rounds', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const roundsRes = await db.query(
      `SELECT id, round_id, crash_point, server_seed_hash, started_at, ended_at, settlement_closed_at, meta, createdat 
       FROM rounds 
       ORDER BY started_at DESC 
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countRes = await db.query(`SELECT COUNT(*) as total FROM rounds`);
    const total = Number(countRes.rows[0].total);

    logger.info('admin.rounds.list', { total, limit, offset });

    return res.json({
      ok: true,
      rounds: roundsRes.rows || [],
      total,
      limit,
      offset,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('admin.rounds.error', { message: err.message });
    return sendError(res, 500, 'Failed to fetch rounds');
  }
}));

/**
 * ✅ POST /api/admin/reset-db
 * Reset database (DELETE all data)
 * ⚠️ DANGEROUS: Use with caution!
 */
router.post('/reset-db', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;

  try {
    logger.warn('admin.reset_db.starting', { 
      message: '⚠️ DANGEROUS OPERATION: Resetting all database tables'
    });

    // Reset in order of dependencies (reverse of FK constraints)
    await db.query(`TRUNCATE TABLE payment_audit CASCADE`);
    await db.query(`TRUNCATE TABLE payments CASCADE`);
    await db.query(`TRUNCATE TABLE bets CASCADE`);
    await db.query(`TRUNCATE TABLE rounds CASCADE`);
    await db.query(`TRUNCATE TABLE seed_commits CASCADE`);
    await db.query(`TRUNCATE TABLE monitoring_snapshots CASCADE`);
    await db.query(`TRUNCATE TABLE legal_audit_log CASCADE`);
    await db.query(`TRUNCATE TABLE self_exclusion CASCADE`);
    await db.query(`TRUNCATE TABLE legal_compliance CASCADE`);
    await db.query(`TRUNCATE TABLE kill_switch_log CASCADE`);
    await db.query(`TRUNCATE TABLE player_outcome_audit CASCADE`);
    await db.query(`TRUNCATE TABLE users CASCADE`);

    logger.warn('admin.reset_db.success', { 
      message: '✅ Database reset complete. All tables cleared.'
    });

    return res.json({
      ok: true,
      message: '✅ Database has been RESET. All tables cleared.',
      tablesCleared: [
        'users',
        'rounds',
        'bets',
        'seed_commits',
        'payments',
        'payment_audit',
        'monitoring_snapshots',
        'legal_compliance',
        'legal_audit_log',
        'self_exclusion',
        'kill_switch_log',
        'player_outcome_audit'
      ],
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('admin.reset_db.error', { message: err.message });
    return sendError(res, 500, 'Failed to reset database', err.message);
  }
}));

/**
 * ✅ GET /api/admin/metrics
 * Get all metrics (game stats, RTP, etc.)
 */
router.get('/metrics', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const metrics = require('./metrics');

  try {
    // Get in-memory metrics
    const metricsData = metrics.getMetrics();

    // Get RTP from database
    const monitoring = require('./monitoring');
    const rtp = await monitoring.calculateRTP(db, 24);

    // Get system health
    const health = await monitoring.getSystemHealth(db);

    logger.info('admin.metrics.fetched', { 
      totalBets: metricsData.totalBets,
      rtp: rtp?.rtp,
      activeRounds: health.activeRounds
    });

    return res.json({
      ok: true,
      metrics: {
        totalBets: metricsData.totalBets,
        totalVolume: metricsData.totalVolume,
        totalCashouts: metricsData.totalCashouts,
        totalPayouts: metricsData.totalPayouts,
        lastUpdated: metricsData.lastUpdated,
        rtp: rtp?.rtp || 0,
        rtpBets: rtp?.betCount || 0,
        rtpWins: rtp?.wonCount || 0,
        rtpLosses: rtp?.lostCount || 0,
        activeRounds: health.activeRounds || 0,
        pendingPayments: health.pendingPayments || 0,
        totalUsers: health.userCount || 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('admin.metrics.error', { message: err.message });
    return sendError(res, 500, 'Failed to fetch metrics');
  }
}));

module.exports = router;
