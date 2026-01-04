// Simple game engine helpers for Ka Ndeke
// Exports a function to generate a crash point and a small helper to compute payout.

'use strict';

/**
 * Generate a crash point for a round.
 * Mirrors the client-side LOSS-BIASED logic:
 * - 70% chance of an early crash between 1.1 and 1.7
 * - 30% chance of a later crash between 2.0 and 5.0
 *
 * Returns a Number (e.g. 1.23).
 */
function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.7) {
    return 1.1 + Math.random() * 0.6; // 1.10 .. 1.70
  } else {
    return 2 + Math.random() * 3;     // 2.00 .. 5.00
  }
}

/**
 * Compute payout given bet amount and multiplier.
 * Returns Number (payout amount).
 */
function computePayout(betAmount, multiplier) {
  const b = Number(betAmount) || 0;
  const m = Number(multiplier) || 0;
  return b * m;
}

module.exports = {
  generateCrashPoint,
  computePayout
};

