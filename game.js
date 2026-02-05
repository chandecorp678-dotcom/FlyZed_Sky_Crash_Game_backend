'use strict';

const express = require("express");
const router = express.Router();

const {
  joinRound,
  cashOut,
  getRoundStatus
} = require("./gameEngine");

// Use JSON body parsing for POST endpoints (server.js may already provide this)
const json = express.json();

/* ---------------- START ROUND ---------------- */
router.post("/start", json, (req, res) => {
  try {
    const { betAmount } = req.body;
    const userId = req.user?.id || req.body.userId || "guest";

    if (!betAmount || isNaN(betAmount) || Number(betAmount) <= 0) {
      return res.status(400).json({ error: "Invalid bet amount" });
    }

    const data = joinRound(userId, betAmount);
    return res.json(data);
  } catch (err) {
    console.error("game/start error:", err && err.message ? err.message : err);
    return res.status(400).json({ error: err.message || "Failed to join round" });
  }
});

/* ---------------- ROUND STATUS ---------------- */
/**
 * Frontend polls this to know if round has crashed
 * Returns the object from gameEngine.getRoundStatus().
 * We normalize startedAt to milliseconds if it looks like seconds for safety.
 */
router.get("/status", (req, res) => {
  try {
    const status = getRoundStatus();

    // Defensive normalization: if startedAt looks like seconds (10 digits), convert to ms
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
    console.error("game/status error:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------------- CASH OUT ---------------- */
router.post("/cashout", json, (req, res) => {
  try {
    const userId = req.user?.id || req.body.userId || "guest";

    const result = cashOut(userId);

    return res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error("game/cashout error:", err && err.message ? err.message : err);
    return res.status(400).json({
      success: false,
      error: err.message || "Cash out failed"
    });
  }
});

module.exports = router;
