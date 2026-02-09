'use strict';

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const logger = require("./logger");
const { runTransaction } = require("./dbHelper");
const metrics = require("./metrics");

const {
  joinRound,
  cashOut: engineCashOut,
  getRoundStatus
} = require("./gameEngine");

// Use JSON body parsing for POST endpoints
const json = express.json();

// In-memory cashout rate limiter with pruning (unchanged)
const cashoutTimestamps = new Map();
const CASHOUT_MIN_INTERVAL_MS = Number(process.env.CASHOUT_MIN_INTERVAL_MS || 1000);
const CASHOUT_PRUNE_AGE_MS = Number(process.env.CASHOUT_PRUNE_AGE_MS || 1000 * 60 * 10);
const MAX_CASHOUT_ENTRIES = Number(process.env.MAX_CASHOUT_ENTRIES || 20000);
const CASHOUT_PRUNE_INTERVAL_MS = Number(process.env.CASHOUT_PRUNE_INTERVAL_MS || 1000 * 60 * 5);

// Min/max bet amounts (Phase 9.2 preparation – can be configured via env)
const MIN_BET_AMOUNT = Number(process.env.MIN_BET_AMOUNT || 1);
const MAX_BET_AMOUNT = Number(process.env.MAX_BET_AMOUNT || 1000000);

// Phase 9.2: Sanitize numeric input (prevent negative/extreme values)
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

// ---------------- START ROUND (place bet and join global round) ----------------
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

  // Phase 9.2: Sanitize bet amount
  let betAmount = sanitizeNumeric(req.body?.betAmount, MIN_BET_AMOUNT, MAX_BET_AMOUNT);
  if (betAmount === null || betAmount < MIN_BET_AMOUNT) {
    return res.status(400).json({ error: `Bet amount must be between ${MIN_BET_AMOUNT} and ${MAX_BET_AMOUNT}` });
  }

  if (betAmount > MAX_BET_AMOUNT) {
    return res.status(400).json({ error: `Bet amount must not exceed ${MAX_BET_AMOUNT}` });
  }

  const status = getRoundStatus();
  if (!status || status.status !== "running") {
    return res.status(400).json({ error: "No active running round" });
  }

  try {
    const txResult = await runTransaction(db, async (client) => {
      // Phase 9.1: Check if user already has active bet on this round
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

      // Proceed with balance deduction and bet creation
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

      const betId = crypto.randomUUID();
      await client.query(
        `INSERT INTO bets (id, round_id, user_id, bet_amount, status, createdat, updatedat)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
         [betId, status.roundId, user.id, betAmount, "active"]
      );

      return { betId, balance: Number(updateRes.rows[0].balance) };
    });

    // Successful DB commit -> record metrics (bet count + volume)
    try {
      metrics.incrementBet(betAmount);
    } catch (e) {
      logger.warn('metrics.incrementBet_failed_after_start', { message: e && e.message ? e.message : String(e) });
    }

    // After commit: join in-memory round. If join fails, refund in a safe tx.
    try {
      const engineResp = joinRound(user.id, betAmount);
      return res.json({ betId: txResult.betId, roundId: engineResp.roundId, serverSeedHash: engineResp.serverSeedHash, startedAt: engineResp.startedAt, balance: txResult.balance });
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
    logger.error("game/start transaction error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------- ROUND STATUS ----------------
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

// ---------------- CASH OUT ----------------
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
        `SELECT id, round_id, user_id, bet_amount, status, payout
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

      // Phase 9.1: Idempotency check – if already cashed out, return original payout
      if (bet.status === 'cashed') {
        logger.info('game.cashout.idempotent_already_cashed', { userId: user.id, betId: bet.id, roundId: bet.round_id });
        // Return the original payout without paying again
        const userBalance = await client.query(`SELECT balance FROM users WHERE id = $1`, [user.id]);
        return { success: true, payout: Number(bet.payout || 0), multiplier: null, balance: Number(userBalance.rows[0]?.balance || 0), idempotent: true };
      }

      if (bet.status !== 'active') {
        // Bet already lost/refunded
        logger.info('game.cashout.bet_not_active', { userId: user.id, betId: bet.id, status: bet.status });
        return { success: false, payout: 0, multiplier: null, balance: null, idempotent: true };
      }

      let engineResult;
      try {
        engineResult = engineCashOut(user.id);
      } catch (err) {
        logger.error("Engine cashOut error", { message: err && err.message ? err.message : String(err) });
        const e = new Error('Server error during cashout');
        e.status = 500;
        throw e;
      }

      if (!engineResult.win) {
        await client.query(
          `UPDATE bets SET status = 'lost', payout = $1, updatedat = NOW() WHERE id = $2`,
          [0, bet.id]
        );
        // record metrics for cashout attempt (payout 0)
        try { metrics.incrementCashout(0); } catch (e) { logger.warn('metrics.incrementCashout_failed_loss', { message: e && e.message ? e.message : String(e) }); }
        return { success: false, payout: 0, multiplier: engineResult.multiplier, balance: null };
      }

      const payout = Number(engineResult.payout);
      const updateUser = await client.query(
        `UPDATE users SET balance = balance + $1, updatedat = NOW() WHERE id = $2 RETURNING balance`,
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

      // record metrics for successful cashout
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

/* CLEANUP */
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
