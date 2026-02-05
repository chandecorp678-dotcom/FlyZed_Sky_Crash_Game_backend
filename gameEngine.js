'use strict';
const crypto = require('crypto');
const logger = require('./logger');

/* ========================================================= GLOBAL ROUND STATE =========================================================
   One global round (currentRound). This engine:
   - starts a new server-controlled round
   - auto-crashes after server-determined crash point
   - schedules next round after crash
   - exposes getRoundStatus, joinRound, cashOut, dispose
   ============================================================================================================================ */

let currentRound = null;
let disposed = false;

/* ========================================================= INTERNAL HELPERS ========================================================= */

function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.7) {
    return Number((1.1 + Math.random() * 0.6).toFixed(2));
  } else {
    return Number((2 + Math.random() * 3).toFixed(2));
  }
}

function crashDelayFromPoint(crashPoint) {
  const ms = Math.max(100, Math.floor((crashPoint - 1) * 1000));
  return ms;
}

function computeMultiplier(startedAt) {
  const elapsedMs = Date.now() - startedAt;
  const growthPerSecond = 1;
  const multiplier = 1 + (elapsedMs / 1000) * growthPerSecond;
  return Number(multiplier.toFixed(2));
}

function computePayout(betAmount, multiplier) {
  return Number((Number(betAmount) * Number(multiplier)).toFixed(2));
}

function safeClearTimer(t) {
  try {
    if (t) {
      clearTimeout(t);
    }
  } catch (e) {
    // ignore
  }
}

// Mark round crashed and schedule next round once.
function markRoundCrashed(round, reason = 'auto') {
  if (!round) return;
  if (round.status === 'crashed') return;

  round.status = 'crashed';
  round.locked = true;
  round.endedAt = Date.now();

  // Clear auto-crash timer (if set)
  if (round.timer) {
    try { clearTimeout(round.timer); } catch (e) {}
    round.timer = null;
  }

  logger.info('game.round.crashed', { roundId: round.roundId, reason, crashPoint: round.crashPoint });

  // Schedule next round start after 5 seconds (avoid double-scheduling)
  if (!round.nextRoundTimer && !disposed) {
    const t = setTimeout(() => {
      try {
        if (currentRound && currentRound.roundId === round.roundId) {
          currentRound = null;
        }
        if (!disposed) {
          createNewRound();
        } else {
          logger.info('game.round.not_restarting_because_disposed', { roundId: round.roundId });
        }
      } catch (e) {
        logger.error('game.round.schedule_next_error', { message: e && e.message ? e.message : String(e) });
      }
    }, 5000);
    // Do not keep the process alive just for this timer
    if (typeof t.unref === 'function') t.unref();
    round.nextRoundTimer = t;
  }
}

/**
 * Create and start a new global round.
 * Returns the created round object or null if engine disposed.
 */
function createNewRound() {
  if (disposed) {
    logger.info('game.round.create_skipped_disposed');
    return null;
  }

  // Clear prior round timers to avoid leaks
  if (currentRound) {
    try {
      if (currentRound.timer) {
        clearTimeout(currentRound.timer);
        currentRound.timer = null;
      }
      if (currentRound.nextRoundTimer) {
        clearTimeout(currentRound.nextRoundTimer);
        currentRound.nextRoundTimer = null;
      }
    } catch (e) {
      // ignore
    }
  }

  const roundId = crypto.randomUUID();
  const crashPoint = generateCrashPoint();
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto
    .createHash('sha256')
    .update(serverSeed)
    .digest('hex');

  currentRound = {
    roundId,
    crashPoint,
    serverSeed,       // will be nulled on dispose
    serverSeedHash,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    locked: false,
    players: new Map(),
    timer: null,
    nextRoundTimer: null
  };

  // Auto-crash after computed delay
  const delay = crashDelayFromPoint(crashPoint);
  const t = setTimeout(() => {
    if (currentRound && currentRound.status === 'running') {
      markRoundCrashed(currentRound, 'timer');
    }
  }, delay);
  if (typeof t.unref === 'function') t.unref();
  currentRound.timer = t;

  // Log start (do not log raw serverSeed)
  logger.info('game.round.started', { roundId: currentRound.roundId, crashPoint: currentRound.crashPoint, startedAt: currentRound.startedAt, serverSeedHash });

  return currentRound;
}

/* ========================================================= PUBLIC API ========================================================= */

function getRoundStatus() {
  if (!currentRound) {
    return { status: 'waiting' };
  }

  let multiplier = null;

  if (currentRound.status === 'running') {
    multiplier = computeMultiplier(currentRound.startedAt);

    if (multiplier >= currentRound.crashPoint) {
      markRoundCrashed(currentRound, 'threshold');
      multiplier = currentRound.crashPoint;
    }
  } else {
    multiplier = currentRound.crashPoint;
  }

  return {
    roundId: currentRound.roundId,
    status: currentRound.status,
    multiplier,
    startedAt: currentRound.startedAt,
    endedAt: currentRound.endedAt,
    serverSeedHash: currentRound.serverSeedHash
  };
}

function joinRound(playerId, betAmount) {
  if (!currentRound || currentRound.status !== 'running') {
    throw new Error('No active running round');
  }

  if (!playerId) throw new Error('playerId required');
  if (!betAmount || isNaN(betAmount) || Number(betAmount) <= 0) throw new Error('Invalid bet amount');

  if (currentRound.players.has(playerId)) {
    throw new Error('Player already joined this round');
  }

  currentRound.players.set(playerId, {
    betAmount: Number(betAmount),
    cashedOut: false
  });

  return {
    roundId: currentRound.roundId,
    serverSeedHash: currentRound.serverSeedHash,
    startedAt: currentRound.startedAt
  };
}

function cashOut(playerId) {
  if (!currentRound) {
    throw new Error('No active round');
  }

  const player = currentRound.players.get(playerId);
  if (!player) {
    throw new Error('Player not in round');
  }

  if (player.cashedOut) {
    throw new Error('Already cashed out');
  }

  let multiplier = computeMultiplier(currentRound.startedAt);

  if (multiplier >= currentRound.crashPoint || currentRound.status !== 'running') {
    if (currentRound.status !== 'crashed') {
      markRoundCrashed(currentRound, 'cashout-detected-crash');
    }
    return { win: false, payout: 0, multiplier: currentRound.crashPoint };
  }

  player.cashedOut = true;

  multiplier = Number(multiplier.toFixed(2));
  const payout = computePayout(player.betAmount, multiplier);

  player.payout = payout;
  player.cashedAt = Date.now();
  player.cashedMultiplier = multiplier;

  logger.info('game.player.cashed', { playerId, roundId: currentRound.roundId, multiplier, payout });

  return {
    win: true,
    payout,
    multiplier
  };
}

/* ========================================================= DISPOSE / SHUTDOWN ========================================================= */

async function dispose() {
  try {
    if (disposed) {
      logger.info('game.dispose.already_disposed');
      currentRound = null;
      return;
    }
    disposed = true;

    if (!currentRound) {
      logger.info('game.dispose.no_current_round');
      return;
    }

    try {
      if (currentRound.timer) {
        clearTimeout(currentRound.timer);
        currentRound.timer = null;
      }
      if (currentRound.nextRoundTimer) {
        clearTimeout(currentRound.nextRoundTimer);
        currentRound.nextRoundTimer = null;
      }
    } catch (e) {}

    try {
      if (currentRound.players && typeof currentRound.players.clear === 'function') {
        currentRound.players.clear();
      }
    } catch (e) {}

    try {
      if (currentRound.serverSeed) {
        currentRound.serverSeed = null;
      }
    } catch (e) {}

    logger.info('game.dispose.completed', { roundId: currentRound.roundId });

    currentRound = null;
  } catch (err) {
    logger.error('game.dispose.error', { message: err && err.message ? err.message : String(err) });
  }
}

/* ========================================================= BOOT: auto-start first round ========================================================= */

createNewRound();

/* ========================================================= EXPORTS ========================================================= */

module.exports = {
  getRoundStatus,
  joinRound,
  cashOut,
  dispose
};
