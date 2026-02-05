'use strict';
const crypto = require('crypto');
const logger = require('./logger');

/* ========================================================= GLOBAL ROUND STATE =========================================================
   We implement ONE global round (currentRound). This file provides the core engine:
   - createNewRound() starts a new server-controlled round
   - rounds auto-crash at a server-determined crash point
   - after crash we wait 5 seconds then auto-start the next round
   - public API functions (getRoundStatus, joinRound, cashOut) operate on currentRound
   NOTE: routes/controllers should call these exported functions; do NOT expose a manual start route.
   ============================================================================================================================ */

let currentRound = null;

/* ========================================================= INTERNAL HELPERS ========================================================= */

function generateCrashPoint() {
  // Simple distribution: many low multipliers, occasional bigger ones.
  const r = Math.random();
  if (r < 0.7) {
    return Number((1.1 + Math.random() * 0.6).toFixed(2));
  } else {
    return Number((2 + Math.random() * 3).toFixed(2));
  }
}

function crashDelayFromPoint(crashPoint) {
  // Convert crashPoint (e.g. 1.23x) into ms delay roughly proportional to (crashPoint - 1) seconds.
  // Ensure minimum delay (e.g. 100ms) so extremely low values still schedule.
  const ms = Math.max(100, Math.floor((crashPoint - 1) * 1000));
  return ms;
}

function computeMultiplier(startedAt) {
  const elapsedMs = Date.now() - startedAt;
  const growthPerSecond = 1; // 1x per second linear growth model (keeps things simple)
  const multiplier = 1 + (elapsedMs / 1000) * growthPerSecond;
  return Number(multiplier.toFixed(2));
}

function computePayout(betAmount, multiplier) {
  return Number((Number(betAmount) * Number(multiplier)).toFixed(2));
}

// Safe helper to mark currentRound as crashed and schedule next round once.
function markRoundCrashed(round, reason = 'auto') {
  if (!round) return;
  if (round.status === 'crashed') return;

  round.status = 'crashed';
  round.locked = true;
  round.endedAt = Date.now();

  // Clear any auto-crash timer (should be the one that caused this)
  if (round.timer) {
    try { clearTimeout(round.timer); } catch (e) {}
    round.timer = null;
  }

  logger.info('game.round.crashed', { roundId: round.roundId, reason, crashPoint: round.crashPoint });

  // Schedule next round start after 5 seconds (avoid double-scheduling)
  if (!round.nextRoundTimer) {
    round.nextRoundTimer = setTimeout(() => {
      // Clean up the old round object reference (we keep it for audit if needed)
      if (currentRound && currentRound.roundId === round.roundId) {
        currentRound = null;
      }
      // Create new round
      createNewRound();
    }, 5000);
  }
}

/**
 * Create and start a new global round.
 * Returns the created round object.
 */
function createNewRound() {
  // If an existing currentRound exists, clear timers to avoid leaks
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
    serverSeed,
    serverSeedHash,
    status: 'running',   // 'running' | 'crashed'
    startedAt: Date.now(),
    endedAt: null,
    locked: false,
    players: new Map(),  // playerId -> { betAmount, cashedOut }
    timer: null,         // auto-crash timer
    nextRoundTimer: null // scheduled restart after crash
  };

  // ⏱️ Auto-crash after computed delay
  const delay = crashDelayFromPoint(crashPoint);
  currentRound.timer = setTimeout(() => {
    // If still running, mark crashed and schedule restart
    if (currentRound && currentRound.status === 'running') {
      markRoundCrashed(currentRound, 'timer');
    }
  }, delay);

  logger.info('game.round.started', { roundId: currentRound.roundId, crashPoint: currentRound.crashPoint, startedAt: currentRound.startedAt, serverSeedHash });

  return currentRound;
}

/* ========================================================= PUBLIC API ========================================================= */

/**
 * getRoundStatus()
 * Returns current global round status object.
 * - If no current round exists, returns { status: 'waiting' } (but engine auto-starts on boot so this is rare)
 * - If running, returns multiplier and status; if multiplier >= crashPoint, it will mark crash and schedule restart.
 */
function getRoundStatus() {
  if (!currentRound) {
    return { status: 'waiting' };
  }

  let multiplier = null;

  if (currentRound.status === 'running') {
    multiplier = computeMultiplier(currentRound.startedAt);

    // If server-side multiplier has reached or exceeded crashPoint -> crash now
    if (multiplier >= currentRound.crashPoint) {
      // Ensure consistent state transition
      markRoundCrashed(currentRound, 'threshold');
      multiplier = currentRound.crashPoint;
    }
  } else {
    // If crashed, multiplier is the crash point
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

/**
 * joinRound(playerId, betAmount)
 * Player joins the currently running round (places a bet) and receives round metadata.
 * Throws if no active running round or if player already joined.
 */
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

/**
 * cashOut(playerId)
 * Cash out for the given player from the current round.
 * Returns { win: boolean, payout: number, multiplier }.
 * If round already crashed, returns win:false.
 */
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

  // compute multiplier at this moment
  let multiplier = computeMultiplier(currentRound.startedAt);

  // If multiplier has reached or passed crash point, round has crashed
  if (multiplier >= currentRound.crashPoint || currentRound.status !== 'running') {
    // ensure server state reflects crash
    if (currentRound.status !== 'crashed') {
      markRoundCrashed(currentRound, 'cashout-detected-crash');
    }
    return { win: false, payout: 0, multiplier: currentRound.crashPoint };
  }

  // Otherwise player cashes out at current multiplier
  player.cashedOut = true;

  // Round multiplier for payout should be rounded to 2 decimals as per computeMultiplier
  multiplier = Number(multiplier.toFixed(2));
  const payout = computePayout(player.betAmount, multiplier);

  // Persisting player result in the round object (optional)
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

/**
 * dispose()
 * Clear timers and round state for graceful shutdown. Safe to call multiple times.
 */
async function dispose() {
  try {
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
    } catch (e) {
      // ignore
    }

    // Clear players map to free memory
    try {
      if (currentRound.players && typeof currentRound.players.clear === 'function') {
        currentRound.players.clear();
      }
    } catch (e) {}

    // Remove sensitive serverSeed from memory
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

// Start the first global round on server boot
createNewRound();

/* ========================================================= EXPORTS ========================================================= */

module.exports = {
  getRoundStatus,
  joinRound,
  cashOut,
  dispose
  // createNewRound intentionally not exported for normal operation
};
