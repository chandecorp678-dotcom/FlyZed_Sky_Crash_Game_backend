'use strict';

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const logger = require("./logger");
const { sendError, sendSuccess, wrapAsync } = require("./apiResponses");
const cache = require("./cache");
const RateLimiter = require("./rateLimiter");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";

const registerLimiter = new RateLimiter({
  maxRequests: 10,
  windowMs: 3600000
});

const loginLimiter = new RateLimiter({
  maxRequests: 10,
  windowMs: 900000
});

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    phone: row.phone,
    balance: Number(row.balance || 0),  // ✅ FORCE NUMBER
    freeRounds: Number(row.freerounds || 0),  // ✅ FORCE NUMBER
    zilsUuid: row.zils_uuid,  // ✅ ADD: Include in response
    createdAt: row.createdat,
    updatedAt: row.updatedat,
  };
}

router.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

const { computePayout } = require("./gameEngine");
router.get("/game/round", (req, res) => {
  try {
    return res.json({ ok: true });
  } catch (err) {
    logger.error("Error generating crash point:", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

router.post("/game/payout", express.json(), (req, res) => {
  try {
    const { bet, multiplier } = req.body;
    if (bet == null || multiplier == null)
      return sendError(res, 400, "Missing 'bet' or 'multiplier'");
    const payout = computePayout(bet, multiplier);
    return res.json({ payout });
  } catch (err) {
    logger.error("Error computing payout:", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

// REGISTER
router.post("/auth/register", 
  registerLimiter.middleware({
    keyFn: (req) => req.ip,
    onLimitExceeded: (req, res) => sendError(res, 429, "Too many registration attempts. Please try again later.")
  }),
  express.json(), 
  wrapAsync(async (req, res) => {
    const db = req.app.locals.db;
    const { username, phone, password } = req.body || {};

    if (!phone || String(phone).trim().length === 0) {
      return sendError(res, 400, "Phone number is required");
    }

    if (!password || String(password).trim().length === 0) {
      return sendError(res, 400, "Password is required");
    }

    if (!username || String(username).trim().length === 0) {
      return sendError(res, 400, "Username is required");
    }

    const trimmedPhone = String(phone).trim();
    const trimmedUsername = String(username).trim();
    const trimmedPassword = String(password).trim();

    try {
      const existing = await db.query("SELECT id FROM users WHERE phone = $1", [trimmedPhone]);
      if (existing.rows.length > 0) {
        return sendError(res, 409, "Phone number already registered");
      }

      const id = uuidv4();
       const zilsUuid = uuidv4();  // ✅ ADD: Generate Zils UUID
      const now = new Date().toISOString();
      const password_hash = await bcrypt.hash(trimmedPassword, 10);

      // ✅ ADD: Insert with zils_uuid column
      await db.query(
        `INSERT INTO users (id, username, phone, password_hash, balance, freerounds, createdat, updatedat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, trimmedUsername, trimmedPhone, password_hash, 0, 0, zilsUuid, now, now]
      );

      const userRow = await db.query("SELECT * FROM users WHERE id = $1", [id]);
      const user = sanitizeUser(userRow.rows[0]);
      const token = jwt.sign({ uid: id }, JWT_SECRET, { expiresIn: "30d" });

      logger.info('auth.register.success', { userId: id, username: trimmedUsername, phone: trimmedPhone });

      return res.status(201).json({ token, user });
    } catch (err) {
      logger.error('auth.register.error', { message: err && err.message ? err.message : String(err) });
      
      if (err.code === '23505') {
        return sendError(res, 409, "Phone number already registered");
      }

      return sendError(res, 400, "Registration failed: " + (err && err.message ? err.message : "Unknown error"));
    }
  })
);

// LOGIN
router.post("/auth/login",
  loginLimiter.middleware({
    keyFn: (req) => req.ip,
    onLimitExceeded: (req, res) => sendError(res, 429, "Too many login attempts. Please try again later.")
  }),
  express.json(),
  wrapAsync(async (req, res) => {
    const db = req.app.locals.db;
    const { phone, password } = req.body || {};

    if (!phone || String(phone).trim().length === 0) {
      return sendError(res, 400, "Phone number is required");
    }

    if (!password || String(password).trim().length === 0) {
      return sendError(res, 400, "Password is required");
    }

    const trimmedPhone = String(phone).trim();
    const trimmedPassword = String(password).trim();

    try {
      const rowRes = await db.query("SELECT * FROM users WHERE phone = $1", [trimmedPhone]);
      const row = rowRes.rows[0];
      
      if (!row) {
        logger.warn('auth.login.user_not_found', { phone: trimmedPhone });
        return sendError(res, 401, "Invalid phone or password");
      }

      const ok = await bcrypt.compare(trimmedPassword, row.password_hash || "");
      if (!ok) {
        logger.warn('auth.login.invalid_password', { phone: trimmedPhone });
        return sendError(res, 401, "Invalid phone or password");
      }

      const user = sanitizeUser(row);
      const token = jwt.sign({ uid: row.id }, JWT_SECRET, { expiresIn: "30d" });

      logger.info('auth.login.success', { userId: row.id, phone: trimmedPhone });

      return res.json({ token, user });
    } catch (err) {
      logger.error('auth.login.error', { message: err && err.message ? err.message : String(err) });
      return sendError(res, 500, "Server error");
    }
  })
);

// AUTH MIDDLEWARE
async function requireAuth(req, res, next) {
  const db = req.app.locals.db;
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return sendError(res, 401, "Missing authorization token");

  const token = match[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !payload.uid) return sendError(res, 401, "Invalid token");

    const rowRes = await db.query("SELECT * FROM users WHERE id = $1", [payload.uid]);
    const row = rowRes.rows[0];
    if (!row) return sendError(res, 401, "User not found");

    req.user = sanitizeUser(row);
    req.userRaw = row;
    next();
  } catch (err) {
    logger.error("Auth verify error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 401, "Invalid or expired token");
  }
}

router.get("/users/me", requireAuth, (req, res) => {
  return res.json(req.user);
});

// ============ DEPOSIT ENDPOINT - FORCES NUMBER ============
router.post("/users/deposit", requireAuth, express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  
  // Get amount from body - accept anything, even 0, null, undefined
  let amount = req.body?.amount;
  
  // Convert to number, default to 0 if invalid
  amount = Number(amount);
  if (isNaN(amount)) {
    amount = 0;
  }
  
  // Make amount positive
  amount = Math.abs(amount);
  
  logger.info('deposit.attempt', { userId, amount, requestBody: req.body });

  try {
    // Log BEFORE update
    const beforeUpdate = await db.query(
      `SELECT id, balance FROM users WHERE id = $1`,
      [userId]
    );
    logger.info('deposit.before_update', { 
      userId, 
      balanceBefore: beforeUpdate.rows[0]?.balance 
    });

    // Update balance - accept any amount including 0
    const rowRes = await db.query(
      `UPDATE users
       SET balance = balance + $1, updatedat = NOW()
       WHERE id = $2
       RETURNING *`,
      [amount, userId]
    );

    logger.info('deposit.after_query', { 
      rowCount: rowRes.rowCount,
      balanceAfter: rowRes.rows[0]?.balance
    });

    if (!rowRes.rowCount) {
      logger.warn('deposit.user_not_found', { userId });
      return sendError(res, 404, "User not found");
    }

    const updatedUser = sanitizeUser(rowRes.rows[0]);
    
    logger.info('deposit.success', { 
      userId, 
      depositAmount: amount, 
      newBalance: updatedUser.balance,
      sanitizedUser: updatedUser
    });

    return res.json(updatedUser);
  } catch (err) {
    logger.error("deposit.error", { 
      userId, 
      amount, 
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined
    });
    return sendError(res, 500, "Deposit failed: " + (err && err.message ? err.message : "Unknown error"));
  }
}));

// ============ WITHDRAW ENDPOINT - FORCES NUMBER & CHECKS BALANCE ============
router.post("/users/withdraw", requireAuth, express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  
  // Get amount from body
  let amount = req.body?.amount;
  
  // Convert to number, default to 0 if invalid
  amount = Number(amount);
  if (isNaN(amount)) {
    amount = 0;
  }
  
  // Make amount positive
  amount = Math.abs(amount);
  
  logger.info('withdraw.attempt', { userId, amount, requestBody: req.body });

  try {
    // First, check current balance
    const userCheck = await db.query(
      `SELECT balance FROM users WHERE id = $1`,
      [userId]
    );

    if (!userCheck.rowCount) {
      logger.warn('withdraw.user_not_found', { userId });
      return sendError(res, 404, "User not found");
    }

    const currentBalance = Number(userCheck.rows[0].balance || 0);

    // Check if user has enough balance
    if (currentBalance < amount) {
      logger.warn('withdraw.insufficient_balance', { 
        userId, 
        requestedAmount: amount, 
        currentBalance 
      });
      return sendError(res, 402, `Insufficient balance. You have K ${currentBalance.toFixed(2)}, but requested K ${amount.toFixed(2)}`);
    }

    // Update balance - deduct only if sufficient funds
    const rowRes = await db.query(
      `UPDATE users
       SET balance = balance - $1, updatedat = NOW()
       WHERE id = $2
       RETURNING *`,
      [amount, userId]
    );

    if (!rowRes.rowCount) {
      logger.warn('withdraw.update_failed', { userId });
      return sendError(res, 500, "Failed to process withdrawal");
    }

    const updatedUser = sanitizeUser(rowRes.rows[0]);
    
    logger.info('withdraw.success', { 
      userId, 
      withdrawAmount: amount, 
      previousBalance: currentBalance,
      newBalance: updatedUser.balance,
      sanitizedUser: updatedUser
    });

    return res.json(updatedUser);
  } catch (err) {
    logger.error("withdraw.error", { 
      userId, 
      amount, 
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined
    });
    return sendError(res, 500, "Withdrawal failed: " + (err && err.message ? err.message : "Unknown error"));
  }
}));

const HISTORY_CACHE_TTL_MS = 15000;
const ROUND_CACHE_TTL_MS = 5000;

function isAdminRequest(req) {
  const t = req.get("x-admin-token") || "";
  return !!t;
}

router.get("/game/history", wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  if (!db) {
    return sendError(res, 500, "Database not initialized");
  }

  let limit = Number(req.query.limit) || 50;
  if (limit > 200) limit = 200;
  if (limit < 1) limit = 1;

  const cacheKey = `history:limit=${limit}`;

  if (!isAdminRequest(req)) {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
  }

  try {
    const rows = await db.query(
      `SELECT round_id, crash_point, server_seed_hash, started_at, ended_at, meta, commit_idx
       FROM rounds ORDER BY started_at DESC LIMIT $1`,
      [limit]
    );

    const payload = { rounds: rows.rows || [] };
    if (!isAdminRequest(req)) cache.set(cacheKey, payload, HISTORY_CACHE_TTL_MS);
    return res.json(payload);
  } catch (err) {
    logger.error("game.history.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
}));

router.get("/game/rounds/:roundId", wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const roundId = req.params.roundId;
  if (!roundId) return sendError(res, 400, "roundId required");
  if (!db) return sendError(res, 500, "Database not initialized");

  const cacheKey = `round:${roundId}`;

  if (!isAdminRequest(req)) {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
  }

  try {
    const r = await db.query(`SELECT * FROM rounds WHERE round_id = $1`, [roundId]);
    if (!r.rowCount) return sendError(res, 404, "Round not found");

    const bets = await db.query(`SELECT * FROM bets WHERE round_id = $1 ORDER BY createdat ASC`, [roundId]);
    const payload = { round: r.rows[0], bets: bets.rows || [] };

    if (!isAdminRequest(req)) cache.set(cacheKey, payload, ROUND_CACHE_TTL_MS);
    return res.json(payload);
  } catch (err) {
    logger.error("game.round.detail.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
}));

router.get("/game/commitments/latest", wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  try {
    const r = await db.query(`SELECT idx, seed_hash, created_at FROM seed_commits ORDER BY idx DESC LIMIT 1`);
    if (!r.rowCount) return sendError(res, 404, "No commitments found");
    return res.json(r.rows[0]);
  } catch (err) {
    logger.error("commitments.latest.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
}));

router.get("/game/reveal/:roundId", wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const roundId = req.params.roundId;
  if (!roundId) return sendError(res, 400, "roundId required");

  try {
    const r = await db.query(`SELECT * FROM rounds WHERE round_id = $1`, [roundId]);
    if (!r.rowCount) return sendError(res, 404, "Round not found");

    const row = r.rows[0];
    if (!row.server_seed) return sendError(res, 400, "Seed not revealed yet");

    return res.json({
      roundId: row.round_id,
      commitIdx: row.commit_idx,
      serverSeed: row.server_seed,
      serverSeedHash: row.server_seed_hash,
      revealedAt: row.server_seed_revealed_at,
      crashPoint: row.crash_point,
      startedAt: row.started_at,
      endedAt: row.ended_at
    });
  } catch (err) {
    logger.error("reveal.endpoint.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
}));

module.exports = router;
