'use strict';

const express = require("express");
const router = express.Router();

const {
  joinRound,
  cashOut,
  getRoundStatus
} = require("./gameEngine");

/* ---------------- START ROUND ---------------- */

router.post("/start", (req, res) => {
  const { betAmount } = req.body;
  const userId = req.user?.id || req.body.userId || "guest";

  if (!betAmount || betAmount <= 0) {
    return res.status(400).json({ error: "Invalid bet amount" });
  }

  try {
    const data = joinRound(userId, betAmount);
    return res.json(data);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/* ---------------- ROUND STATUS ---------------- */
/**
 * Frontend polls this to know if round has crashed
 */
router.get("/status", (req, res) => {
  try {
    const status = getRoundStatus();
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ---------------- CASH OUT ---------------- */

router.post("/cashout", (req, res) => {
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
