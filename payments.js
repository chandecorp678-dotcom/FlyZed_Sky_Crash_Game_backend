'use strict';

const express = require('express');
const router = express.Router();
const logger = require('./logger');
const { sendError, wrapAsync } = require('./apiResponses');
const mtnPayments = require('./mtnPayments');
const { runTransaction } = require('./dbHelper');

/**
 * PAYMENTS ROUTES
 * POST /api/payments/deposit - User initiates deposit
 * POST /api/payments/withdraw - User initiates withdrawal
 * GET /api/payments/status/:transactionId - Check payment status
 * POST /api/payments/callback - MTN webhook callback
 * GET /api/payments/history - User's transaction history
 * GET /api/payments/details/:paymentId - Get payment details
 */

const DEPOSIT_MIN = Number(process.env.PAYMENT_MIN_AMOUNT || 10);
const DEPOSIT_MAX = Number(process.env.PAYMENT_MAX_AMOUNT || 5000);
const WITHDRAWAL_MIN = Number(process.env.PAYMENT_MIN_AMOUNT || 10);
const WITHDRAWAL_MAX = Number(process.env.PAYMENT_MAX_AMOUNT || 5000);

/**
 * Auth middleware: require logged-in user
 * ✅ FIXED: Removed async, just call next()
 */
function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) {
    return sendError(res, 401, 'Authentication required');
  }
  next();
}

// Apply auth to all payment routes except callback
router.use((req, res, next) => {
  // Allow callback without auth (webhook from MTN)
  if (req.path === '/callback') {
    return next();
  }
  requireAuth(req, res, next);
});

/**
 * POST /api/payments/deposit
 * User requests money to their MTN account
 * Body: { amount, phone }
 */
router.post('/deposit', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  let { amount, phone } = req.body || {};

  amount = Number(amount);
  phone = String(phone || '').trim();

  // Validate
  if (isNaN(amount) || amount < DEPOSIT_MIN || amount > DEPOSIT_MAX) {
    return sendError(res, 400, `Deposit amount must be between ZMW ${DEPOSIT_MIN} and ZMW ${DEPOSIT_MAX}`);
  }

  if (!phone) {
    return sendError(res, 400, 'Phone number required');
  }

  // ✅ Use mtnPayments.normalizePhoneNumber
  const normalizedPhone = mtnPayments.normalizePhoneNumber(phone);
  if (!normalizedPhone) {
    return sendError(res, 400, 'Invalid phone number format');
  }

  try {
    const result = await runTransaction(db, async (client) => {
      // Check if user already has pending deposit (prevent spam)
      const existingDeposit = await client.query(
        `SELECT id FROM payments WHERE user_id = $1 AND type = 'deposit' AND status IN ('pending', 'processing') 
         AND created_at > NOW() - INTERVAL '5 minutes'`,
        [userId]
      );

      if (existingDeposit.rowCount > 0) {
        const err = new Error('You have a pending deposit. Please wait before requesting another.');
        err.status = 409;
        throw err;
      }

      // Call MTN API to request money
      const externalId = mtnPayments.generateUUID();
      const mtnResponse = await mtnPayments.requestMoney(normalizedPhone, amount, externalId, 'Ka Ndeke Deposit');

      // Store payment record in DB
      const paymentId = mtnPayments.generateUUID();
      const now = new Date().toISOString();

      await client.query(
        `INSERT INTO payments (id, user_id, type, amount, phone, mtn_transaction_id, external_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [paymentId, userId, 'deposit', amount, normalizedPhone, mtnResponse.transactionId, externalId, 'pending', now, now]
      );

      logger.info('payments.deposit.initiated', { paymentId, userId, amount, phone: normalizedPhone, mtnTransactionId: mtnResponse.transactionId });

      return { paymentId, mtnTransactionId: mtnResponse.transactionId, status: 'pending' };
    });

    return res.status(202).json({
      ok: true,
      message: 'Deposit request sent. Please check your phone for MTN prompt.',
      paymentId: result.paymentId,
      mtnTransactionId: result.mtnTransactionId,
      amount,
      status: result.status
    });
  } catch (err) {
    if (err.status === 409) return sendError(res, err.status, err.message);
    logger.error('payments.deposit.error', { userId, amount, message: err.message });
    return sendError(res, 500, 'Failed to initiate deposit', err.message);
  }
}));

/**
 * POST /api/payments/withdraw
 * User withdraws money to their MTN account
 * Body: { amount, phone }
 */
router.post('/withdraw', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  let { amount, phone } = req.body || {};

  amount = Number(amount);
  phone = String(phone || '').trim();

  // Validate amount
  if (isNaN(amount) || amount < WITHDRAWAL_MIN || amount > WITHDRAWAL_MAX) {
    return sendError(res, 400, `Withdrawal amount must be between ZMW ${WITHDRAWAL_MIN} and ZMW ${WITHDRAWAL_MAX}`);
  }

  // Validate phone
  if (!phone) {
    return sendError(res, 400, 'Phone number required');
  }

  // ✅ Use mtnPayments.normalizePhoneNumber
  const normalizedPhone = mtnPayments.normalizePhoneNumber(phone);
  if (!normalizedPhone) {
    return sendError(res, 400, 'Invalid phone number format');
  }

  try {
    const result = await runTransaction(db, async (client) => {
      // Check user balance
      const userRes = await client.query(
        `SELECT balance FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );

      if (!userRes.rowCount) {
        const err = new Error('User not found');
        err.status = 404;
        throw err;
      }

      const balance = Number(userRes.rows[0].balance || 0);
      if (balance < amount) {
        const err = new Error('Insufficient balance');
        err.status = 402;
        throw err;
      }

      // Check pending withdrawals
      const pendingWithdraw = await client.query(
        `SELECT id FROM payments WHERE user_id = $1 AND type = 'withdraw' AND status IN ('pending', 'processing') 
         AND created_at > NOW() - INTERVAL '5 minutes'`,
        [userId]
      );

      if (pendingWithdraw.rowCount > 0) {
        const err = new Error('You have a pending withdrawal. Please wait before requesting another.');
        err.status = 409;
        throw err;
      }

      // Deduct balance (optimistic: will refund if MTN fails)
      await client.query(
        `UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2`,
        [amount, userId]
      );

      // Call MTN API to send money
      const externalId = mtnPayments.generateUUID();
      const mtnResponse = await mtnPayments.sendMoney(normalizedPhone, amount, externalId, 'Ka Ndeke Withdrawal');

      // Store payment record
      const paymentId = mtnPayments.generateUUID();
      const now = new Date().toISOString();

      await client.query(
        `INSERT INTO payments (id, user_id, type, amount, phone, mtn_transaction_id, external_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [paymentId, userId, 'withdraw', amount, normalizedPhone, mtnResponse.transactionId, externalId, 'processing', now, now]
      );

      logger.info('payments.withdraw.initiated', { paymentId, userId, amount, phone: normalizedPhone, mtnTransactionId: mtnResponse.transactionId });

      return { paymentId, mtnTransactionId: mtnResponse.transactionId, status: 'processing', newBalance: balance - amount };
    });

    return res.status(202).json({
      ok: true,
      message: 'Withdrawal initiated. Money will arrive in 1-2 minutes.',
      paymentId: result.paymentId,
      mtnTransactionId: result.mtnTransactionId,
      amount,
      status: result.status,
      newBalance: result.newBalance
    });
  } catch (err) {
    if (err.status === 402) return sendError(res, err.status, 'Insufficient balance');
    if (err.status === 409) return sendError(res, err.status, err.message);
    if (err.status === 404) return sendError(res, err.status, err.message);
    logger.error('payments.withdraw.error', { userId, amount, message: err.message });
    return sendError(res, 500, 'Failed to initiate withdrawal', err.message);
  }
}));

/**
 * GET /api/payments/status/:transactionId
 * Check status of a single payment
 */
router.get('/status/:transactionId', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  const transactionId = req.params.transactionId;

  if (!transactionId) {
    return sendError(res, 400, 'transactionId required');
  }

  try {
    // Get payment record
    const paymentRes = await db.query(
      `SELECT id, user_id, type, amount, status, mtn_transaction_id, external_id, created_at, updated_at 
       FROM payments WHERE mtn_transaction_id = $1`,
      [transactionId]
    );

    if (!paymentRes.rowCount) {
      return sendError(res, 404, 'Payment not found');
    }

    const payment = paymentRes.rows[0];

    // Only user or admin can view
    if (payment.user_id !== userId && !req.user.isAdmin) {
      return sendError(res, 403, 'Unauthorized');
    }

    // Poll MTN API for latest status
    const mtnStatus = await mtnPayments.getTransactionStatus(transactionId, payment.type === 'deposit' ? 'collections' : 'disbursements');

    logger.info('payments.status.checked', { transactionId, status: mtnStatus.status });

    return res.json({
      ok: true,
      paymentId: payment.id,
      type: payment.type,
      amount: payment.amount,
      status: mtnStatus.status,
      mtnStatus: mtnStatus,
      createdAt: payment.created_at,
      updatedAt: payment.updated_at
    });
  } catch (err) {
    logger.error('payments.status.error', { transactionId, userId, message: err.message });
    return sendError(res, 500, 'Failed to check payment status', err.message);
  }
}));

/**
 * GET /api/payments/history?limit=20&offset=0
 * Get user's transaction history
 */
router.get('/history', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const historyRes = await db.query(
      `SELECT id, type, amount, phone, status, mtn_transaction_id, created_at, updated_at 
       FROM payments WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return res.json({
      ok: true,
      transactions: historyRes.rows || [],
      count: historyRes.rowCount,
      limit,
      offset
    });
  } catch (err) {
    logger.error('payments.history.error', { userId, message: err.message });
    return sendError(res, 500, 'Failed to fetch payment history');
  }
}));

/**
 * GET /api/payments/details/:paymentId
 * Get payment details
 */
router.get('/details/:paymentId', wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const paymentId = req.params.paymentId;

  try {
    const result = await db.query(
      `SELECT id, user_id, type, amount, status, mtn_transaction_id, mtn_status, created_at, updated_at
       FROM payments WHERE id = $1 AND user_id = $2`,
      [paymentId, req.user.id]
    );

    if (!result.rowCount) {
      return sendError(res, 404, 'Payment not found');
    }

    return res.json({ ok: true, payment: result.rows[0] });
  } catch (err) {
    logger.error('payments.details.error', { paymentId, message: err.message });
    return sendError(res, 500, 'Failed to fetch payment details');
  }
}));

/**
 * POST /api/payments/callback
 * MTN webhook callback (called by MTN when payment status changes)
 * ⚠️ This endpoint is public (no auth required) because MTN sends webhook
 */
router.post('/callback', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const payload = req.body || {};

  logger.info('payments.callback.received', { payload: JSON.stringify(payload).slice(0, 200) });

  try {
    // Extract key fields
    const mtnTransactionId = payload.referenceId || payload.transactionId;
    const externalId = payload.externalId;
    const mtnStatus = (payload.status || 'UNKNOWN').toUpperCase();

    if (!mtnTransactionId) {
      logger.warn('payments.callback.no_reference_id', { payload });
      return res.status(400).json({ error: 'Missing referenceId' });
    }

    // Find payment in DB
    const paymentRes = await db.query(
      `SELECT id, user_id, type, amount, status FROM payments WHERE mtn_transaction_id = $1`,
      [mtnTransactionId]
    );

    if (!paymentRes.rowCount) {
      logger.warn('payments.callback.payment_not_found', { mtnTransactionId });
      // Still return 200 to acknowledge (MTN may retry if we return error)
      return res.json({ ok: true, message: 'Payment not found but acknowledged' });
    }

    const payment = paymentRes.rows[0];
    const userId = payment.user_id;

    // Map MTN status to our status
    let ourStatus = 'pending';
    if (mtnStatus === 'SUCCESSFUL') ourStatus = 'completed';
    else if (mtnStatus === 'FAILED') ourStatus = 'failed';
    else if (mtnStatus === 'EXPIRED') ourStatus = 'expired';

    // Update payment record
    await db.query(
      `UPDATE payments SET status = $1, mtn_status = $2, updated_at = NOW() 
       WHERE mtn_transaction_id = $3`,
      [ourStatus, mtnStatus, mtnTransactionId]
    );

    // If deposit succeeded: credit user balance
    if (payment.type === 'deposit' && ourStatus === 'completed') {
      await db.query(
        `UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [payment.amount, userId]
      );
      logger.info('payments.callback.deposit_completed', { mtnTransactionId, userId, amount: payment.amount });
    }

    // If withdrawal failed: refund user balance
    if (payment.type === 'withdraw' && ourStatus === 'failed') {
      await db.query(
        `UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
        [payment.amount, userId]
      );
      logger.info('payments.callback.withdrawal_failed_refunded', { mtnTransactionId, userId, amount: payment.amount });
    }

    // Log callback
    logger.info('payments.callback.processed', { mtnTransactionId, type: payment.type, status: ourStatus });

    // Return 200 to confirm receipt
    return res.json({ ok: true, message: 'Callback processed' });
  } catch (err) {
    logger.error('payments.callback.error', { message: err.message, payload: JSON.stringify(payload).slice(0, 200) });
    // Return 500 so MTN knows to retry, but log it
    return sendError(res, 500, 'Callback processing failed');
  }
}));

module.exports = router;
