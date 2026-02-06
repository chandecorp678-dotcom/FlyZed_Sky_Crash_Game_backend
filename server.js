require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const logger = require("./logger");
const { initDb, pool } = require("./db");
const routes = require("./routes");
const gameEngine = require("./gameEngine");
// require game routes module to access its cleanup helper
const gameRoutes = require("./game");
const { sendError } = require("./apiResponses");

const app = express();

let serverInstance = null;
let isShuttingDown = false;
const GRACEFUL_TIMEOUT = Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 30000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);

// Basic request logging to help debugging (uses structured logger)
app.use((req, res, next) => {
  logger.info('http.request.start', { method: req.method, url: req.originalUrl, ip: req.ip });
  next();
});

app.use(cors());
app.use(express.json());

// Per-request timeout middleware (installed early)
app.use((req, res, next) => {
  const timeoutMs = REQUEST_TIMEOUT_MS;
  let finished = false;

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    // log the timed-out request
    try {
      logger.warn('http.request.timeout', { method: req.method, url: req.originalUrl, timeoutMs });
    } catch (e) {}
    if (!res.headersSent) {
      // Use sendError structure for a clean response
      try {
        return sendError(res, 503, "Request timeout");
      } catch (e) {
        try { res.status(503).send("Request timeout"); } catch (e2) {}
      }
    }
    // Destroy the incoming request socket to free resources
    try { req.destroy(); } catch (e) {}
  }, timeoutMs);

  function cleanup() {
    if (!timer) return;
    clearTimeout(timer);
    finished = true;
  }

  res.on('finish', cleanup);
  res.on('close', cleanup);
  req.on('aborted', cleanup);

  // proceed to next middleware/route
  next();
});

// Serve static frontend from ./public
app.use(express.static(path.join(__dirname, "public")));

// mount API routes under /api
app.use("/api", routes);

// Global error handler (must be registered AFTER routes)
app.use((err, req, res, next) => {
  if (res.headersSent) {
    logger.warn('api.error.headers_already_sent', { error: err && err.message ? err.message : String(err) });
    return next(err);
  }

  const status = (err && err.status && Number(err.status)) ? Number(err.status) : (err && err.httpStatus) ? Number(err.httpStatus) : 500;
  let message = (err && err.publicMessage) ? err.publicMessage : (err && err.message) ? err.message : 'Server error';
  if (status >= 500 && process.env.NODE_ENV === 'production') {
    message = 'Server error';
  }

  logger.error('api.error.unhandled', { status, message, stack: err && err.stack ? err.stack : undefined });

  return sendError(res, status, message, err && (err.detail || err.stack || err.message));
});

async function start() {
  try {
    await initDb();       // test Postgres connection
    app.locals.db = pool; // attach Postgres pool to app

    const PORT = process.env.PORT || 3000;
    serverInstance = app.listen(PORT, () => {
      logger.info("server.started", { port: PORT, request_timeout_ms: REQUEST_TIMEOUT_MS });
    });

  } catch (err) {
    logger.error("server.start.failed", { message: err && err.message ? err.message : String(err) });
    process.exit(1);
  }
}

start();

// Graceful shutdown routine
async function gracefulShutdown(reason = "signal") {
  if (isShuttingDown) {
    logger.warn("shutdown.already_in_progress", { reason });
    return;
  }
  isShuttingDown = true;
  logger.info("shutdown.start", { reason });

  const forceExitTimeout = setTimeout(() => {
    logger.error("shutdown.force_exit", { timeoutMs: GRACEFUL_TIMEOUT });
    try {
      if (logger._internal && logger._internal.fileStream) {
        try { logger._internal.fileStream.end(); } catch (e) {}
      }
    } catch (e) {}
    process.exit(1);
  }, GRACEFUL_TIMEOUT).unref();

  try {
    if (serverInstance && serverInstance.close) {
      logger.info("shutdown.http.stop_listening");
      await new Promise((resolve) => serverInstance.close(() => resolve()));
      logger.info("shutdown.http.closed");
    } else {
      logger.warn("shutdown.http.no_server_instance");
    }

    // Call game routes cleanup (clears prune interval and maps)
    try {
      if (gameRoutes && typeof gameRoutes.cleanup === "function") {
        logger.info("shutdown.gameRoutes.cleanup_start");
        try { gameRoutes.cleanup(); } catch (e) { logger.warn("shutdown.gameRoutes.cleanup_error", { message: e && e.message ? e.message : String(e) }); }
        logger.info("shutdown.gameRoutes.cleaned");
      } else {
        logger.warn("shutdown.gameRoutes.no_cleanup");
      }
    } catch (e) {
      logger.error("shutdown.gameRoutes.error", { message: e && e.message ? e.message : String(e) });
    }

    try {
      if (gameEngine && typeof gameEngine.dispose === "function") {
        logger.info("shutdown.gameEngine.dispose_start");
        await gameEngine.dispose();
        logger.info("shutdown.gameEngine.disposed");
      } else {
        logger.warn("shutdown.gameEngine.no_dispose");
      }
    } catch (e) {
      logger.error("shutdown.gameEngine.dispose_error", { message: e && e.message ? e.message : String(e) });
    }

    try {
      if (pool && typeof pool.end === "function") {
        logger.info("shutdown.db.pool_ending");
        await pool.end();
        logger.info("shutdown.db.closed");
      } else {
        logger.warn("shutdown.db.no_pool");
      }
    } catch (e) {
      logger.error("shutdown.db.close_error", { message: e && e.message ? e.message : String(e) });
    }

    try {
      if (logger._internal && logger._internal.fileStream) {
        logger.info("shutdown.logger.flush_close");
        logger._internal.fileStream.end();
      }
    } catch (e) {}

    clearTimeout(forceExitTimeout);
    logger.info("shutdown.complete");
    process.exit(0);
  } catch (err) {
    logger.error("shutdown.unhandled_error", { message: err && err.message ? err.message : String(err) });
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

// Signal handlers
process.on("SIGTERM", () => {
  logger.info("signal.received", { signal: "SIGTERM" });
  gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  logger.info("signal.received", { signal: "SIGINT" });
  gracefulShutdown("SIGINT");
});

// Uncaught exceptions / unhandled rejections
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : undefined });
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: reason && reason.message ? reason.message : String(reason) });
  gracefulShutdown("unhandledRejection");
});

// Export app and server for tests or later shutdown
module.exports = {
  app,
  serverInstance,
  _internal: { setShuttingDown: (val) => { isShuttingDown = !!val; } }
};
