'use strict';

const express = require("express");
const router = express.Router();

const {
  startRound,
  cashOut,
  getRoundStatus
} = require("./gameEngine");

/**
 * DEMO WALLET STORE (TEMPORARY)
 * Later this will be DB-backed
 */
const wallets = new Map();

/* ---------------- WALLET HELPERS ---------------- */

function getBalance(userId) {
  if (!wallets.has(userId)) {
    wallets.set(userId, 100); // demo starting balance
  }
  return wallets.get(userId);
}

function setBalance(userId, amount) {
  wallets.set(userId, Number(amount));
}

/* ---------------- START ROUND ---------------- */

router.post("/start", (req, res) => {
  const { betAmount } = req.body;
  const userId = req.user?.id || req.body.userId || "guest";

  if (!betAmount || betAmount <= 0) {
    return res.status(400).json({ error: "Invalid bet amount" });
  }

  const balance = getBalance(userId);

  // 🔐 Prevent playing without funds
  if (balance < betAmount) {
    return res.status(400).json({ error: "Insufficient balance" });
  }

  // 🔐 Debit wallet ONCE at round start
  setBalance(userId, balance - betAmount);

  try {
    const round = startRound();

    return res.json({
      ...round,
      balance: getBalance(userId)
    });

  } catch (err) {
    // rollback safety
    setBalance(userId, balance);
    return res.status(400).json({ error: err.message });
  }
});

/* ---------------- ROUND STATUS ---------------- */
/**
 * Frontend polls this to know if round has crashed
 */
router.get("/status/:roundId", (req, res) => {
  try {
    const status = getRoundStatus(req.params.roundId);
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------------- CASH OUT ---------------- */

router.post("/cashout", (req, res) => {
  const { roundId, betAmount, multiplier } = req.body;
  const userId = req.user?.id || req.body.userId || "guest";

  if (!roundId || !betAmount || !multiplier) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
    const result = cashOut(
      roundId,
      betAmount,
      multiplier,
      userId
    );

    // 🔐 Credit wallet ONLY on win
    if (result.win) {
      const currentBalance = getBalance(userId);
      setBalance(userId, currentBalance + result.payout);
    }

    return res.json({
      success: true,
      ...result,
      balance: getBalance(userId)
    });

  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/* ---------------- EXPORT ---------------- */

module.exports = router;
