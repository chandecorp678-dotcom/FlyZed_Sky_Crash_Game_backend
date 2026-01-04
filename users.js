const express = require("express");
const router = express.Router();

const users = require("./users");
const { generateCrashPoint, computePayout } = require("../gameEngine");

// health endpoint for frontend probe
router.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * GET /api/game/round
 * Returns a freshly generated crash point for a round.
 * Example response: { "crashPoint": 1.34 }
 */
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
      return res.status(400).json({ error: "Missing 'bet' or 'multiplier' in request body" });
    }
    const payout = computePayout(bet, multiplier);
    return res.json({ payout });
  } catch (err) {
    console.error("Error computing payout:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// mount auth & user endpoints under /api/*
router.use("/", users);

module.exports = router;