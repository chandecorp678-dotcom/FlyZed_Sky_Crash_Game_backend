require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const logger = require("./logger");

const { initDb, pool } = require("./db");
const routes = require("./routes");

const app = express();

// Basic request logging to help debugging (uses structured logger)
app.use((req, res, next) => {
  logger.info('http.request.start', { method: req.method, url: req.originalUrl, ip: req.ip });
  next();
});

app.use(cors());
app.use(express.json());

// Serve static frontend from ./public
app.use(express.static(path.join(__dirname, "public")));

let serverInstance = null;
let isShuttingDown = false;

async function start() {
  try {
    await initDb();       // test Postgres connection
    app.locals.db = pool; // attach Postgres pool to app

    // mount API routes under /api
    app.use("/api", routes);

    const PORT = process.env.PORT || 3000;
    serverInstance = app.listen(PORT, () => {
      logger.info("server.started", { port: PORT });
    });

    // Graceful shutdown on signals will be added in Step B (we wire the handlers there)
  } catch (err) {
    logger.error("Failed to start server", { message: err && err.message ? err.message : String(err) });
    // Ensure non-zero exit when start fails
    process.exit(1);
  }
}

start();

// Export app and server for tests or later shutdown
module.exports = {
  app,
  serverInstance,
  _internal: { setShuttingDown: (val) => { isShuttingDown = !!val; } }
};
