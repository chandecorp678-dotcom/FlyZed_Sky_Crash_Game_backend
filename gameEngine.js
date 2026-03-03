'use strict';
const crypto = require('crypto');
const EventEmitter = require('events');
const logger = require('./logger');

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

/* ========================= OUTCOME LOGIC ========================= */

/**
 * Generate realistic random crash point within a range
 * Loss range: 1.00x - 1.37x
 * Win range: 1.50x - 4.56x
 */
function getRandomCrashPoint(min, max) {
  const random = Math.random();
  const range = max - min;
  const crashPoint = min + (random * range);
  return Number(crashPoint.toFixed(2));
}

/**
 * ✅ FIXED: Determine outcome for ALL players
 * 
 * Win rounds: maxCrashPoint = 4.56x (player can cash out anytime before this)
 * Loss rounds: random crash between 1.00x - 1.37x
 */
function determinePlayerOutcome(gamesPlayedToday, lastGameOutcome, betAmount) {
  // Check bet limit first
  if (betAmount > 10) {
    return {
      isPredetermined: true,
      outcome: 'loss',
      reason: 'bet_limit_violation',
      forcedCrashPoint: 1.00,
      maxCrashPoint: 1.00,
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
      maxCrashPoint: 1.00,
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
      maxCrashPoint: 1.37,
      message: 'Game 2 - plane crashes at 1.37x'
    };
  }

  // Game 3+: Alternating win/loss
  let nextOutcome = 'win';
  if (lastGameOutcome === 'win') {
    nextOutcome = 'loss';
  } else if (lastGameOutcome === 'loss') {
    nextOutcome = 'win';
  }

  let forcedCrashPoint;
  let maxCrashPoint;

  if (nextOutcome === 'win') {
    // ✅ FIX: Win rounds crash at 4.56x MAXIMUM
    // Player can cash out anytime before 4.56x
    forcedCrashPoint = 4.56; // Always set to max
    maxCrashPoint = 4.56;    // Cap at 4.56x
  } else {
    // Loss: Random between 1.00x and 1.37x
    forcedCrashPoint = getRandomCrashPoint(1.00, 1.37);
    maxCrashPoint = forcedCrashPoint;
  }

  return {
    isPredetermined: true,
    outcome: nextOutcome,
    reason: nextOutcome === 'win' ? 'alternating_win' : 'alternating_loss',
    forcedCrashPoint: forcedCrashPoint,
    maxCrashPoint: maxCrashPoint,
    message: nextOutcome === 'win' 
      ? `Game ${gamesPlayedToday + 1}: Winning round - cash out before 4.56x or plane crashes!`
      : `Game ${gamesPlayedToday + 1}: Losing round - plane crashes at ${forcedCrashPoint}x`
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
  logger.info('game.next_seed_set', { commitIdx: pendingSeedObj.commitIdx });
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

  const { crashPoint } = computeCrashPointFromSeed(serverSeed, '');
  // ✅ FIX: Use 4.56x as default crash point (allows full range for win rounds)
  const maxCrashPoint = 4.56;
  const delayMs = Math.max(100, Math.floor((maxCrashPoint - 1) * 1000));

  currentRound = {
    roundId,
    crashPoint: maxCrashPoint, // ✅ Always 4.56x for the timer
    maxCrashPoint: maxCrashPoint,
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

  // ✅ FIX: Auto-crash at 4.56x if round still running
  const t = setTimeout(() => {
    if (currentRound && currentRound.status === 'running') {
      markRoundCrashed(currentRound, 'max_crash_point_reached');
    }
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
  currentRound.timer = t;

  logger.info('game.round.started', { 
    roundId: currentRound.roundId, 
    maxCrashPoint: currentRound.maxCrashPoint,
    startedAt: currentRound.startedAt 
  });

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

    // ✅ FIX: Check against maxCrashPoint (4.56x) instead of random crash point
    if (multiplier >= currentRound.maxCrashPoint) {
      markRoundCrashed(currentRound, 'max_multiplier_reached');
      multiplier = currentRound.maxCrashPoint;
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

  // ✅ FIX: Check against maxCrashPoint
  if (multiplier >= currentRound.maxCrashPoint || currentRound.status !== 'running') {
    if (currentRound.status !== 'crashed') {
      markRoundCrashed(currentRound, 'cashout_at_max');
    }
    return { win: false, payout: 0, multiplier: currentRound.maxCrashPoint };
  }

  player.cashedOut = true;

  multiplier = Number(multiplier.toFixed(2));
  const payout = Number((Number(player.betAmount) * Number(multiplier)).toFixed(2));

  player.payout = payout;
  player.cashedAt = Date.now();
  player.cashedMultiplier = multiplier;

  logger.info('game.player.cashed', { playerId, multiplier, payout });

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

    logger.info('game.dispose.completed');
    currentRound = null;
  } catch (err) {
    logger.error('game.dispose.error', { message: err && err.message ? err.message : String(err) });
  }
}

module.exports = {
  startEngine,
  setNextSeed,
  getRoundStatus,
  joinRound,
  cashOut,
  dispose,
  emitter,
  _internal: { hashToCrashPoint, computeCrashPointFromSeed },
  _outcomes: { determinePlayerOutcome, getRandomCrashPoint }
};
