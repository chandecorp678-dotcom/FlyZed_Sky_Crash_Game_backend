const express = require("express");
const router = express.Router();

const users = require("./users");

// health endpoint for frontend probe
router.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// mount auth & user endpoints
router.use("/", users);

// mount admin routes (optional)
let admin;
try {
  admin = require("./admin");
  router.use("/admin", admin);
} catch (e) {
  console.warn("admin.js not loaded. Admin endpoints unavailable.");
}

// mount game routes (PRODUCTION)
const game = require("./game");
router.use("/game", game);

module.exports = router; 
