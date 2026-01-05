const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret"; // set a secure secret in Render env

// small helper to remove sensitive fields before returning user to client
function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    phone: row.phone,
    balance: Number(row.balance || 0),
    freeRounds: Number(row.freeRounds || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ----------------- Health + Game helpers -----------------

// health endpoint for frontend probe
router.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * GET /api/game/round
 * Returns a freshly generated crash point for a round.
 * Example response: { "crashPoint": 1.34 }
 */
const { generateCrashPoint, computePayout } = require("./gameEngine");
router.get("/game/round", (req, res) => {
  try {
    const crashPoint = generateCrashPoint();
    return res.json({ crashPoint });
  } catch (err) {
    console.error("Error generating crash point:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/game/payout
 * Body: { bet: number, multiplier: number }
 * Returns calculated payout for the given bet and multiplier.
 * Example response: { "payout": 12.5 }
 */
router.post("/game/payout", express.json(), (req, res) => {
  try {
    const { bet, multiplier } = req.body;
    if (bet == null || multiplier == null) {
      return res
        .status(400)
        .json({ error: "Missing 'bet' or 'multiplier' in request body" });
    }
    const payout = computePayout(bet, multiplier);
    return res.json({ payout });
  } catch (err) {
    console.error("Error computing payout:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ----------------- Auth & User endpoints -----------------

// POST /api/auth/register
// Body: { username, phone, password }
router.post("/auth/register", express.json(), async (req, res) => {
  const db = req.app.locals.db;
  try {
    const { username, phone, password } = req.body || {};
    if (!username || !phone || !password) {
      return res.status(400).json({ error: "username, phone and password required" });
    }

    // check existing phone
    const existing = await db.get("SELECT id FROM users WHERE phone = ?", phone);
    if (existing) {
      return res.status(409).json({ error: "Phone already registered" });
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const password_hash = await bcrypt.hash(password, 10);

    await db.run(
      `INSERT INTO users (id, username, phone, password_hash, balance, freeRounds, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, username, phone, password_hash, 0, 0, now, now]
    );

    const userRow = await db.get("SELECT * FROM users WHERE id = ?", id);
    const user = sanitizeUser(userRow);
    const token = jwt.sign({ uid: id }, JWT_SECRET, { expiresIn: "30d" });

    return res.status(201).json({ token, user });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/auth/login
// Body: { phone, password }
router.post("/auth/login", express.json(), async (req, res) => {
  const db = req.app.locals.db;
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) {
      return res.status(400).json({ error: "phone and password required" });
    }

    const row = await db.get("SELECT * FROM users WHERE phone = ?", phone);
    if (!row) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, row.password_hash || "");
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const user = sanitizeUser(row);
    const token = jwt.sign({ uid: row.id }, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Middleware: verify token and attach user id
async function requireAuth(req, res, next) {
  const db = req.app.locals.db;
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "Missing authorization token" });
  const token = match[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !payload.uid) return res.status(401).json({ error: "Invalid token" });
    // load user and attach
    const row = await db.get("SELECT * FROM users WHERE id = ?", payload.uid);
    if (!row) return res.status(401).json({ error: "User not found" });
    req.user = sanitizeUser(row);
    req.userRaw = row;
    next();
  } catch (err) {
    console.error("Auth verify error:", err && err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// GET /api/users/me
router.get("/users/me", requireAuth, async (req, res) => {
  return res.json(req.user);
});

// POST /api/users/balance/change
// Body: { delta: number } (can be negative)
router.post("/users/balance/change", requireAuth, express.json(), async (req, res) => {
  const db = req.app.locals.db;
  try {
    const delta = Number(req.body && req.body.delta);
    if (isNaN(delta)) return res.status(400).json({ error: "delta must be a number" });

    const currentBalance = Number(req.user.balance || 0);
    const newBalance = currentBalance + delta;
    if (newBalance < 0) return res.status(400).json({ error: "Insufficient funds" });

    const now = new Date().toISOString();
    await db.run("UPDATE users SET balance = ?, updatedAt = ? WHERE id = ?", [newBalance, now, req.user.id]);

    const row = await db.get("SELECT * FROM users WHERE id = ?", req.user.id);
    return res.json(sanitizeUser(row));
  } catch (err) {
    console.error("Balance change error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/users/deposit
// Body: { amount: number }
router.post("/users/deposit", requireAuth, express.json(), async (req, res) => {
  try {
    const amount = Number(req.body && req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
    req.body = { delta: amount };
    return router.handle(req, res); // delegate to balance/change by reusing route logic
  } catch (err) {
    console.error("Deposit error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/users/withdraw
// Body: { amount: number }
router.post("/users/withdraw", requireAuth, express.json(), async (req, res) => {
  try {
    const amount = Number(req.body && req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
    req.body = { delta: -Math.abs(amount) };
    return router.handle(req, res); // delegate to balance/change
  } catch (err) {
    console.error("Withdraw error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;