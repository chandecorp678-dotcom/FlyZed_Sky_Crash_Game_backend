const express = require("express");
const router = express.Router();

const { startRound, cashOut } = require("./gameEngine");

// START ROUND
router.post("/start", (req, res) => {
  try {
    const round = startRound();
    res.json(round);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// CASH OUT
router.post("/cashout", async (req, res) => {
  const { roundId, betAmount, multiplier } = req.body;
  const userId = req.user?.id || req.body.userId; // demo-safe

  if (!roundId || !betAmount || !multiplier) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
    // 🔐 Game-level lock already handled in gameEngine
    const result = cashOut(
      roundId,
      betAmount,
      multiplier,
      userId
    );

    return res.json({
      success: true,
      ...result
    });

  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;

