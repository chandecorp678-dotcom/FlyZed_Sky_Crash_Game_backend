const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret"; // secure secret in Render env

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

router.post("/game/payout", express.json(), (req, res) => {
  try {
    const { bet, multiplier } = req.body;
    if (bet == null || multiplier == null)
      return res.status(400).json({ error: "Missing 'bet' or 'multiplier'" });
    const payout = computePayout(bet, multiplier);
    return res.json({ payout });
  } catch (err) {
    console.error("Error computing payout:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ----------------- Auth & User endpoints -----------------
router.post("/auth/register", express.json(), async (req, res) => {
  const db = req.app.locals.db;
  try {
    const { username, phone, password } = req.body || {};
    if (!username || !phone || !password)
      return res.status(400).json({ error: "username, phone and password required" });

    const existing = await db.query("SELECT id FROM users WHERE phone = $1", [phone]);
    if (existing.rows.length) return res.status(409).json({ error: "Phone already registered" });

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

    return res.status(201).json({ token, user });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/auth/login", express.json(), async (req, res) => {
  const db = req.app.locals.db;
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) return res.status(400).json({ error: "phone and password required" });

    const rowRes = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
    const row = rowRes.rows[0];
    if (!row) return res.status(401).json({ error: "Invalid credentials" });

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

// ----------------- Auth middleware -----------------
async function requireAuth(req, res, next) {
  const db = req.app.locals.db;
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: "Missing authorization token" });

  const token = match[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !payload.uid) return res.status(401).json({ error: "Invalid token" });

    const rowRes = await db.query("SELECT * FROM users WHERE id = $1", [payload.uid]);
    const row = rowRes.rows[0];
    if (!row) return res.status(401).json({ error: "User not found" });

    req.user = sanitizeUser(row);
    req.userRaw = row;
    next();
  } catch (err) {
    console.error("Auth verify error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ----------------- User routes -----------------
router.get("/users/me", requireAuth, async (req, res) => {
  return res.json(req.user);
});

router.post("/users/balance/change", requireAuth, express.json(), async (req, res) => {
  const db = req.app.locals.db;
  try {
    const delta = Number(req.body?.delta);
    if (isNaN(delta)) return res.status(400).json({ error: "delta must be a number" });

    const newBalance = req.user.balance + delta;
    if (newBalance < 0) return res.status(400).json({ error: "Insufficient funds" });

    const now = new Date().toISOString();
    await db.query("UPDATE users SET balance=$1, updatedat=$2 WHERE id=$3", [newBalance, now, req.user.id]);

    const rowRes = await db.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
    return res.json(sanitizeUser(rowRes.rows[0]));
  } catch (err) {
    console.error("Balance change error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/users/deposit", requireAuth, express.json(), async (req, res) => {
  const amount = Number(req.body?.amount);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
  req.body = { delta: amount };
  return router.handle(req, res);
});

router.post("/users/withdraw", requireAuth, express.json(), async (req, res) => {
  const amount = Number(req.body?.amount);
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
  req.body = { delta: -Math.abs(amount) };
  return router.handle(req, res);
});

module.exports = router;
