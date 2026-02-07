// Simple in-memory metrics with optional periodic file persistence.
// Non-blocking and safe for production -- keeps counters in memory and exposes a small API.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const METRICS_FLUSH_INTERVAL_MS = Number(process.env.METRICS_FLUSH_INTERVAL_MS || 60_000); // 60s
const METRICS_PERSIST_TO_FILE = (process.env.METRICS_PERSIST_TO_FILE === 'true');
const METRICS_FILE_PATH = process.env.METRICS_FILE_PATH || path.join(__dirname, 'metrics.log');

const counters = {
  totalBets: 0,        // count of bets placed
  totalVolume: 0.0,    // sum of bet amounts
  totalCashouts: 0,    // count of cashouts attempted
  totalPayouts: 0.0,   // sum of payouts paid to players
  lastUpdated: Date.now()
};

function snapshot() {
  return {
    totalBets: counters.totalBets,
    totalVolume: Number(counters.totalVolume.toFixed(2)),
    totalCashouts: counters.totalCashouts,
    totalPayouts: Number(counters.totalPayouts.toFixed(2)),
    lastUpdated: new Date(counters.lastUpdated).toISOString()
  };
}

function incrementBet(amount) {
  try {
    const n = Number(amount) || 0;
    counters.totalBets += 1;
    counters.totalVolume += n;
    counters.lastUpdated = Date.now();
  } catch (e) {
    logger.warn('metrics.incrementBet_failed', { message: e && e.message ? e.message : String(e) });
  }
}

function incrementCashout(payout) {
  try {
    const p = Number(payout) || 0;
    counters.totalCashouts += 1;
    counters.totalPayouts += p;
    counters.lastUpdated = Date.now();
  } catch (e) {
    logger.warn('metrics.incrementCashout_failed', { message: e && e.message ? e.message : String(e) });
  }
}

function getMetrics() {
  return snapshot();
}

// Optional persistence: append newline-delimited JSON snapshots periodically
let persistTimer = null;
function startPersistenceIfEnabled() {
  if (!METRICS_PERSIST_TO_FILE) return;
  try {
    persistTimer = setInterval(() => {
      try {
        const data = JSON.stringify({ ts: new Date().toISOString(), metrics: snapshot() }) + '\n';
        fs.appendFile(METRICS_FILE_PATH, data, (err) => {
          if (err) logger.warn('metrics.persist_append_failed', { message: err && err.message ? err.message : String(err) });
        });
      } catch (e) {
        logger.warn('metrics.persist_interval_error', { message: e && e.message ? e.message : String(e) });
      }
    }, METRICS_FLUSH_INTERVAL_MS);
    if (typeof persistTimer.unref === 'function') persistTimer.unref();
    logger.info('metrics.persistence.started', { file: METRICS_FILE_PATH, intervalMs: METRICS_FLUSH_INTERVAL_MS });
  } catch (e) {
    logger.warn('metrics.startPersistence_failed', { message: e && e.message ? e.message : String(e) });
  }
}

function stopPersistence() {
  try {
    if (persistTimer) {
      clearInterval(persistTimer);
      persistTimer = null;
    }
  } catch (e) {
    // ignore
  }
}

startPersistenceIfEnabled();

module.exports = {
  incrementBet,
  incrementCashout,
  getMetrics,
  _internal: { counters, startPersistenceIfEnabled, stopPersistence }
};
