'use strict';
const crypto = require('crypto');

/**
 * In-memory round store (OK for now).
 * Later this moves to DB or Redis.
 */
const rounds = new Map();

/* ---------------- ROUND STATUS ---------------- */

function getRoundStatus(roundId) {
  const round = rounds.get(roundId);

  if (!round) {
    return { status: 'invalid' };
  }

  return {
    status: round.status,
    endedAt: round.endedAt
  };
}

/* ---------------- ROUND CREATION ---------------- */

function crashDelayFromPoint(crashPoint) {
  // Converts multiplier into milliseconds (server-only)
  return Math.floor((crashPoint - 1) * 1000);
}

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
    locked: false,
    playerId: null,
    startedAt: Date.now(),
    endedAt: null,
    timer: null
  };

  rounds.set(roundId, round);

  // ⏱️ AUTO-CRASH (SERVER AUTHORITATIVE)
  const delay = crashDelayFromPoint(crashPoint);

  round.timer = setTimeout(() => {
    if (round.status === 'running') {
      round.status = 'crashed';
      round.locked = true;
      round.endedAt = Date.now();
    }
  }, delay);

  // IMPORTANT: never expose crashPoint
  return {
    roundId,
    serverSeedHash,
    startedAt: round.startedAt
  };
}

/* ---------------- CASH OUT ---------------- */

function cashOut(roundId, betAmount, cashoutMultiplier, playerId) {
  const round = rounds.get(roundId);
  if (!round) {
    throw new Error('Invalid round');
  }

  // 🔐 Prevent double settlement
  if (round.locked) {
    throw new Error('Wallet already settled');
  }

  // 🔐 Bind round to first player
  if (!round.playerId) {
    round.playerId = playerId;
  }

  if (round.playerId !== playerId) {
    throw new Error('Unauthorized cashout');
  }

  // Clear auto-crash timer
  if (round.timer) {
    clearTimeout(round.timer);
    round.timer = null;
  }

  // AFTER crash → loss
  if (cashoutMultiplier >= round.crashPoint) {
    round.status = 'crashed';
    round.locked = true;
    round.endedAt = Date.now();
    return { win: false, payout: 0 };
  }

  // BEFORE crash → win
  const payout = computePayout(betAmount, cashoutMultiplier);

  round.status = 'cashed_out';
  round.locked = true;
  round.endedAt = Date.now();

  return {
    win: true,
    payout
  };
}

/* ---------------- INTERNALS ---------------- */

function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.7) {
    return Number((1.1 + Math.random() * 0.6).toFixed(2));
  } else {
    return Number((2 + Math.random() * 3).toFixed(2));
  }
}

function computePayout(betAmount, multiplier) {
  const b = Number(betAmount) || 0;
  const m = Number(multiplier) || 0;
  return Number((b * m).toFixed(2));
}

module.exports = {
  startRound,
  cashOut,
  getRoundStatus
}; 
