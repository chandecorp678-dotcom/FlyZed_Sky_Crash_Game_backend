'use strict';

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const logger = require("./logger");
const { sendError, sendSuccess, wrapAsync } = require("./apiResponses");
const cache = require("./cache");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret"; // secure secret in Render env

// Phase 9.1: Validation constants
const MIN_PASSWORD_LENGTH = 6;
const MAX_USERNAME_LENGTH = 100;
const PHONE_REGEX = /^[+]?[\d\s\-()]{7,15}$/; // Basic international phone validation

// Phase 9.1: Validate password strength
function validatePassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  return { valid: true };
}

// Phase 9.1: Validate phone number format
function validatePhone(phone) {
  if (!phone || !PHONE_REGEX.test(phone)) {
    return { valid: false, error: "Phone number format invalid" };
  }
  return { valid: true };
}

// Phase 9.1: Validate username
function validateUsername(username) {
  if (!username || username.length < 2 || username.length > MAX_USERNAME_LENGTH) {
    return { valid: false, error: `Username must be between 2 and ${MAX_USERNAME_LENGTH} characters` };
  }
  return { valid: true };
}

// Phase 9.1: Sanitize user input (prevent injection)
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input.trim().slice(0, 500); // limit length
}

// ----------------- Helper -----------------
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

// ----------------- Health + Game helpers -----------------
router.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

const { computePayout } = require("./gameEngine");
router.get("/game/round", (req, res) => {
  try {
    // Keep this endpoint as a helper to get a sample crash point (for dev)
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

// ----------------- Auth & User endpoints -----------------
router.post("/auth/register", express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  let { username, phone, password } = req.body || {};

  // Phase 9.1: Sanitize inputs
  username = sanitizeInput(username);
  phone = sanitizeInput(phone);
  password = sanitizeInput(password);

  // Phase 9.1: Validate inputs
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) return sendError(res, 400, usernameValidation.error);

  const phoneValidation = validatePhone(phone);
  if (!phoneValidation.valid) return sendError(res, 400, phoneValidation.error);

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) return sendError(res, 400, passwordValidation.error);

  const existing = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
  if (existing.rows.length) return sendError(res, 409, "Phone already registered");

  const id = uuidv4();
  const now = new Date().toISOString();
  const password_hash = await bcrypt.hash(password, 10);

  await db.query(
    `INSERT INTO users (id, username, phone, password_hash, balance, freerounds, createdat, updatedat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, username, phone, password_hash, 0, 0, now, now]
  );

  const userRow = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  const user = sanitizeUser(userRow.rows[0]);
  const token = jwt.sign({ uid: id }, JWT_SECRET, { expiresIn: "30d" });

  logger.info('auth.register.success', { userId: id, phone });

  return res.status(201).json({ token, user });
}));

router.post("/auth/login", express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  let { phone, password } = req.body || {};

  // Phase 9.1: Sanitize inputs
  phone = sanitizeInput(phone);
  password = sanitizeInput(password);

  if (!phone || !password) return sendError(res, 400, "phone and password required");

  const rowRes = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
  const row = rowRes.rows[0];
  if (!row) return sendError(res, 401, "Invalid credentials");

  const ok = await bcrypt.compare(password, row.password_hash || "");
  if (!ok) {
    logger.warn('auth.login.invalid_password', { phone });
    return sendError(res, 401, "Invalid credentials");
  }

  const user = sanitizeUser(row);
  const token = jwt.sign({ uid: row.id }, JWT_SECRET, { expiresIn: "30d" });

  logger.info('auth.login.success', { userId: row.id, phone });

  return res.json({ token, user });
}));

// ----------------- Auth middleware -----------------
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
    logger.error("Auth verify error", { message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : undefined });
    return sendError(res, 401, "Invalid or expired token", err && err.message ? err.message : undefined);
  }
}

// ----------------- User routes -----------------
router.get("/users/me", requireAuth, (req, res) => {
  return res.json(req.user);
});

// Extracted handler for changing balance — atomic update
const changeBalanceHandler = wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const delta = Number(req.body?.delta);
  if (isNaN(delta)) return sendError(res, 400, "delta must be a number");

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

router.post("/users/deposit", requireAuth, express.json(), wrapAsync(async (req, res) => {
  const amount = Number(req.body?.amount);
  if (isNaN(amount) || amount <= 0) return sendError(res, 400, "amount must be > 0");
  req.body = { delta: amount };
  return changeBalanceHandler(req, res);
}));

router.post("/users/withdraw", requireAuth, express.json(), wrapAsync(async (req, res) => {
  const amount = Number(req.body?.amount);
  if (isNaN(amount) || amount <= 0) return sendError(res, 400, "amount must be > 0");
  req.body = { delta: -Math.abs(amount) };
  return changeBalanceHandler(req, res);
}));

// ----------------- Public game history endpoints with caching -----------------

// Cache TTLs (ms)
const HISTORY_CACHE_TTL_MS = Number(process.env.HISTORY_CACHE_TTL_MS || 15_000); // 15s
const ROUND_CACHE_TTL_MS = Number(process.env.ROUND_CACHE_TTL_MS || 5_000); // 5s

function isAdminRequest(req) {
  const t = req.get("x-admin-token") || "";
  return !!t;
}

/**
 * GET /api/game/history?limit=50&since=<iso|epoch-ms>&force=1
 * - Cached for HISTORY_CACHE_TTL_MS unless admin header present or force=1 query param.
 */
router.get("/game/history", wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  if (!db) {
    logger.error("game.history: DB not initialized");
    return sendError(res, 500, "Database not initialized");
  }

  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
  const since = req.query.since || null;

  const cacheKey = `history:limit=${limit}:since=${since || ''}`;

  // bypass cache for admin requests or explicit force
  if (!isAdminRequest(req) && !force) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }
  }

  try {
    let query = `
      SELECT round_id, crash_point, server_seed_hash, started_at, ended_at, meta, commit_idx
      FROM rounds
    `;
    const params = [];
    if (since) {
      params.push(since);
      query += ` WHERE started_at >= $${params.length}`;
    }
    query += ` ORDER BY started_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const rows = await db.query(query, params);
    const payload = { rounds: rows.rows || [] };

    // store in cache (non-admin requests only)
    if (!isAdminRequest(req) && !force) cache.set(cacheKey, payload, HISTORY_CACHE_TTL_MS);

    return res.json(payload);
  } catch (err) {
    logger.error("game.history.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
}));

/**
 * GET /api/game/rounds/:roundId
 * - Cached short-term to speed repeated detail views.
 */
router.get("/game/rounds/:roundId", wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const roundId = req.params.roundId;
  if (!roundId) return sendError(res, 400, "roundId required");
  if (!db) {
    logger.error("game.rounds.detail: DB not initialized");
    return sendError(res, 500, "Database not initialized");
  }

  const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
  const cacheKey = `round:${roundId}`;

  if (!isAdminRequest(req) && !force) {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);
  }

  try {
    const r = await db.query(`SELECT round_id, crash_point, server_seed_hash, server_seed, commit_idx, started_at, ended_at, meta FROM rounds WHERE round_id = $1`, [roundId]);
    if (!r.rowCount) return sendError(res, 404, "Round not found");

    const bets = await db.query(`SELECT id, user_id, bet_amount, payout, status, meta, createdat FROM bets WHERE round_id = $1 ORDER BY createdat ASC`, [roundId]);

    const payload = { round: r.rows[0], bets: bets.rows || [] };

    if (!isAdminRequest(req) && !force) cache.set(cacheKey, payload, ROUND_CACHE_TTL_MS);

    return res.json(payload);
  } catch (err) {
    logger.error("game.round.detail.error", { message: err && err.message ? err.message : String(err) });
    return sendError(res, 500, "Server error");
  }
}));

/* ----------------- Provably-fair endpoints ----------------- */

/**
 * GET /api/game/commitments/latest
 * Returns the latest pre-committed seed hash and idx (public).
 * Example: { idx: 123, seed_hash: "abcd...", created_at: "..." }
 */
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

/**
 * GET /api/game/reveal/:roundId
 * Returns revealed serverSeed for a finished round (so clients can verify).
 * Example response: { roundId, commitIdx, serverSeed, serverSeedHash, revealedAt, crashPoint }
 */
router.get("/game/reveal/:roundId", wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const roundId = req.params.roundId;
  if (!roundId) return sendError(res, 400, "roundId required");

  try {
    const r = await db.query(`SELECT round_id, server_seed_hash, server_seed, server_seed_revealed_at, started_at, ended_at, crash_point, commit_idx FROM rounds WHERE round_id = $1`, [roundId]);
    if (!r.rowCount) return sendError(res, 404, "Round not found");

    const row = r.rows[0];
    if (!row.server_seed) return sendError(res, 400, "Seed not revealed yet for this round");

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
