'use strict';

const express = require('express');
const crypto = require('crypto');
const logger = require('./logger');
const { runTransaction } = require('./dbHelper');
const gameEngine = require('./gameEngine');

const router = express.Router();
const STARTING_BALANCE = Number(process.env.DEMO_STARTING_BALANCE || 1000);
const MIN_BET = Number(process.env.DEMO_MIN_BET || 1);
const MAX_BET = Number(process.env.DEMO_MAX_BET || 9.99);
let schemaPromise;

async function ensureDemoSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS demo_wallets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          balance NUMERIC(18,2) NOT NULL DEFAULT 1000.00 CHECK (balance >= 0),
          currency_label VARCHAR(20) NOT NULL DEFAULT 'VC',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS demo_wallet_ledger (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          wallet_id UUID NOT NULL REFERENCES demo_wallets(id) ON DELETE CASCADE,
          transaction_type VARCHAR(30) NOT NULL CHECK (transaction_type IN ('INITIAL_CREDIT','BET_DEBIT','WIN_CREDIT','RESET_CREDIT','BET_REFUND')),
          amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
          balance_before NUMERIC(18,2) NOT NULL CHECK (balance_before >= 0),
          balance_after NUMERIC(18,2) NOT NULL CHECK (balance_after >= 0),
          reference_id UUID,
          idempotency_key UUID NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_demo_ledger_user_created ON demo_wallet_ledger(user_id, created_at DESC)`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS demo_bets (
          id UUID PRIMARY KEY,
          round_id TEXT NOT NULL,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          bet_amount NUMERIC(18,2) NOT NULL CHECK (bet_amount > 0),
          payout NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (payout >= 0),
          cashout_multiplier NUMERIC(10,2),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cashed','lost','refunded')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          settled_at TIMESTAMPTZ
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_demo_bets_user_round ON demo_bets(user_id, round_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_demo_bets_active_round ON demo_bets(round_id) WHERE status = 'active'`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_bets_one_active_per_user_round ON demo_bets(user_id, round_id) WHERE status = 'active'`);
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

function requireAuth(req, res, next) {
  if (!req.user || !req.user.id || req.user.guest) {
    return res.status(401).json({ error: 'Please log in to use your demo wallet.' });
  }
  return next();
}

async function getOrCreateWallet(client, userId) {
  const created = await client.query(
    `INSERT INTO demo_wallets (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING RETURNING id, balance, currency_label`,
    [userId, STARTING_BALANCE]
  );
  if (created.rowCount) {
    const wallet = created.rows[0];
    await client.query(
      `INSERT INTO demo_wallet_ledger (user_id, wallet_id, transaction_type, amount, balance_before, balance_after, idempotency_key)
       VALUES ($1, $2, 'INITIAL_CREDIT', $3, 0, $3, $4)`,
      [userId, wallet.id, STARTING_BALANCE, `00000000-0000-4000-8000-${crypto.createHash('sha256').update(`demo-initial:${userId}`).digest('hex').slice(0, 12)}`]
    );
    return wallet;
  }
  const wallet = await client.query(
    `SELECT id, balance, currency_label FROM demo_wallets WHERE user_id = $1 FOR UPDATE`,
    [userId]
  );
  return wallet.rows[0];
}

async function settleCrashedBets(db, userId, currentStatus) {
  await runTransaction(db, async (client) => {
    const pending = await client.query(
      `SELECT b.id, b.round_id FROM demo_bets b
       LEFT JOIN rounds r ON r.round_id = b.round_id
       WHERE b.user_id = $1 AND b.status = 'active'
         AND (r.ended_at IS NOT NULL OR ($2 = 'crashed' AND b.round_id = $3))
       FOR UPDATE OF b`,
      [userId, currentStatus?.status || '', currentStatus?.roundId || null]
    );
    for (const bet of pending.rows) {
      await client.query(
        `UPDATE demo_bets SET status = 'lost', payout = 0, settled_at = NOW() WHERE id = $1 AND status = 'active'`,
        [bet.id]
      );
    }
  });
}

router.use(express.json(), requireAuth);

router.get('/wallet', async (req, res) => {
  const db = req.app.locals.db;
  try {
    await ensureDemoSchema(db);
    const status = gameEngine.getRoundStatus();
    await settleCrashedBets(db, req.user.id, status);
    const result = await runTransaction(db, (client) => getOrCreateWallet(client, req.user.id));
    return res.json({ mode: 'DEMO', balance: Number(result.balance), currency: result.currency_label || 'VC', resetAvailable: Number(result.balance) === 0 });
  } catch (err) {
    logger.error('demo.wallet.get_failed', { userId: req.user.id, message: err.message });
    return res.status(500).json({ error: 'Unable to load demo wallet.' });
  }
});

router.post('/wallet/reset', async (req, res) => {
  const db = req.app.locals.db;
  try {
    await ensureDemoSchema(db);
    const result = await runTransaction(db, async (client) => {
      const wallet = await getOrCreateWallet(client, req.user.id);
      if (Number(wallet.balance) !== 0) {
        const err = new Error('Demo credits can only be reset when the balance is zero.');
        err.status = 409;
        throw err;
      }
      const active = await client.query(`SELECT id FROM demo_bets WHERE user_id = $1 AND status = 'active' LIMIT 1 FOR UPDATE`, [req.user.id]);
      if (active.rowCount) {
        const err = new Error('Finish your active demo round before resetting credits.');
        err.status = 409;
        throw err;
      }
      const updated = await client.query(
        `UPDATE demo_wallets SET balance = $1, updated_at = NOW() WHERE id = $2 RETURNING balance`,
        [STARTING_BALANCE, wallet.id]
      );
      await client.query(
        `INSERT INTO demo_wallet_ledger (user_id, wallet_id, transaction_type, amount, balance_before, balance_after, idempotency_key)
         VALUES ($1, $2, 'RESET_CREDIT', $3, 0, $3, $4)`,
        [req.user.id, wallet.id, STARTING_BALANCE, crypto.randomUUID()]
      );
      return Number(updated.rows[0].balance);
    });
    return res.json({ success: true, mode: 'DEMO', balance: result, currency: 'VC' });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message });
    logger.error('demo.wallet.reset_failed', { userId: req.user.id, message: err.message });
    return res.status(500).json({ error: 'Unable to reset demo credits.' });
  }
});

router.post('/start', async (req, res) => {
  const db = req.app.locals.db;
  const betAmount = Number(req.body?.betAmount);
  if (!Number.isFinite(betAmount) || betAmount < MIN_BET || betAmount > MAX_BET) {
    return res.status(400).json({ error: `Demo bet must be between ${MIN_BET} and ${MAX_BET} virtual credits.` });
  }
  const status = gameEngine.getRoundStatus();
  if (!status || status.status !== 'running') return res.status(400).json({ error: 'No active running round.' });
  try {
    await ensureDemoSchema(db);
    const result = await runTransaction(db, async (client) => {
      // Lock the account row to serialize demo wallet and mode checks with other demo requests.
      const account = await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [req.user.id]);
      if (!account.rowCount) throw Object.assign(new Error('User not found.'), { status: 404 });
      const realBet = await client.query(`SELECT id FROM bets WHERE user_id = $1 AND round_id = $2 AND status = 'active' LIMIT 1`, [req.user.id, status.roundId]);
      if (realBet.rowCount) throw Object.assign(new Error('You already have an unsettled bet in this shared round.'), { status: 409 });
      const currentDemo = await client.query(`SELECT id FROM demo_bets WHERE user_id = $1 AND round_id = $2 AND status = 'active' LIMIT 1`, [req.user.id, status.roundId]);
      if (currentDemo.rowCount) throw Object.assign(new Error('You already have an unsettled bet in this shared round.'), { status: 409 });
      const wallet = await getOrCreateWallet(client, req.user.id);
      const debit = await client.query(
        `UPDATE demo_wallets SET balance = balance - $1, updated_at = NOW()
         WHERE id = $2 AND balance >= $1 RETURNING balance`,
        [betAmount, wallet.id]
      );
      if (!debit.rowCount) throw Object.assign(new Error('Insufficient demo credits.'), { status: 402 });
      const betId = crypto.randomUUID();
      await client.query(
        `INSERT INTO demo_bets (id, round_id, user_id, bet_amount, status) VALUES ($1, $2, $3, $4, 'active')`,
        [betId, status.roundId, req.user.id, betAmount]
      );
      await client.query(
        `INSERT INTO demo_wallet_ledger (user_id, wallet_id, transaction_type, amount, balance_before, balance_after, reference_id, idempotency_key)
         VALUES ($1, $2, 'BET_DEBIT', $3, $4, $5, $6, $7)`,
        [req.user.id, wallet.id, betAmount, Number(debit.rows[0].balance) + betAmount, debit.rows[0].balance, betId, crypto.randomUUID()]
      );
      return { betId, balance: Number(debit.rows[0].balance) };
    });

    try {
      const engine = gameEngine.joinRound(`DEMO:${req.user.id}`, betAmount);
      return res.json({ success: true, mode: 'DEMO', ...result, roundId: engine.roundId, serverSeedHash: engine.serverSeedHash, startedAt: engine.startedAt });
    } catch (engineErr) {
      await runTransaction(db, async (client) => {
        const wallet = await client.query(`SELECT id, balance FROM demo_wallets WHERE user_id = $1 FOR UPDATE`, [req.user.id]);
        const before = Number(wallet.rows[0].balance);
        const after = before + betAmount;
        await client.query(`UPDATE demo_wallets SET balance = $1, updated_at = NOW() WHERE id = $2`, [after, wallet.rows[0].id]);
        await client.query(`UPDATE demo_bets SET status = 'refunded', settled_at = NOW() WHERE id = $1 AND status = 'active'`, [result.betId]);
        await client.query(
          `INSERT INTO demo_wallet_ledger (user_id, wallet_id, transaction_type, amount, balance_before, balance_after, reference_id, idempotency_key)
           VALUES ($1, $2, 'BET_REFUND', $3, $4, $5, $6, $7)`,
          [req.user.id, wallet.rows[0].id, betAmount, before, after, result.betId, crypto.randomUUID()]
        );
      });
      throw engineErr;
    }
  } catch (err) {
    if ([402, 404, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
    logger.error('demo.bet.start_failed', { userId: req.user.id, message: err.message });
    return res.status(500).json({ error: 'Unable to place demo bet.' });
  }
});

router.post('/cashout', async (req, res) => {
  const db = req.app.locals.db;
  const betId = req.body?.betId;
  if (!betId) return res.status(400).json({ error: 'betId is required.' });
  try {
    await ensureDemoSchema(db);
    const currentStatus = gameEngine.getRoundStatus();
    await settleCrashedBets(db, req.user.id, currentStatus);
    const result = await runTransaction(db, async (client) => {
      const betResult = await client.query(`SELECT * FROM demo_bets WHERE id = $1 AND user_id = $2 FOR UPDATE`, [betId, req.user.id]);
      if (!betResult.rowCount) throw Object.assign(new Error('Demo bet not found.'), { status: 404 });
      const bet = betResult.rows[0];
      const walletResult = await client.query(`SELECT id, balance FROM demo_wallets WHERE user_id = $1 FOR UPDATE`, [req.user.id]);
      if (bet.status === 'cashed') return { success: true, idempotent: true, payout: Number(bet.payout), balance: Number(walletResult.rows[0].balance), multiplier: Number(bet.cashout_multiplier) };
      if (bet.status === 'lost') return { success: false, idempotent: true, payout: 0, balance: Number(walletResult.rows[0].balance) };
      if (bet.status !== 'active') throw Object.assign(new Error('This demo bet is no longer active.'), { status: 409 });

      const status = gameEngine.getRoundStatus();
      if (!status || status.roundId !== bet.round_id || status.status !== 'running') {
        await client.query(`UPDATE demo_bets SET status = 'lost', payout = 0, settled_at = NOW() WHERE id = $1`, [bet.id]);
        return { success: false, payout: 0, balance: Number(walletResult.rows[0].balance) };
      }
      let outcome;
      try {
        outcome = gameEngine.cashOut(`DEMO:${req.user.id}`);
      } catch (engineErr) {
        throw Object.assign(new Error('Unable to cash out this demo bet.'), { status: 409 });
      }
      if (!outcome.win) {
        await client.query(`UPDATE demo_bets SET status = 'lost', payout = 0, settled_at = NOW() WHERE id = $1`, [bet.id]);
        return { success: false, payout: 0, balance: Number(walletResult.rows[0].balance), multiplier: outcome.multiplier };
      }
      const payout = Number(outcome.payout);
      const before = Number(walletResult.rows[0].balance);
      const after = before + payout;
      await client.query(`UPDATE demo_wallets SET balance = $1, updated_at = NOW() WHERE id = $2`, [after, walletResult.rows[0].id]);
      await client.query(
        `INSERT INTO demo_wallet_ledger (user_id, wallet_id, transaction_type, amount, balance_before, balance_after, reference_id, idempotency_key)
         VALUES ($1, $2, 'WIN_CREDIT', $3, $4, $5, $6, $7)`,
        [req.user.id, walletResult.rows[0].id, payout, before, after, bet.id, crypto.randomUUID()]
      );
      await client.query(`UPDATE demo_bets SET status = 'cashed', payout = $1, cashout_multiplier = $2, settled_at = NOW() WHERE id = $3`, [payout, outcome.multiplier, bet.id]);
      return { success: true, payout, multiplier: outcome.multiplier, balance: after };
    });
    return res.json({ mode: 'DEMO', ...result });
  } catch (err) {
    if ([404, 409].includes(err.status)) return res.status(err.status).json({ error: err.message });
    logger.error('demo.bet.cashout_failed', { userId: req.user.id, betId, message: err.message });
    return res.status(500).json({ error: 'Unable to cash out demo bet.' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const db = req.app.locals.db;
    await ensureDemoSchema(db);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const result = await db.query(
      `SELECT id, round_id, bet_amount, payout, cashout_multiplier, status, created_at, settled_at
       FROM demo_bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.user.id, limit]
    );
    return res.json({ mode: 'DEMO', bets: result.rows });
  } catch (err) {
    logger.error('demo.history.failed', { userId: req.user.id, message: err.message });
    return res.status(500).json({ error: 'Unable to load demo history.' });
  }
});

module.exports = router;
module.exports.ensureDemoSchema = ensureDemoSchema;
