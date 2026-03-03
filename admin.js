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

router.use(requireAdmin);

/**
 * GET /api/admin/new-users/v2
 * List all new users with their game counts and outcomes (V2)
 */
router.get('/new-users/v2', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const result = await db.query(`
      SELECT 
        id, 
        username, 
        phone, 
        is_new_user, 
        games_played_today, 
        last_game_outcome, 
        total_games_played,
        balance,
        createdat
      FROM users
      WHERE is_new_user = true
      ORDER BY createdat DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    logger.info('admin.new_users.list.v2', { count: result.rowCount, limit, offset });

    return res.json({
      ok: true,
      newUsers: result.rows || [],
      count: result.rowCount,
      limit,
      offset
    });
  } catch (err) {
    logger.error('admin.new_users.list.error', { message: err.message });
    return sendError(res, 500, 'Failed to fetch new users');
  }
}));

/**
 * GET /api/admin/new-users/:userId/outcomes/v2
 * Get detailed outcome history with crash points (V2)
 */
router.get('/new-users/:userId/outcomes/v2', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.params.userId;

  if (!userId) {
    return sendError(res, 400, 'userId required');
  }

  try {
    const userRes = await db.query(
      `SELECT id, username, phone, is_new_user, games_played_today, last_game_outcome, total_games_played, balance FROM users WHERE id = $1`,
      [userId]
    );

    if (!userRes.rowCount) {
      return sendError(res, 404, 'User not found');
    }

    const user = userRes.rows[0];

    // Get outcome audit log with crash point details
    const auditRes = await db.query(`
      SELECT 
        id,
        user_id,
        round_id,
        game_number_today,
        predetermined_outcome,
        reason,
        bet_amount,
        forced_crash_point,
        actual_crash_point,
        actual_multiplier,
        created_at
      FROM new_user_outcome_audit
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [userId]);

    logger.info('admin.new_user.outcomes.detail.v2', { userId, auditCount: auditRes.rowCount });

    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        isNewUser: user.is_new_user,
        gamesPlayedToday: user.games_played_today,
        lastGameOutcome: user.last_game_outcome,
        totalGamesPlayed: user.total_games_played,
        balance: Number(user.balance)
      },
      outcomeHistory: auditRes.rows || []
    });
  } catch (err) {
    logger.error('admin.new_user.outcomes.error', { userId, message: err.message });
    return sendError(res, 500, 'Failed to fetch outcome history');
  }
}));

/**
 * POST /api/admin/new-users/:userId/mark-not-new
 * Mark a user as not new (disable predetermined outcomes)
 */
router.post('/new-users/:userId/mark-not-new', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.params.userId;

  if (!userId) {
    return sendError(res, 400, 'userId required');
  }

  try {
    await db.query(
      `UPDATE users SET is_new_user = false, updatedat = NOW() WHERE id = $1`,
      [userId]
    );

    logger.warn('admin.new_user.marked_not_new', { userId, adminAction: true });

    return res.json({
      ok: true,
      message: `User ${userId} marked as not new. Predetermined outcomes disabled.`,
      userId
    });
  } catch (err) {
    logger.error('admin.new_user.mark_not_new.error', { userId, message: err.message });
    return sendError(res, 500, 'Failed to update user');
  }
}));

/**
 * POST /api/admin/new-users/:userId/reset-daily-count
 * Manually reset a user's daily game count
 */
router.post('/new-users/:userId/reset-daily-count', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.params.userId;

  if (!userId) {
    return sendError(res, 400, 'userId required');
  }

  try {
    await db.query(
      `UPDATE users SET games_played_today = 0, games_played_today_reset_at = NOW(), updatedat = NOW() WHERE id = $1`,
      [userId]
    );

    logger.warn('admin.new_user.daily_count_reset', { userId, adminAction: true });

    return res.json({
      ok: true,
      message: `Daily game count reset for user ${userId}`,
      userId
    });
  } catch (err) {
    logger.error('admin.new_user.reset_daily_count.error', { userId, message: err.message });
    return sendError(res, 500, 'Failed to reset daily count');
  }
}));

/**
 * GET /api/admin/new-users/stats/summary/v2
 * Get summary statistics on new users and crash points (V2)
 */
router.get('/new-users/stats/summary/v2', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;

  try {
    const newUserCount = await db.query(`SELECT COUNT(*) as count FROM users WHERE is_new_user = true`);

    const avgGames = await db.query(`
      SELECT AVG(games_played_today) as avg_games, MAX(games_played_today) as max_games
      FROM users WHERE is_new_user = true
    `);

    // V2: Get crash point statistics
    const crashStats = await db.query(`
      SELECT 
        predetermined_outcome,
        COUNT(*) as count,
        AVG(forced_crash_point) as avg_forced_crash_point,
        MIN(forced_crash_point) as min_forced_crash_point,
        MAX(forced_crash_point) as max_forced_crash_point,
        AVG(actual_crash_point) as avg_actual_crash_point
      FROM new_user_outcome_audit
      WHERE DATE(created_at) = DATE(NOW())
      GROUP BY predetermined_outcome
    `);

    const reasons = await db.query(`
      SELECT reason, COUNT(*) as count
      FROM new_user_outcome_audit
      WHERE DATE(created_at) = DATE(NOW())
      GROUP BY reason
      ORDER BY count DESC
    `);

    logger.info('admin.new_users.stats.summary.v2', {
      totalNewUsers: newUserCount.rows[0]?.count,
      crashStats: crashStats.rows
    });

    return res.json({
      ok: true,
      totalNewUsers: Number(newUserCount.rows[0]?.count || 0),
      avgGamesToday: Number(avgGames.rows[0]?.avg_games || 0).toFixed(2),
      maxGamesToday: Number(avgGames.rows[0]?.max_games || 0),
      crashPointStats: crashStats.rows || [],
      reasonBreakdown: reasons.rows || []
    });
  } catch (err) {
    logger.error('admin.new_users.stats.summary.error', { message: err.message });
    return sendError(res, 500, 'Failed to fetch statistics');
  }
}));

/**
 * ADD THIS TO YOUR admin.js FILE
 * Safe migration endpoint for V2 (preserves existing data)
 */

/**
 * POST /api/admin/migrate/v2-new-user-outcomes
 * Safely migrate database to V2 without losing data
 */
router.post("/migrate/v2-new-user-outcomes", requireAdmin, express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  
  try {
    logger.info('admin.migrate.v2_start');

    // ==================== STEP 1: Add new columns to users table ====================
    logger.info('admin.migrate.v2.step_1_add_user_columns');
    
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_new_user BOOLEAN NOT NULL DEFAULT true`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played_today INTEGER NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played_today_reset_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_game_outcome TEXT`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_games_played INTEGER NOT NULL DEFAULT 0`);
    
    logger.info('admin.migrate.v2.user_columns_added');

    // ==================== STEP 2: Create indexes ====================
    logger.info('admin.migrate.v2.step_2_create_indexes');
    
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_is_new_user ON users (is_new_user)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_games_played_today ON users (games_played_today)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_games_played_today_reset_at ON users (games_played_today_reset_at)`);
    
    logger.info('admin.migrate.v2.indexes_created');

    // ==================== STEP 3: Create audit table ====================
    logger.info('admin.migrate.v2.step_3_create_audit_table');
    
    await db.query(`
      CREATE TABLE IF NOT EXISTS new_user_outcome_audit (
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
    
    logger.info('admin.migrate.v2.audit_table_created');

    // ==================== STEP 4: Create audit indexes ====================
    logger.info('admin.migrate.v2.step_4_create_audit_indexes');
    
    await db.query(`CREATE INDEX IF NOT EXISTS idx_new_user_outcome_audit_user_id ON new_user_outcome_audit (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_new_user_outcome_audit_round_id ON new_user_outcome_audit (round_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_new_user_outcome_audit_created_at ON new_user_outcome_audit (created_at DESC)`);
    
    logger.info('admin.migrate.v2.audit_indexes_created');

    // ==================== STEP 5: Verify migration ====================
    logger.info('admin.migrate.v2.step_5_verify');
    
    const userCount = await db.query(`SELECT COUNT(*) FROM users`);
    const auditTableExists = await db.query(`SELECT to_regclass('new_user_outcome_audit')`);
    
    const result = {
      totalUsers: Number(userCount.rows[0].count),
      auditTableExists: auditTableExists.rows[0].to_regclass !== null,
      newColumnsAdded: true
    };

    logger.info('admin.migrate.v2_complete', result);

    return res.json({
      ok: true,
      message: '✅ V2 migration completed successfully! All data preserved.',
      migration: result,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    logger.error('admin.migrate.v2.error', { message: err.message, stack: err.stack });
    return sendError(res, 500, 'V2 migration failed', err.message);
  }
}));

module.exports = router;
