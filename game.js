'use strict';

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const logger = require("./logger");

const {
  joinRound,
  cashOut: engineCashOut,
  getRoundStatus
} = require("./gameEngine");

// Use JSON body parsing for POST endpoints
const json = express.json();

// Simple in-memory rate limiter for cashout per user (short window)
// Now bounded and periodically pruned to prevent unbounded memory growth
const cashoutTimestamps = new Map();
const CASHOUT_MIN_INTERVAL_MS = Number(process.env.CASHOUT_MIN_INTERVAL_MS || 1000); // default 1s
const CASHOUT_PRUNE_AGE_MS = Number(process.env.CASHOUT_PRUNE_AGE_MS || 1000 * 60 * 10); // 10min age
const MAX_CASHOUT_ENTRIES = Number(process.env.MAX_CASHOUT_ENTRIES || 20000);
const CASHOUT_PRUNE_INTERVAL_MS = Number(process.env.CASHOUT_PRUNE_INTERVAL_MS || 1000 * 60 * 5); // prune every 5 minutes

function pruneCashoutMapByAge() {
  const now = Date.now();
  for (const [key, ts] of cashoutTimestamps) {
    if (now - ts > CASHOUT_PRUNE_AGE_MS) {
      cashoutTimestamps.delete(key);
    }
  }
  // Enforce max size by deleting oldest entries
  while (cashoutTimestamps.size > MAX_CASHOUT_ENTRIES) {
    const firstKey = cashoutTimestamps.keys().next().value;
    if (!firstKey) break;
    cashoutTimestamps.delete(firstKey);
  }
}

// Periodic prune (unref so it won't keep process alive)
const pruneInterval = setInterval(() => {
  try { pruneCashoutMapByAge(); } catch (e) { logger.warn('game.cashout.prune_failed', { message: e && e.message ? e.message : String(e) }); }
}, CASHOUT_PRUNE_INTERVAL_MS);
if (typeof pruneInterval.unref === 'function') pruneInterval.unref();

/* ---------------- START ROUND (place bet and join global round) ---------------- */
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

  const betAmount = Number(req.body?.betAmount);
  if (!betAmount || isNaN(betAmount) || betAmount <= 0) {
    return res.status(400).json({ error: "Invalid bet amount" });
  }

  const status = getRoundStatus();
  if (!status || status.status !== "running") {
    return res.status(400).json({ error: "No active running round" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const updateRes = await client.query(
      `UPDATE users
       SET balance = balance - $1, updatedat = NOW()
       WHERE id = $2 AND balance >= $1
       RETURNING balance`,
       [betAmount, user.id]
    );

    if (!updateRes.rowCount) {
      await client.query("ROLLBACK");
      return res.status(402).json({ error: "Insufficient funds" });
    }

    const betId = crypto.randomUUID();
    await client.query(
      `INSERT INTO bets (id, round_id, user_id, bet_amount, status, createdat, updatedat)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
       [betId, status.roundId, user.id, betAmount, "active"]
    );

    await client.query("COMMIT");

    // Join in-memory round
    try {
      const engineResp = joinRound(user.id, betAmount);
      return res.json({ betId, roundId: engineResp.roundId, serverSeedHash: engineResp.serverSeedHash, startedAt: engineResp.startedAt, balance: Number(updateRes.rows[0].balance) });
    } catch (err) {
      // refund on join failure
      const refundClient = await db.connect();
      try {
        await refundClient.query("BEGIN");
        await refundClient.query(
          `UPDATE users SET balance = balance + $1, updatedat = NOW() WHERE id = $2`,
          [betAmount, user.id]
        );
        await refundClient.query(
          `UPDATE bets SET status = 'refunded', updatedat = NOW() WHERE id = $1`,
          [betId]
        );
        await refundClient.query("COMMIT");
      } catch (e2) {
        await refundClient.query("ROLLBACK");
        logger.error("Failed to refund after joinRound failure", { message: e2 && e2.message ? e2.message : String(e2) });
      } finally {
        try { refundClient.release(); } catch (e) {}
      }
      logger.error("joinRound error after DB changes", { message: err && err.message ? err.message : String(err) });
      return res.status(500).json({ error: "Failed to join round" });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("game/start transaction error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ error: "Server error" });
  } finally {
    try { client.release(); } catch (e) {}
  }
});

/* ---------------- ROUND STATUS ---------------- */
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

/* ---------------- CASH OUT ---------------- */
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

  // Rate-limit quick repeated cashouts
  const last = cashoutTimestamps.get(user.id) || 0;
  if (Date.now() - last < CASHOUT_MIN_INTERVAL_MS) {
    // record attempt for telemetry then return
    cashoutTimestamps.set(user.id, Date.now());
    pruneCashoutMapByAge();
    return res.status(429).json({ error: "Too many cashout attempts; slow down" });
  }
  // mark attempt time (prevents tiny race loops)
  cashoutTimestamps.set(user.id, Date.now());
  pruneCashoutMapByAge();

  const status = getRoundStatus();
  if (!status || status.status !== "running") {
    return res.status(400).json({ error: "No active running round" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const betRes = await client.query(
      `SELECT id, round_id, user_id, bet_amount, status
       FROM bets
       WHERE user_id = $1 AND status = 'active' AND round_id = $2
       FOR UPDATE`,
       [user.id, status.roundId]
    );

    if (!betRes.rowCount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No active bet found for current round" });
    }

    const bet = betRes.rows[0];

    let engineResult;
    try {
      engineResult = engineCashOut(user.id);
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error("Engine cashOut error", { message: err && err.message ? err.message : String(err) });
      return res.status(500).json({ error: "Server error during cashout" });
    }

    if (!engineResult.win) {
      await client.query(
        `UPDATE bets SET status = 'lost', payout = $1, updatedat = NOW() WHERE id = $2`,
        [0, bet.id]
      );
      await client.query("COMMIT");
      // update rate limiter to now (already set above)
      cashoutTimestamps.set(user.id, Date.now());
      pruneCashoutMapByAge();
      return res.json({ success: false, payout: 0, multiplier: engineResult.multiplier });
    }

    const payout = Number(engineResult.payout);
    const updateUser = await client.query(
      `UPDATE users SET balance = balance + $1, updatedat = NOW() WHERE id = $2 RETURNING balance`,
      [payout, user.id]
    );

    if (!updateUser.rowCount) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "Failed to credit user" });
    }

    await client.query(
      `UPDATE bets SET status = 'cashed', payout = $1, updatedat = NOW() WHERE id = $2`,
      [payout, bet.id]
    );

    await client.query("COMMIT");

    cashoutTimestamps.set(user.id, Date.now());
    pruneCashoutMapByAge();

    return res.json({ success: true, payout, multiplier: engineResult.multiplier, balance: Number(updateUser.rows[0].balance) });
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("game/cashout transaction error", { message: err && err.message ? err.message : String(err) });
    return res.status(500).json({ error: "Server error" });
  } finally {
    try { client.release(); } catch (e) {}
  }
});

module.exports = router;
