const express = require("express");
const router = express.Router();

const users = require("./users");
const { generateCrashPoint, computePayout } = require("./gameEngine");
// Demo-only in-memory round state
let currentRound = null;

// health endpoint for frontend probe
router.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});
// Start a new demo game round
router.post("/game/start", (req, res) => {
  if (currentRound && !currentRound.ended) {
    return res.status(400).json({ error: "Round already in progress" });
  }

  const crashPoint = Number(generateCrashPoint().toFixed(2));

  currentRound = {
    crashPoint,
    startedAt: Date.now(),
    ended: false
  };

  res.json({
    mode: "DEMO",
    started: true,
    startedAt: currentRound.startedAt
  });
}); 
// Cash out before crash (demo mode)
router.post("/game/cashout", (req, res) => {
  if (!currentRound || currentRound.ended) {
    return res.status(400).json({ error: "No active round" });
  }

  const { betAmount, multiplier } = req.body;

  if (!betAmount || !multiplier) {
    return res.status(400).json({ error: "Missing betAmount or multiplier" });
  }

  if (multiplier >= currentRound.crashPoint) {
    currentRound.ended = true;
    return res.json({
      result: "CRASHED",
      crashPoint: currentRound.crashPoint
    });
  }

  const payout = computePayout(betAmount, multiplier);
  currentRound.ended = true;

  res.json({
    result: "WIN",
    payout,
    multiplier,
    mode: "DEMO"
  });
}); 

router.use("/", users); // mount auth & user endpoints under /api/*

// mount admin routes (add this)
let admin;
try {
  admin = require("./admin");
  router.use("/admin", admin);
} catch (e) {
  // admin.js not present — continue without admin endpoints
  console.warn("admin.js not loaded (file may be missing). Admin endpoints unavailable.");
}

module.exports = router;
