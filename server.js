require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const logger = require("./logger");
const { initDb, pool } = require("./db");
const routes = require("./routes");
const gameEngine = require("./gameEngine");
const { sendError } = require("./apiResponses");

const app = express();

let serverInstance = null;
let isShuttingDown = false;
const GRACEFUL_TIMEOUT = Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 30000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);

app.use((req, res, next) => {
  logger.info('http.request.start', { method: req.method, url: req.originalUrl, ip: req.ip });
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", routes);

// Simple helpers for seed derivation (provably-fair)
function hmacHex(key, msg) {
  return crypto.createHmac('sha256', key).update(String(msg)).digest('hex');
}
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/* Persist functions (round start / crash) */

async function persistRoundStart(db, round) {
  try {
    const id = crypto.randomUUID();
    const startedAtIso = new Date(Number(round.startedAt)).toISOString();
    // Insert round with server_seed_hash and commit_idx (commit_idx may be null)
    await db.query(
      `INSERT INTO rounds (id, round_id, server_seed_hash, commit_idx, crash_point, started_at, meta, createdat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (round_id) DO NOTHING`,
      [id, round.roundId, round.serverSeedHash || null, round.commitIdx || null, round.crashPoint || null, startedAtIso, round.meta || {}]
    );
    logger.info('persistRoundStart.success', { roundId: round.roundId, commitIdx: round.commitIdx });
  } catch (e) {
    logger.error('persistRoundStart.error', { message: e && e.message ? e.message : String(e) });
  }
}

async function persistRoundCrash(db, round) {
  try {
    const endedAtIso = new Date(Number(round.endedAt)).toISOString();
    // Update rounds: set crash_point, ended_at, server_seed (revealed), commit_idx is already set at start
    await db.query(
      `UPDATE rounds
       SET crash_point = $1, ended_at = $2, meta = meta || $3::jsonb, server_seed = $4, server_seed_revealed_at = NOW()
       WHERE round_id = $5`,
      [round.crashPoint || null, endedAtIso, JSON.stringify(round.meta || {}), round.serverSeed || null, round.roundId]
    );
    logger.info('persistRoundCrash.success', { roundId: round.roundId });
  } catch (e) {
    logger.error('persistRoundCrash.error', { message: e && e.message ? e.message : String(e) });
  }
}

/* Seed commitment helpers (derive seed from master and idx; commit hash stored in seed_commits) */

const SEED_MASTER = process.env.SEED_MASTER || null;
if (!SEED_MASTER) {
  logger.warn('server.seed_master_missing', { message: 'SEED_MASTER env var not set. Provably-fair seeds will be ephemeral across restarts.' });
}

async function deriveSeedForIdx(idx) {
  // HMAC(master, idx) -> seed (hex)
  if (!SEED_MASTER) {
    // fallback: random seed (non-reproducible)
    return crypto.randomBytes(32).toString('hex');
  }
  const seed = hmacHex(SEED_MASTER, String(idx));
  return seed;
}

async function ensureNextCommitExists(db) {
  // Find current max idx and create next commit (idx = max+1) if not exists.
  const r = await db.query(`SELECT MAX(idx) as maxidx FROM seed_commits`);
  const maxidx = r.rows[0] && r.rows[0].maxidx ? Number(r.rows[0].maxidx) : 0;
  const nextIdx = maxidx + 1;

  // Check if there's already a commit with nextIdx
  const existing = await db.query(`SELECT idx, seed_hash, created_at FROM seed_commits WHERE idx = $1`, [nextIdx]);
  if (existing.rowCount) {
    return existing.rows[0]; // return existing commit
  }

  // Derive seed deterministically (requires SEED_MASTER)
  const seed = await deriveSeedForIdx(nextIdx);
  const seedHash = sha256hex(seed);

  // Insert commit
  await db.query(`INSERT INTO seed_commits (idx, seed_hash, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (idx) DO NOTHING`, [nextIdx, seedHash]);
  logger.info('seed_commit.created', { idx: nextIdx, seedHash });
  return { idx: nextIdx, seed_hash: seedHash, created_at: new Date().toISOString() };
}

async function getCommitByIdx(db, idx) {
  const r = await db.query(`SELECT idx, seed_hash, created_at FROM seed_commits WHERE idx = $1`, [idx]);
  return r.rowCount ? r.rows[0] : null;
}

async function getLatestCommit(db) {
  const r = await db.query(`SELECT idx, seed_hash, created_at FROM seed_commits ORDER BY idx DESC LIMIT 1`);
  return r.rowCount ? r.rows[0] : null;
}

/* Attach listeners and start engine */
async function start() {
  try {
    await initDb();       // test Postgres connection
    app.locals.db = pool; // attach Postgres pool to app

    // Ensure seed_commits table exists and at least one future commit exists
    try {
      await ensureNextCommitExists(pool);
    } catch (e) {
      logger.warn('start.ensureNextCommit_failed', { message: e && e.message ? e.message : String(e) });
    }

    // Provide the next seed to gameEngine before starting engine:
    try {
      const latestCommit = await getLatestCommit(pool);
      if (latestCommit) {
        const idx = Number(latestCommit.idx);
        const seed = await deriveSeedForIdx(idx);
        gameEngine.setNextSeed({ seed, seedHash: latestCommit.seed_hash, commitIdx: idx });
      } else {
        logger.warn('start.no_latest_commit_found');
      }
    } catch (e) {
      logger.warn('start.set_next_seed_failed', { message: e && e.message ? e.message : String(e) });
    }

    // Attach listeners to gameEngine events to persist rounds and manage commit pipeline
    try {
      const emitter = gameEngine.emitter;
      if (emitter && emitter.on) {
        emitter.on('roundStarted', async (r) => {
          try {
            // r.commitIdx is the index of the seed we used; persist round start
            await persistRoundStart(pool, r);

            // After persisting current round start, ensure the next commit exists and set it in engine
            try {
              const nextCommit = await ensureNextCommitExists(pool);
              if (nextCommit) {
                const nextSeed = await deriveSeedForIdx(Number(nextCommit.idx));
                gameEngine.setNextSeed({ seed: nextSeed, seedHash: nextCommit.seed_hash, commitIdx: Number(nextCommit.idx) });
                logger.info('start.set_next_seed_for_next_round', { nextIdx: nextCommit.idx });
              }
            } catch (e2) {
              logger.warn('start.create_next_commit_failed', { message: e2 && e2.message ? e2.message : String(e2) });
            }

          } catch (e) {
            logger.error('emitter.roundStarted.handler', { message: e && e.message ? e.message : String(e) });
          }
        });

        emitter.on('roundCrashed', async (r) => {
          try {
            // r.serverSeed is included so we can reveal it and persist
            await persistRoundCrash(pool, r);
          } catch (e) {
            logger.error('emitter.roundCrashed.handler', { message: e && e.message ? e.message : String(e) });
          }
        });

        logger.info('gameEngine.listeners.attached');
      } else {
        logger.warn('gameEngine.no_emitter');
      }
    } catch (e) {
      logger.error('start.attach_listeners_error', { message: e && e.message ? e.message : String(e) });
    }

    // Start engine (will start first round using seed we set)
    try {
      gameEngine.startEngine();
      logger.info('gameEngine.started');
    } catch (e) {
      logger.error('gameEngine.start_failed', { message: e && e.message ? e.message : String(e) });
    }

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

/* Public provably-fair endpoints (read-only) */

// GET /api/game/commitments/latest -> returns { idx, seed_hash, created_at }
app.get('/api/game/commitments/latest', async (req, res) => {
  try {
    const commit = await getLatestCommit(pool);
    if (!commit) return res.status(404).json({ error: "No commitments found" });
    return res.json(commit);
  } catch (e) {
    logger.error('commitments.latest.error', { message: e && e.message ? e.message : String(e) });
    return sendError(res, 500, "Server error");
  }
});

// GET /api/game/reveal/:roundId -> reveal serverSeed for a finished round (public verification)
app.get('/api/game/reveal/:roundId', async (req, res) => {
  const roundId = req.params.roundId;
  if (!roundId) return res.status(400).json({ error: "roundId required" });
  try {
    const r = await pool.query(`SELECT round_id, server_seed_hash, server_seed, server_seed_revealed_at, started_at, ended_at, crash_point, commit_idx FROM rounds WHERE round_id = $1`, [roundId]);
    if (!r.rowCount) return res.status(404).json({ error: "Round not found" });
    const row = r.rows[0];
    if (!row.server_seed) {
      return res.status(400).json({ error: "Seed not revealed yet for this round" });
    }
    // response: server_seed (hex), server_seed_hash, commit_idx, server_seed_revealed_at, crash_point
    return res.json({
      roundId: row.round_id,
      commitIdx: row.commit_idx,
      serverSeed: row.server_seed,
      serverSeedHash: row.server_seed_hash,
      revealedAt: row.server_seed_revealed_at,
      crashPoint: row.crash_point,
      startedAt: row.started_at,
      endedAt: row.ended_at
    });
  } catch (e) {
    logger.error('reveal.endpoint.error', { message: e && e.message ? e.message : String(e) });
    return sendError(res, 500, "Server error");
  }
});

/* Global error handler */
app.use((err, req, res, next) => {
  if (res.headersSent) {
    logger.warn('api.error.headers_already_sent', { error: err && err.message ? err.message : String(err) });
    return next(err);
  }

  const status = (err && err.status && Number(err.status)) ? Number(err.status) : 500;
  let message = (err && err.publicMessage) ? err.publicMessage : (err && err.message) ? err.message : 'Server error';
  if (status >= 500 && process.env.NODE_ENV === 'production') {
    message = 'Server error';
  }

  logger.error('api.error.unhandled', { status, message, stack: err && err.stack ? err.stack : undefined });

  return sendError(res, status, message, err && (err.detail || err.stack || err.message));
});

/* Graceful shutdown */
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

process.on("SIGTERM", () => {
  logger.info("signal.received", { signal: "SIGTERM" });
  gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  logger.info("signal.received", { signal: "SIGINT" });
  gracefulShutdown("SIGINT");
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : undefined });
  gracefulShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: reason && reason.message ? reason.message : String(reason) });
  gracefulShutdown("unhandledRejection");
});

module.exports = { app, serverInstance, _internal: { setShuttingDown: (val) => { isShuttingDown = !!val; } } };
