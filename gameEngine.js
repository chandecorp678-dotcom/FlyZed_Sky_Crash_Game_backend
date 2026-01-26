'use strict';
const crypto = require('crypto');

/**
 * In-memory round store (OK for now).
 * Later this moves to DB or Redis.
 */
const rounds = new Map();

/**
 * Create a new game round.
 * The crash point is generated and KEPT SERVER-SIDE.
 */
function startRound() {
  const roundId = crypto.randomUUID();

  const crashPoint = generateCrashPoint();
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto
    .createHash('sha256')
    .update(serverSeed)
    .digest('hex');

  const round = {
  roundId,
  crashPoint,
  serverSeed,
  serverSeedHash,
  status: 'running',
  locked: false,      // 🔐 ADD THIS
  playerId: null,     // 🔐 ADD THIS
  startedAt: Date.now(),
  endedAt: null
};
  };

  rounds.set(roundId, round);

  // IMPORTANT: never return crashPoint
  return {
    roundId,
    serverSeedHash,
    startedAt: round.startedAt
  };
}

/**
 * Attempt to cash out a round.
 * Backend decides if the player won or lost.
 */
function cashOut(roundId, betAmount, cashoutMultiplier) {
  const round = rounds.get(roundId);
  if (!round) {
    throw new Error('Invalid round');
  }

  if (round.status !== 'running') {
    throw new Error('Round already ended');
  }

  // If player cashes out AFTER crash → loss
  if (cashoutMultiplier >= round.crashPoint) {
    round.status = 'crashed';
    round.endedAt = Date.now();
    return { win: false, payout: 0 };
  }

  // Player cashed out before crash → win
  const payout = computePayout(betAmount, cashoutMultiplier);

  round.status = 'cashed_out';
  round.endedAt = Date.now();

  return {
    win: true,
    payout
  };
}

/**
 * Internal crash generator (loss-biased).
 */
function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.7) {
    return Number((1.1 + Math.random() * 0.6).toFixed(2));
  } else {
    return Number((2 + Math.random() * 3).toFixed(2));
  }
}

/**
 * Payout calculator.
 */
function computePayout(betAmount, multiplier) {
  const b = Number(betAmount) || 0;
  const m = Number(multiplier) || 0;
  return Number((b * m).toFixed(2));
}

module.exports = {
  startRound,
  cashOut
};
