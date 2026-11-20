'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('demo and real-money participants can join the same live engine round', async () => {
  const engine = require('../gameEngine');
  engine.startEngine();
  try {
    const status = engine.getRoundStatus();
    assert.equal(status.status, 'running');

    const demoJoin = engine.joinRound('DEMO:shared-user', 5);
    const realJoin = engine.joinRound('REAL:shared-user', 5);

    assert.equal(demoJoin.roundId, status.roundId);
    assert.equal(realJoin.roundId, status.roundId);
    assert.equal(engine.cashOut('DEMO:shared-user').win, true);
    assert.equal(engine.cashOut('REAL:shared-user').win, true);
  } finally {
    await engine.dispose();
  }
});

test('demo wallet reset is server-guarded to zero balance and no active demo bet', () => {
  const source = read('demo-mode.js');
  assert.match(source, /Number\(wallet\.balance\) !== 0/);
  assert.match(source, /SELECT id FROM demo_bets WHERE user_id = \$1 AND status = 'active'/);
  assert.match(source, /'RESET_CREDIT'/);
});

test('demo bet and wallet logic do not write to the real-money users.balance column', () => {
  const source = read('demo-mode.js');
  assert.match(source, /UPDATE demo_wallets SET balance = balance - \$1/);
  assert.match(source, /UPDATE demo_wallets SET balance = \$1/);
  assert.doesNotMatch(source, /UPDATE\s+users\s+SET\s+balance\s*=/i);
});

test('real-money game and ZILS payment routes remain mounted and retain their balance flow', () => {
  const routes = read('routes-index.js');
  const game = read('game.js');
  const payments = read('payments.js');

  assert.match(routes, /router\.use\("\/payments", payments\)/);
  assert.match(routes, /router\.use\("\/game", game\)/);
  assert.match(game, /UPDATE users\s+SET balance = balance - \$1/i);
  assert.match(game, /UPDATE users SET balance = balance \+ \$1/i);
  assert.match(payments, /zils\.deposit\(/);
  assert.match(payments, /zils\.withdrawal\(/);
});
