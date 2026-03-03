'use strict';
const crypto = require('crypto');
const EventEmitter = require('events');
const logger = require('./logger');

/**
 * Game engine with realistic crash points for ALL PLAYERS
 * 
 * CRASH POINT RULES (For Everyone):
 * - Game 1 of day: Forced crash at 1.00x
 * - Game 2 of day: Forced crash at 1.37x
 * - Game 3+ of day (WIN): Random crash between 1.50x - 4.56x
 * - Game 3+ of day (LOSS): Random crash between 1.00x - 1.37x
 * 
 * PATTERN: Win, Loss, Win, Loss... (alternating daily)
 * RESET: Daily at 00:00 UTC per player
 * 
 * BET LIMIT:
 * - Bet > 10 ZMW: FORCED LOSS at 1.00x (for everyone)
 */

class GameEngineEmitter extends EventEmitter {}
const emitter = new GameEngineEmitter();

let currentRound = null;
let disposed = false;
let pendingSeedObj = null;

/* ========================= HELPERS ========================= */

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function hmacSha256Hex(key, message = '') {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

function hashToCrashPoint(hashHex) {
  const prefix = (hashHex || '').slice(0, 13);
  const h = parseInt(prefix, 16);
  const e = Math.pow(2, 52);
  const numerator = (100 * e - h);
  const denominator = (e - h);
  if (denominator <= 0) return 1.0;
  const result = Math.floor((numerator / denominator)) / 100;
  return Math.max(1.0, Number(result.toFixed(2)));
}

function computeCrashPointFromSeed(serverSeed, clientSeed = '') {
  try {
    const hashHex = hmacSha256Hex(serverSeed, clientSeed);
    return { crashPoint: hashToCrashPoint(hashHex), hashHex };
  } catch (e) {
    logger.error('computeCrashPointFromSeed.error', { message: e && e.message ? e.message : String(e) });
    return { crashPoint: 1.0, hashHex: null };
  }
}

function computeMultiplier(startedAt) {
  const elapsedMs = Date.now() - startedAt;
  const growthPerSecond = 1;
  const multiplier = 1 + (elapsedMs / 1000) * growthPerSecond;
  return Number(multiplier.toFixed(2));
}

function safeClearTimer(t) {
  try { if (t) clearTimeout(t); } catch (e) {}
}

/* ========================= OUTCOME LOGIC FOR ALL USERS ========================= */

/**
 * Generate realistic random crash point within a range
 * @param {number} min - Minimum crash point (e.g., 1.00)
 * @param {number} max - Maximum crash point (e.g., 4.56)
 * @returns {number} Random crash point between min and max
 */
function getRandomCrashPoint(min, max) {
  const random = Math.random();
  const range = max - min;
  const crashPoint = min + (random * range);
  return Number(crashPoint.toFixed(2));
}

/**
 * ✅ NEW: Determine outcome for ANY player (not just new users)
 * Applies same system to everyone
 */
function determinePlayerOutcome(gamesPlayedToday, lastGameOutcome, betAmount) {
  // Check bet limit first (everyone has this limit)
  if (betAmount > 10) {
    return {
      isPredetermined: true,
      outcome: 'loss',
      reason: 'bet_limit_violation',
      forcedCrashPoint: 1.00,
      message: 'Bet exceeds 10 ZMW limit - instant loss'
    };
  }

  // Game 1: Forced loss at 1.00x
  if (gamesPlayedToday === 0) {
    return {
      isPredetermined: true,
      outcome: 'loss',
      reason: 'forced_loss_game_1',
      forcedCrashPoint: 1.00,
      message: 'Game 1 - plane crashes at 1.00x'
    };
  }

  // Game 2: Forced loss at 1.37x
  if (gamesPlayedToday === 1) {
    return {
      isPredetermined: true,
      outcome: 'loss',
      reason: 'forced_loss_game_2',
      forcedCrashPoint: 1.37,
      message: 'Game 2 - plane crashes at 1.37x'
    };
  }

  // Game 3+: Alternating win/loss with realistic variance (for EVERYONE)
  let nextOutcome = 'win'; // Default first alternation is win
  if (lastGameOutcome === 'win') {
    nextOutcome = 'loss';
  } else if (lastGameOutcome === 'loss') {
    nextOutcome = 'win';
  }

  // Generate realistic random crash point
  let forcedCrashPoint;
  if (nextOutcome === 'win') {
    // Win: Random between 1.50x and 4.56x
    forcedCrashPoint = getRandomCrashPoint(1.50, 4.56);
  } else {
    // Loss: Random between 1.00x and 1.37x
    forcedCrashPoint = getRandomCrashPoint(1.00, 1.37);
  }

  return {
    isPredetermined: true,
    outcome: nextOutcome,
    reason: nextOutcome === 'win' ? 'alternating_win' : 'alternating_loss',
    forcedCrashPoint: forcedCrashPoint,
    message: `Game ${gamesPlayedToday + 1}: ${nextOutcome === 'win' ? 'Winning round' : 'Losing round'} - plane crashes at ${forcedCrashPoint}x`
  };
}

/* ========================= ENGINE BEHAVIOR ========================= */

function setNextSeed(obj) {
  if (!obj || !obj.seed || !obj.seedHash || typeof obj.commitIdx === 'undefined') {
    logger.warn('game.setNextSeed.invalid', { obj });
    pendingSeedObj = null;
    return;
  }
  pendingSeedObj = {
    seed: String(obj.seed),
    seedHash: String(obj.seedHash),
    commitIdx: Number(obj.commitIdx)
  };
  logger.info('game.next_seed_set', { commitIdx: pendingSeedObj.commitIdx, seedHash: pendingSeedObj.seedHash });
}

function markRoundCrashed(round, reason = 'auto') {
  if (!round) return;
  if (round.status === 'crashed') return;

  round.status = 'crashed';
  round.locked = true;
  round.endedAt = Date.now();

  if (round.timer) {
    try { clearTimeout(round.timer); } catch (e) {}
    round.timer = null;
  }

  logger.info('game.round.crashed', { roundId: round.roundId, reason, crashPoint: round.crashPoint });

  try {
    emitter.emit('roundCrashed', {
      roundId: round.roundId,
      crashPoint: round.crashPoint,
      serverSeedHash: round.serverSeedHash,
      serverSeed: round.serverSeed,
      commitIdx: round.commitIdx,
      startedAt: round.startedAt,
      endedAt: round.endedAt,
      meta: round.meta || {}
    });
  } catch (e) {
    logger.warn('gameEngine.emit.roundCrashed_failed', { message: e && e.message ? e.message : String(e) });
  }

  if (!round.nextRoundTimer && !disposed) {
    const t = setTimeout(() => {
      try {
        currentRound = null;
        if (!disposed) {
          createNewRound();
        } else {
          logger.info('game.round.not_restarting_because_disposed', { roundId: round.roundId });
        }
      } catch (e) {
        logger.error('game.round.schedule_next_error', { message: e && e.message ? e.message : String(e) });
      }
    }, 5000);
    if (typeof t.unref === 'function') t.unref();
    round.nextRoundTimer = t;
  }
}

function createNewRound() {
  if (disposed) {
    logger.info('game.round.create_skipped_disposed');
    return null;
  }

  if (currentRound) {
    try {
      if (currentRound.timer) { clearTimeout(currentRound.timer); currentRound.timer = null; }
      if (currentRound.nextRoundTimer) { clearTimeout(currentRound.nextRoundTimer); currentRound.nextRoundTimer = null; }
    } catch (e) {}
  }

  const roundId = crypto.randomUUID();

  let serverSeed = null;
  let serverSeedHash = null;
  let commitIdx = null;

  if (pendingSeedObj && pendingSeedObj.seed && pendingSeedObj.seedHash && typeof pendingSeedObj.commitIdx !== 'undefined') {
    serverSeed = pendingSeedObj.seed;
    serverSeedHash = pendingSeedObj.seedHash;
    commitIdx = pendingSeedObj.commitIdx;
    pendingSeedObj = null;
  } else {
    serverSeed = crypto.randomBytes(32).toString('hex');
    serverSeedHash = sha256hex(serverSeed);
    commitIdx = null;
    logger.warn('game.round.generated_ephemeral_seed', { roundId });
  }

  const { crashPoint, hashHex } = computeCrashPointFromSeed(serverSeed, '');
  const delayMs = Math.max(100, Math.floor((crashPoint - 1) * 1000));

  currentRound = {
    roundId,
    crashPoint,
    serverSeed,
    serverSeedHash,
    commitIdx,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    locked: false,
    players: new Map(),
    timer: null,
    nextRoundTimer: null,
    meta: {}
  };

  const t = setTimeout(() => {
    if (currentRound && currentRound.status === 'running') {
      markRoundCrashed(currentRound, 'timer');
    }
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
  currentRound.timer = t;

  logger.info('game.round.started', { roundId: currentRound.roundId, crashPoint: currentRound.crashPoint, startedAt: currentRound.startedAt, serverSeedHash: currentRound.serverSeedHash, commitIdx: currentRound.commitIdx });

  try {
    emitter.emit('roundStarted', {
      roundId: currentRound.roundId,
      serverSeedHash: currentRound.serverSeedHash,
      commitIdx: currentRound.commitIdx,
      crashPoint: currentRound.crashPoint,
      startedAt: currentRound.startedAt,
      meta: currentRound.meta || {}
    });
  } catch (e) {
    logger.warn('gameEngine.emit.roundStarted_failed', { message: e && e.message ? e.message : String(e) });
  }

  return currentRound;
}

/* ========================================================= PUBLIC API ========================================================= */

function startEngine() {
  if (disposed) return;
  logger.info('game.engine.starting');
  createNewRound();
}

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
    serverSeedHash: currentRound.serverSeedHash,
    commitIdx: currentRound.commitIdx
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
    startedAt: currentRound.startedAt,
    commitIdx: currentRound.commitIdx
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
  const payout = Number((Number(player.betAmount) * Number(multiplier)).toFixed(2));

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

/* ========================================================= EXPORTS ========================================================= */

module.exports = {
  startEngine,
  setNextSeed,
  getRoundStatus,
  joinRound,
  cashOut,
  dispose,
  emitter,
  _internal: { hashToCrashPoint, computeCrashPointFromSeed },
  _outcomes: { determinePlayerOutcome, getRandomCrashPoint } // ✅ EXPORT FOR ALL USERS
};
