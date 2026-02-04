'use strict';
const crypto = require('crypto');

/* =========================================================
   GLOBAL ROUND STATE
========================================================= */

let activeRound = null;
let roundPlayers = new Map(); // playerId -> { betAmount, cashedOut }

/* =========================================================
   INTERNAL HELPERS
========================================================= */

function computeMultiplier(startedAt) {
  const elapsedMs = Date.now() - startedAt;
  const growthPerSecond = 1;
  const multiplier = 1 + (elapsedMs / 1000) * growthPerSecond;
  return Number(multiplier.toFixed(2));
}

function crashDelayFromPoint(crashPoint) {
  return Math.floor((crashPoint - 1) * 1000);
}

function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.7) {
    return Number((1.1 + Math.random() * 0.6).toFixed(2));
  } else {
    return Number((2 + Math.random() * 3).toFixed(2));
  }
}

function computePayout(betAmount, multiplier) {
  return Number((Number(betAmount) * Number(multiplier)).toFixed(2));
}

/* =========================================================
   ROUND LIFECYCLE
========================================================= */

function startNewRound() {
  const roundId = crypto.randomUUID();
  const crashPoint = generateCrashPoint();
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto
    .createHash('sha256')
    .update(serverSeed)
    .digest('hex');

  activeRound = {
    roundId,
    crashPoint,
    serverSeed,
    serverSeedHash,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    timer: null
  };

  roundPlayers.clear();

  const delay = crashDelayFromPoint(crashPoint);

  activeRound.timer = setTimeout(() => {
    if (activeRound && activeRound.status === 'running') {
      activeRound.status = 'crashed';
      activeRound.endedAt = Date.now();

      // 🔁 Start next round after 5 seconds
      setTimeout(startNewRound, 5000);
    }
  }, delay);

  console.log('🟢 New round started:', roundId);
}

/* Start the very first round on server boot */
startNewRound();

/* =========================================================
   PUBLIC API
========================================================= */

function getRoundStatus() {
  if (!activeRound) {
    return { status: 'waiting' };
  }

  let multiplier = null;

  if (activeRound.status === 'running') {
    multiplier = computeMultiplier(activeRound.startedAt);

    if (multiplier >= activeRound.crashPoint) {
      activeRound.status = 'crashed';
      activeRound.endedAt = Date.now();
      multiplier = activeRound.crashPoint;
    }
  }

  return {
    roundId: activeRound.roundId,
    status: activeRound.status,
    multiplier,
    endedAt: activeRound.endedAt
  };
}

function joinRound(playerId, betAmount) {
  if (!activeRound || activeRound.status !== 'running') {
    throw new Error('No active round');
  }

  if (roundPlayers.has(playerId)) {
    throw new Error('Player already joined this round');
  }

  roundPlayers.set(playerId, {
    betAmount: Number(betAmount),
    cashedOut: false
  });

  return {
    roundId: activeRound.roundId,
    serverSeedHash: activeRound.serverSeedHash,
    startedAt: activeRound.startedAt
  };
}

function cashOut(playerId) {
  if (!activeRound) {
    throw new Error('No active round');
  }

  const player = roundPlayers.get(playerId);
  if (!player) {
    throw new Error('Player not in round');
  }

  if (player.cashedOut) {
    throw new Error('Already cashed out');
  }

  const multiplier = computeMultiplier(activeRound.startedAt);

  if (multiplier >= activeRound.crashPoint || activeRound.status !== 'running') {
    return { win: false, payout: 0 };
  }

  player.cashedOut = true;

  const payout = computePayout(player.betAmount, multiplier);

  return {
    win: true,
    payout,
    multiplier
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  getRoundStatus,
  joinRound,
  cashOut
};
