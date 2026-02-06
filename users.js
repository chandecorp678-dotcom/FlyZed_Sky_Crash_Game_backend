const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const logger = require("./logger");
const { sendError, sendSuccess, wrapAsync } = require("./apiResponses");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret"; // secure secret in Render env

// ----------------- Helper ----------------- //
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

// ... (health and game helpers unchanged) ... //

// ----------------- Auth middleware (unchanged) ----------------- //

// ----------------- User routes ----------------- //
router.get("/users/me", requireAuth, (req, res) => {
  return res.json(req.user);
}

// Extracted handler for changing balance — now atomic update to avoid race conditions //
const changeBalanceHandler = wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const delta = Number(req.body?.delta);
  if (isNaN(delta)) return sendError(res, 400, "delta must be a number");

  // Perform atomic update: ensure balance never goes negative and return the new row //
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

// Route uses the extracted handler //
router.post("/users/balance/change", requireAuth, express.json(), changeBalanceHandler);

// Deposit route //
router.post("/users/deposit", requireAuth, express.json(), wrapAsync(async (req, res) => {
  const amount = Number(req.body?.amount);
  if (isNaN(amount) || amount <= 0) return sendError(res, 400, "amount must be > 0");
  // reuse the balance handler by adjusting req.body
  req.body = { delta: amount };
  return changeBalanceHandler(req, res);
}));

// Withdraw route //
router.post("/users/withdraw", requireAuth, express.json(), wrapAsync(async (req, res) => {
  const amount = Number(req.body?.amount);
  if (isNaN(amount) || amount <= 0) return sendError(res, 400, "amount must be > 0");
  req.body = { delta: -Math.abs(amount) };
  return changeBalanceHandler(req, res);
}));

module.exports = router; 
