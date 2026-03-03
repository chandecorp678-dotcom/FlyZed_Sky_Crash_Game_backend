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

module.exports = router;
