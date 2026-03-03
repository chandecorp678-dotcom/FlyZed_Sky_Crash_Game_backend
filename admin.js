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

module.exports = router;
