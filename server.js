'use strict';
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const logger = require("./logger");
const { initDb, pool } = require("./db");
const routes = require("./routes");
const gameEngine = require("./gameEngine");
const { sendError } = require("./apiResponses");

const app = express();

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 100); // default 100ms

app.use((req, res, next) => {
  logger.info('http.request.start', { method: req.method, url: req.originalUrl, ip: req.ip });
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", routes);

/* =================== Provably-fair helpers (kept minimal) =================== */
function hmacHex(key, msg) {
  return crypto.createHmac('sha256', key).update(String(msg)).digest('hex');
}
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

const SEED_MASTER = process.env.SEED_MASTER || null;
if (!SEED_MASTER) {
  logger.warn('server.seed_master_missing', { message: 'SEED_MASTER env var not set. Provably-fair seeds will be ephemeral across restarts.' });
}

/* =================== DB persist helpers (round start/crash) =================== */
async function persistRoundStart(db, round) {
  try {
    const id = crypto.randomUUID();
    const startedAtIso = new Date(Number(round.startedAt)).toISOString();
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

/* =================== Seed commit helpers (used by provably fair Stage 7) =================== */
async function deriveSeedForIdx(idx) {
  if (!SEED_MASTER) {
    return crypto.randomBytes(32).toString('hex');
  }
  return hmacHex(SEED_MASTER, String(idx));
}

async function getLatestCommit(db) {
  const r = await db.query(`SELECT idx, seed_hash, created_at FROM seed_commits ORDER BY idx DESC LIMIT 1`);
  return r.rowCount ? r.rows[0] : null;
}

async function ensureNextCommitExists(db) {
  const r = await db.query(`SELECT MAX(idx) as maxidx FROM seed_commits`);
  const maxidx = r.rows[0] && r.rows[0].maxidx ? Number(r.rows[0].maxidx) : 0;
  const nextIdx = maxidx + 1;

  const existing = await db.query(`SELECT idx, seed_hash, created_at FROM seed_commits WHERE idx = $1`, [nextIdx]);
  if (existing.rowCount) return existing.rows[0];

  const seed = await deriveSeedForIdx(nextIdx);
  const seedHash = sha256hex(seed);
  await db.query(`INSERT INTO seed_commits (idx, seed_hash, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (idx) DO NOTHING`, [nextIdx, seedHash]);
  logger.info('seed_commit.created', { idx: nextIdx, seedHash });
  return { idx: nextIdx, seed_hash: seedHash, created_at: new Date().toISOString() };
}

/* =================== HTTP server and optional Socket.IO =================== */
const httpServer = http.createServer(app);

// Try to require socket.io optionally. If it's not installed, continue without sockets.
let io = null;
let socketAvailable = false;
try {
  // require inside try to avoid crashing if socket.io missing
  const { Server: IOServer } = require("socket.io");
  io = new IOServer(httpServer, {
    cors: { origin: true, credentials: true }
  });
  socketAvailable = true;
  logger.info('socket.io.loaded');
} catch (err) {
  socketAvailable = false;
  io = null;
  logger.warn('socket.io.missing', { message: 'socket.io not installed. Running without realtime sockets.' });
}

// safeEmit wrapper: no-op when sockets are missing
function safeEmit(event, payload) {
  try {
    if (socketAvailable && io && typeof io.emit === 'function') {
      io.emit(event, payload);
    }
  } catch (e) {
    logger.warn('safeEmit.error', { event, message: e && e.message ? e.message : String(e) });
  }
}

/* =================== Broadcast loop (uses safeEmit) =================== */
let broadcastTimer = null;
function startBroadcastLoop() {
  if (broadcastTimer) return;
  broadcastTimer = setInterval(() => {
    try {
      const status = gameEngine.getRoundStatus();
      safeEmit('multiplier', {
        roundId: status.roundId || null,
        status: status.status || 'waiting',
        multiplier: status.multiplier || null,
        startedAt: status.startedAt || null,
        commitIdx: status.commitIdx || null,
        serverSeedHash: status.serverSeedHash || null
      });
    } catch (e) {
      logger.warn('broadcast.loop.error', { message: e && e.message ? e.message : String(e) });
    }
  }, BROADCAST_INTERVAL_MS);
  if (broadcastTimer && typeof broadcastTimer.unref === 'function') broadcastTimer.unref();
}
function stopBroadcastLoop() {
  try { if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; } } catch (e) {}
}

/* =================== Engine event attachments (use safeEmit) =================== */
function attachEngineListeners(db) {
  const emitter = gameEngine.emitter;
  if (!emitter || !emitter.on) {
    logger.warn('attachEngineListeners.no_emitter');
    return;
  }

  emitter.on('roundStarted', async (r) => {
    try {
      await persistRoundStart(db, r);
      safeEmit('roundStarted', {
        roundId: r.roundId,
        commitIdx: r.commitIdx,
        serverSeedHash: r.serverSeedHash,
        crashPoint: r.crashPoint,
        startedAt: r.startedAt
      });

      try {
        const nextCommit = await ensureNextCommitExists(db);
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
      await persistRoundCrash(db, r);
      // broadcast crash without revealing seed; reveal endpoint remains available
      safeEmit('crash', {
        roundId: r.roundId,
        crashPoint: r.crashPoint,
        commitIdx: r.commitIdx,
        serverSeedHash: r.serverSeedHash,
        startedAt: r.startedAt,
        endedAt: r.endedAt
      });
    } catch (e) {
      logger.error('emitter.roundCrashed.handler', { message: e && e.message ? e.message : String(e) });
    }
  });
}

/* =================== Start sequence =================== */
async function start() {
  try {
    await initDb();
    app.locals.db = pool;

    try { await ensureNextCommitExists(pool); } catch (e) { logger.warn('start.ensureNextCommit_failed', { message: e && e.message ? e.message : String(e) }); }

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

    attachEngineListeners(pool);

    try {
      gameEngine.startEngine();
      startBroadcastLoop();
      logger.info('gameEngine.started_and_broadcast_loop_running', { intervalMs: BROADCAST_INTERVAL_MS });
    } catch (e) {
      logger.error('gameEngine.start_failed', { message: e && e.message ? e.message : String(e) });
    }

    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, () => {
      logger.info("server.started", { port: PORT, broadcast_interval_ms: BROADCAST_INTERVAL_MS });
      if (!socketAvailable) {
        logger.warn('server.running_without_socketio', { message: 'Socket.IO not available; realtime disabled until dependency installed.' });
      }
    });

    // If sockets are available, wire basic connection events (non-critical)
    if (socketAvailable && io) {
      io.on('connection', (socket) => {
        try {
          logger.info('socket.connected', { id: socket.id });
          socket.on('disconnect', (reason) => {
            logger.info('socket.disconnected', { id: socket.id, reason });
          });
        } catch (e) {
          logger.warn('socket.connection.handler_error', { message: e && e.message ? e.message : String(e) });
        }
      });
    }

  } catch (err) {
    logger.error("server.start.failed", { message: err && err.message ? err.message : String(err) });
    process.exit(1);
  }
}

start();

/* ============ Public provably-fair endpoints (kept) ============ */

// GET /api/game/commitments/latest
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

// GET /api/game/reveal/:roundId
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

/* ============ Error handler & shutdown ============ */
app.use((err, req, res, next) => {
  if (res.headersSent) {
    logger.warn('api.error.headers_already_sent', { error: err && err.message ? err.message : String(err) });
    return next(err);
  }
  const status = (err && err.status && Number(err.status)) ? Number(err.status) : 500;
  let message = (err && err.publicMessage) ? err.publicMessage : (err && err.message) ? err.message : 'Server error';
  if (status >= 500 && process.env.NODE_ENV === 'production') message = 'Server error';
  logger.error('api.error.unhandled', { status, message, stack: err && err.stack ? err.stack : undefined });
  return sendError(res, status, message, err && (err.detail || err.stack || err.message));
});

let shuttingDown = false;
async function gracefulShutdown(reason = 'signal') {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown.start', { reason });
  try {
    stopBroadcastLoop();
    try { gameEngine.dispose(); } catch (e) {}
    try {
      await new Promise((resolve) => {
        httpServer.close(() => resolve());
      });
    } catch (e) {}
    try { if (socketAvailable && io && typeof io.close === 'function') io.close(); } catch (e) {}
    try { if (pool && pool.end) await pool.end(); } catch (e) {}
    logger.info('shutdown.complete');
    process.exit(0);
  } catch (e) {
    logger.error('shutdown.error', { message: e && e.message ? e.message : String(e) });
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => { logger.error('uncaughtException', { message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : undefined }); gracefulShutdown('uncaughtException'); });
process.on('unhandledRejection', (reason) => { logger.error('unhandledRejection', { reason: reason && reason.message ? reason.message : String(reason) }); gracefulShutdown('unhandledRejection'); });

module.exports = { app, httpServer, _internal: { socketAvailable } };
