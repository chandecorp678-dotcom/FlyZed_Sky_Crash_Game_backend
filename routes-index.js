const express = require("express");
const router = express.Router();

const users = require("./users");

// health endpoint for frontend probe
router.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

router.use("/", users); // mount auth & user endpoints under /api/*

module.exports = router;

