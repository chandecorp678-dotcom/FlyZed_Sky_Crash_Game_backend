const express = require("express");
const router = express.Router();

const users = require("./users");
const payments = require("./payments");
const legalRoutes = require("./legalCompliance-routes");
const monitoringRoutes = require("./monitoring-routes");
const { optionalAuth } = require("./auth");

// health endpoint for frontend probe
router.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Attach optional authentication for all subsequent API routes.
// This will set req.user when a valid Bearer token is provided, but won't reject requests without one.
router.use(optionalAuth);

// mount auth & user endpoints
router.use("/", users);

// mount payment endpoints (ZILS-backed real-money wallet)
router.use("/payments", payments);

// mount legal compliance endpoints (Phase 11)
router.use("/legal", legalRoutes);

// mount monitoring endpoints (Phase 10)
router.use("/admin/monitoring", monitoringRoutes);

// mount admin routes (optional)
let admin;
try {
  admin = require("./admin");
  router.use("/admin", admin);
} catch (e) {
  console.warn("admin.js not loaded.");
}

// Mode-isolated demo wallet and bets. This shares the current game round/multiplier,
// but demo wallet activity is recorded separately from users.balance and payments.
const demoGame = require("./demo-mode");
router.use("/demo", demoGame);

// Prevent legacy real-money routes from interpreting demo requests as real bets.
const guardRealMoneyGameMode = require("./demo-mode-guard");
router.use("/game", guardRealMoneyGameMode);

// mount existing real-money game routes
const game = require("./game");
router.use("/game", game);

module.exports = router;
