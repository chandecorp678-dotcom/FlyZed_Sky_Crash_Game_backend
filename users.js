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
    balance: Number(row.balance || 0),
    freeRounds: Number(row.freerounds || 0),
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
      const now = new Date().toISOString();
      const password_hash = await bcrypt.hash(trimmedPassword, 10);

      await db.query(
        `INSERT INTO users (id, username, phone, password_hash, balance, freerounds, createdat, updatedat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, trimmedUsername, trimmedPhone, password_hash, 0, 0, now, now]
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

const changeBalanceHandler = wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  let delta = Number(req.body?.delta);

  if (isNaN(delta)) delta = 0;

  try {
    const rowRes = await db.query(
      `UPDATE users
       SET balance = balance + $1, updatedat = NOW()
       WHERE id = $2 AND (balance + $1) >= 0
       RETURNING *`,
      [delta, req.user.id]
    );

    if (!rowRes.rowCount) {
      return sendError(res, 400, "Insufficient funds");
    }

    return res.json(sanitizeUser(rowRes.rows[0]));
  } catch (err) {
    logger.error("Balance change error:", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
});

router.post("/users/balance/change", requireAuth, express.json(), changeBalanceHandler);

// DEPOSIT - FIXED
router.post("/users/deposit", requireAuth, express.json(), wrapAsync(async (req, res) => {
  const amount = req.body?.amount;
  
  const numAmount = Number(amount);
  
  logger.info('deposit.attempt', { rawAmount: amount, numAmount, isNaN: isNaN(numAmount) });

  if (isNaN(numAmount) || numAmount <= 0) {
    return sendError(res, 400, "Deposit amount must be greater than 0");
  }
  
  req.body = { delta: numAmount };
  return changeBalanceHandler(req, res);
}));

// WITHDRAW - FIXED
router.post("/users/withdraw", requireAuth, express.json(), wrapAsync(async (req, res) => {
  const amount = req.body?.amount;
  
  const numAmount = Number(amount);
  
  logger.info('withdraw.attempt', { rawAmount: amount, numAmount, isNaN: isNaN(numAmount) });

  if (isNaN(numAmount) || numAmount <= 0) {
    return sendError(res, 400, "Withdraw amount must be greater than 0");
  }
  
  req.body = { delta: -Math.abs(numAmount) };
  return changeBalanceHandler(req, res);
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
