'use strict';

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const logger = require("./logger");
const { runTransaction } = require("./dbHelper");
const metrics = require("./metrics");
const legalCompliance = require("./legalCompliance");

const {
  joinRound,
  cashOut: engineCashOut,
  getRoundStatus
} = require("./gameEngine");

const {
  determineNewUserOutcome,
  getRandomCrashPoint
} = require("./gameEngine")._newUserOutcomes; // ✅ V2 NEW USER OUTCOME LOGIC

const json = express.json();

const cashoutTimestamps = new Map();
const CASHOUT_MIN_INTERVAL_MS = Number(process.env.CASHOUT_MIN_INTERVAL_MS || 1000);
const CASHOUT_PRUNE_AGE_MS = Number(process.env.CASHOUT_PRUNE_AGE_MS || 1000 * 60 * 10);
const MAX_CASHOUT_ENTRIES = Number(process.env.MAX_CASHOUT_ENTRIES || 20000);
const CASHOUT_PRUNE_INTERVAL_MS = Number(process.env.CASHOUT_PRUNE_INTERVAL_MS || 1000 * 60 * 5);

const MIN_BET_AMOUNT = Number(process.env.MIN_BET_AMOUNT || 1);
const MAX_BET_AMOUNT = Number(process.env.MAX_BET_AMOUNT || 1000000);
const BET_LIMIT_THRESHOLD = 10; // ✅ V2: Bets above 10 ZMW = instant loss

function sanitizeNumeric(value, min = 0, max = Infinity) {
  const num = Number(value);
  if (isNaN(num)) return null;
  return Math.max(min, Math.min(max, num));
}

function pruneCashoutMapByAge() {
  const now = Date.now();
  for (const [key, ts] of cashoutTimestamps) {
    if (now - ts > CASHOUT_PRUNE_AGE_MS) {
      cashoutTimestamps.delete(key);
    }
  }
  while (cashoutTimestamps.size > MAX_CASHOUT_ENTRIES) {
    const firstKey = cashoutTimestamps.keys().next().value;
    if (!firstKey) break;
    cashoutTimestamps.delete(firstKey);
  }
}

const pruneInterval = setInterval(() => {
  try { pruneCashoutMapByAge(); } catch (e) { logger.warn('game.cashout.prune_failed', { message: e && e.message ? e.message : String(e) }); }
}, CASHOUT_PRUNE_INTERVAL_MS);
if (typeof pruneInterval.unref === 'function') pruneInterval.unref();

async function checkCompliance(req, res, next) {
  if (!req.user || req.user.guest) {
    return next();
  }

  const db = req.app.locals.db;
  try {
    const exclusion = await legalCompliance.isUserExcluded(db, req.user.id);
    if (exclusion && exclusion.excluded) {
      return res.status(403).json({
        error: `You are self-excluded until ${new Date(exclusion.excludedUntil).toLocaleString()}. Contact support to appeal.`
      });
    }

    next();
  } catch (err) {
    logger.warn('game.checkCompliance.error', { message: err.message });
    next();
  }
}

router.use(checkCompliance);

// ✅ V2: Helper function to check if games_played_today needs daily reset
async function ensureDailyReset(db, userId) {
  const userRes = await db.query(
    `SELECT games_played_today_reset_at FROM users WHERE id = $1`,
    [userId]
  );

  if (!userRes.rowCount) return;

  const lastResetAt = userRes.rows[0].games_played_today_reset_at;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // If last reset was before today (00:00 UTC), reset counter
  if (!lastResetAt || new Date(lastResetAt) < today) {
    await db.query(
      `UPDATE users SET games_played_today = 0, games_played_today_reset_at = $1 WHERE id = $2`,
      [now.toISOString(), userId]
    );
    logger.info('game.daily_reset.executed', { userId, resetTime: now.toISOString() });
  }
}

// ✅ V2: Helper to log predetermined outcomes to audit table
async function logOutcomeAudit(db, userId, roundId, gamesPlayedToday, outcome, reason, betAmount, forcedCrashPoint) {
  try {
    await db.query(
      `INSERT INTO new_user_outcome_audit (id, user_id, round_id, game_number_today, predetermined_outcome, reason, bet_amount, forced_crash_point, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [crypto.randomUUID(), userId, roundId, gamesPlayedToday, outcome, reason, betAmount, forcedCrashPoint]
    );
  } catch (e) {
    logger.warn('game.logOutcomeAudit.error', { message: e && e.message ? e.message : String(e) });
  }
}

// ============ START ROUND (with V2 new user logic + bet limit) ============
router.post("/start", json, async (req, res) => {
  const db = req.app.locals.db;
  if (!db) {
    logger.error("game/start: DB not initialized");
    return res.status(500).json({ error: "Database not initialized" });
  }

  const user = req.user;
  if (!user || user.guest) {
    return res.status(401).json({ error: "You must be logged in to place a bet" });
  }

  const limitStatus = await legalCompliance.checkDailyLossLimit(db, user.id);
  if (limitStatus && limitStatus.limitExceeded) {
    return res.status(403).json({
      error: `Daily loss limit exceeded. You have reached ZMW ${legalCompliance.DAILY_LOSS_LIMIT} in losses today. Please try again tomorrow.`
    });
  }

  let betAmount = sanitizeNumeric(req.body?.betAmount, MIN_BET_AMOUNT, MAX_BET_AMOUNT);
  if (betAmount === null || betAmount < MIN_BET_AMOUNT) {
    return res.status(400).json({ error: `Bet amount must be between ${MIN_BET_AMOUNT} and ${MAX_BET_AMOUNT}` });
  }

  if (betAmount > MAX_BET_AMOUNT) {
    return res.status(400).json({ error: `Bet amount must not exceed ${MAX_BET_AMOUNT}` });
  }

  // ✅ V2: Check bet limit
  if (betAmount > BET_LIMIT_THRESHOLD) {
    logger.warn('game.start.bet_limit_exceeded', { userId: user.id, betAmount, threshold: BET_LIMIT_THRESHOLD });
    return res.status(400).json({
      error: `Bet amount exceeds limit of ${BET_LIMIT_THRESHOLD} ZMW. Your bet will result in instant loss at 1.00x.`
    });
  }

  const status = getRoundStatus();
  if (!status || status.status !== "running") {
    return res.status(400).json({ error: "No active running round" });
  }

  try {
    // ✅ V2: Ensure daily reset
    await ensureDailyReset(db, user.id);

    const txResult = await runTransaction(db, async (client) => {
      // Check for existing active bet
      const existingBetRes = await client.query(
        `SELECT id, status FROM bets
         WHERE user_id = $1 AND round_id = $2`,
        [user.id, status.roundId]
      );

      if (existingBetRes.rowCount > 0) {
        const existingBet = existingBetRes.rows[0];
        if (existingBet.status === 'active') {
          const err = new Error('You already have an active bet on this round');
          err.status = 409;
          throw err;
        }
      }

      // ✅ V2: Get current new user status
      const userRes = await client.query(
        `SELECT is_new_user, games_played_today, last_game_outcome, total_games_played FROM users WHERE id = $1`,
        [user.id]
      );

      const userData = userRes.rows[0];
      const isNewUser = userData.is_new_user;
      const gamesPlayedToday = userData.games_played_today;
      const lastGameOutcome = userData.last_game_outcome;

      // ✅ V2: Determine if outcome is predetermined with realistic crash points
      let isPredetermined = false;
      let predeterminedOutcome = null;
      let predeterminedReason = null;
      let forcedCrashPoint = null;

      if (isNewUser) {
        const outcomeCheck = determineNewUserOutcome(gamesPlayedToday, lastGameOutcome, betAmount);
        isPredetermined = outcomeCheck.isPredetermined;
        predeterminedOutcome = outcomeCheck.outcome;
        predeterminedReason = outcomeCheck.reason;
        forcedCrashPoint = outcomeCheck.forcedCrashPoint;

        logger.info('game.start.predetermined_outcome_v2', {
          userId: user.id,
          gamesPlayedToday,
          outcome: predeterminedOutcome,
          reason: predeterminedReason,
          forcedCrashPoint,
          betAmount
        });
      }

      // Deduct balance
      const updateRes = await client.query(
        `UPDATE users
         SET balance = balance - $1, updatedat = NOW()
         WHERE id = $2 AND balance >= $1
         RETURNING balance`,
        [betAmount, user.id]
      );

      if (!updateRes.rowCount) {
        const err = new Error('Insufficient funds');
        err.status = 402;
        throw err;
      }

      // ✅ V2: Increment games_played_today
      await client.query(
        `UPDATE users SET games_played_today = games_played_today + 1, updatedat = NOW() WHERE id = $1`,
        [user.id]
      );

      // Create bet with predetermination metadata
      const betId = crypto.randomUUID();
      const metaData = {
        isPredetermined,
        predeterminedOutcome,
        predeterminedReason,
        forcedCrashPoint
      };

      await client.query(
        `INSERT INTO bets (id, round_id, user_id, bet_amount, status, createdat, updatedat, meta)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), $6)`,
        [betId, status.roundId, user.id, betAmount, "active", JSON.stringify(metaData)]
      );

      // ✅ V2: Log to audit table
      if (isPredetermined) {
        await logOutcomeAudit(db, user.id, status.roundId, gamesPlayedToday, predeterminedOutcome, predeterminedReason, betAmount, forcedCrashPoint);
      }

      return {
        betId,
        balance: Number(updateRes.rows[0].balance),
        isPredetermined,
        predeterminedOutcome,
        forcedCrashPoint,
        gamesPlayedToday: gamesPlayedToday + 1
      };
    });

    try {
      metrics.incrementBet(betAmount);
    } catch (e) {
      logger.warn('metrics.incrementBet_failed_after_start', { message: e && e.message ? e.message : String(e) });
    }

    try {
      const engineResp = joinRound(user.id, betAmount);
      return res.json({
        betId: txResult.betId,
        roundId: engineResp.roundId,
        serverSeedHash: engineResp.serverSeedHash,
        startedAt: engineResp.startedAt,
        balance: txResult.balance,
        isPredetermined: txResult.isPredetermined,
        predeterminedOutcome: txResult.predeterminedOutcome,
        forcedCrashPoint: txResult.forcedCrashPoint,
        gamesPlayedToday: txResult.gamesPlayedToday,
        message: txResult.isPredetermined
          ? `Game ${txResult.gamesPlayedToday}: Plane will crash at ${txResult.forcedCrashPoint}x (${txResult.predeterminedOutcome === 'loss' ? '💔 Loss' : '💚 Win'})`
          : undefined
      });
    } catch (err) {
      logger.error("joinRound error after DB changes", { message: err && err.message ? err.message : String(err) });
      try {
        await runTransaction(db, async (client) => {
          await client.query(
            `UPDATE users SET balance = balance + $1, updatedat = NOW() WHERE id = $2`,
            [betAmount, user.id]
          );
          await client.query(
            `UPDATE bets SET status = 'refunded', updatedat = NOW() WHERE id = $1`,
            [txResult.betId]
          );
        });
      } catch (e2) {
        logger.error("Failed to refund after joinRound failure", { message: e2 && e2.message ? e2.message : String(e2) });
      }
      return res.status(500).json({ error: "Failed to join round" });
    }
  } catch (err) {
    if (err && err.status === 402) {
      return res.status(402).json({ error: "Insufficient funds" });
    }
    if (err && err.status === 409) {
      return res.status(409).json({ error: err.message });
    }
    if (err && err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    logger.error("game/start transaction error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ error: "Server error" });
  }
});

// ============ ROUND STATUS ============
router.get("/status", (req, res) => {
  try {
    const status = getRoundStatus();
    if (status && status.startedAt) {
      const startedAtNum = Number(status.startedAt);
      if (startedAtNum && startedAtNum < 1e12) {
        status.startedAt = startedAtNum * 1000;
      } else {
        status.startedAt = startedAtNum;
      }
    }
    return res.json(status);
  } catch (err) {
    logger.error("game/status error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ error: "Server error" });
  }
});

// ============ CASH OUT (V2: with realistic predetermined crash points) ============
router.post("/cashout", json, async (req, res) => {
  const db = req.app.locals.db;
  if (!db) {
    logger.error("game/cashout: DB not initialized");
    return res.status(500).json({ error: "Database not initialized" });
  }

  const user = req.user;
  if (!user || user.guest) {
    return res.status(401).json({ error: "You must be logged in to cash out" });
  }

  const last = cashoutTimestamps.get(user.id) || 0;
  if (Date.now() - last < CASHOUT_MIN_INTERVAL_MS) {
    cashoutTimestamps.set(user.id, Date.now());
    pruneCashoutMapByAge();
    return res.status(429).json({ error: "Too many cashout attempts; slow down" });
  }
  cashoutTimestamps.set(user.id, Date.now());
  pruneCashoutMapByAge();

  const status = getRoundStatus();
  if (!status || status.status !== "running") {
    return res.status(400).json({ error: "No active running round" });
  }

  try {
    const result = await runTransaction(db, async (client) => {
      const betRes = await client.query(
        `SELECT id, round_id, user_id, bet_amount, status, payout, meta
         FROM bets
         WHERE user_id = $1 AND round_id = $2
         FOR UPDATE`,
        [user.id, getRoundStatus().roundId]
      );

      if (!betRes.rowCount) {
        const e = new Error('No active bet found for current round');
        e.status = 400;
        throw e;
      }

      const bet = betRes.rows[0];
      const betMeta = bet.meta || {};

      // Idempotency check
      if (bet.status === 'cashed') {
        logger.info('game.cashout.idempotent_already_cashed', { userId: user.id, betId: bet.id, roundId: bet.round_id });
        const userBalance = await client.query(`SELECT balance FROM users WHERE id = $1`, [user.id]);
        return { success: true, payout: Number(bet.payout || 0), multiplier: null, balance: Number(userBalance.rows[0]?.balance || 0), idempotent: true };
      }

      if (bet.status !== 'active') {
        logger.info('game.cashout.bet_not_active', { userId: user.id, betId: bet.id, status: bet.status });
        return { success: false, payout: 0, multiplier: null, balance: null, idempotent: true };
      }

      // ✅ V2: Check if this bet is predetermined and enforce crash point
      let engineResult;
      const currentMultiplier = Number((Date.now() - status.startedAt) / 1000 + 1).toFixed(2);

      if (betMeta.isPredetermined && betMeta.forcedCrashPoint) {
        const forcedCrashPoint = Number(betMeta.forcedCrashPoint);
        
        logger.info('game.cashout.predetermined_enforcement_v2', {
          userId: user.id,
          reason: betMeta.predeterminedReason,
          forcedCrashPoint,
          currentMultiplier,
          betAmount: bet.bet_amount,
          outcome: betMeta.predeterminedOutcome
        });

        // Check if current multiplier is still below forced crash point
        if (Number(currentMultiplier) >= forcedCrashPoint) {
          // Force crash at predetermined point
          engineResult = { win: betMeta.predeterminedOutcome === 'win', payout: 0, multiplier: forcedCrashPoint };

          // Update audit with actual crash info
          await client.query(
            `UPDATE new_user_outcome_audit SET actual_crash_point = $1, actual_multiplier = $2
             WHERE user_id = $3 AND round_id = $4`,
            [forcedCrashPoint, forcedCrashPoint, user.id, bet.round_id]
          );
        } else {
          // Still climbing to crash point
          if (betMeta.predeterminedOutcome === 'loss') {
            engineResult = { win: false, payout: 0, multiplier: forcedCrashPoint };
          } else {
            // Win round - allow to climb but cap at forced crash point
            const cashoutMultiplier = Number(currentMultiplier);
            const payout = Number((Number(bet.bet_amount) * cashoutMultiplier).toFixed(2));
            engineResult = { win: true, payout, multiplier: cashoutMultiplier };
          }
        }
      } else {
        // Normal engine cashout for non-new users
        try {
          engineResult = engineCashOut(user.id);
        } catch (err) {
          logger.error("Engine cashOut error", { message: err && err.message ? err.message : String(err) });
          const e = new Error('Server error during cashout');
          e.status = 500;
          throw e;
        }
      }

      if (!engineResult.win) {
        await client.query(
          `UPDATE bets SET status = 'lost', payout = $1, updatedat = NOW() WHERE id = $2`,
          [0, bet.id]
        );

        // ✅ V2: Update last_game_outcome to 'loss'
        await client.query(
          `UPDATE users SET last_game_outcome = 'loss', updatedat = NOW() WHERE id = $1`,
          [user.id]
        );

        try { metrics.incrementCashout(0); } catch (e) { logger.warn('metrics.incrementCashout_failed_loss', { message: e && e.message ? e.message : String(e) }); }
        return { success: false, payout: 0, multiplier: engineResult.multiplier, balance: null };
      }

      const payout = Number(engineResult.payout);
      const updateUser = await client.query(
        `UPDATE users SET balance = balance + $1, last_game_outcome = 'win', updatedat = NOW() WHERE id = $2 RETURNING balance`,
        [payout, user.id]
      );

      if (!updateUser.rowCount) {
        const e = new Error('Failed to credit user');
        e.status = 500;
        throw e;
      }

      await client.query(
        `UPDATE bets SET status = 'cashed', payout = $1, updatedat = NOW() WHERE id = $2`,
        [payout, bet.id]
      );

      try { metrics.incrementCashout(payout); } catch (e) { logger.warn('metrics.incrementCashout_failed_win', { message: e && e.message ? e.message : String(e) }); }

      return { success: true, payout, multiplier: engineResult.multiplier, balance: Number(updateUser.rows[0].balance) };
    });

    cashoutTimestamps.set(user.id, Date.now());
    pruneCashoutMapByAge();

    if (!result.success && !result.idempotent) {
      return res.json({ success: false, payout: 0, multiplier: result.multiplier });
    }
    return res.json({ success: result.success, payout: result.payout, multiplier: result.multiplier, balance: result.balance, idempotent: result.idempotent || false });
  } catch (err) {
    if (err && err.status === 400) return res.status(400).json({ error: err.message });
    if (err && err.status === 402) return res.status(402).json({ error: err.message });
    logger.error("game/cashout transaction error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ error: "Server error" });
  }
});

function cleanup() {
  try {
    if (typeof pruneInterval !== 'undefined' && pruneInterval) {
      clearInterval(pruneInterval);
    }
    try { cashoutTimestamps.clear(); } catch (e) {}
    logger.info('game.routes.cleanup_completed');
  } catch (e) {
    logger.warn('game.routes.cleanup_failed', { message: e && e.message ? e.message : String(e) });
  }
}

module.exports = router;
module.exports.cleanup = cleanup;
