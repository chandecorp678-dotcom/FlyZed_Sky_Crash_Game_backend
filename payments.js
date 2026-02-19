'use strict';

const express = require('express');
const router = express.Router();
const logger = require('./logger');
const { sendError, wrapAsync } = require('./apiResponses');
const zils = require('./zils');
const { runTransaction } = require('./dbHelper');

/**
 * PAYMENTS ROUTES - ZILS LOGISTICS INTEGRATION
 * POST /api/payments/deposit - User initiates deposit
 * POST /api/payments/withdraw - User initiates withdrawal
 * GET /api/payments/status/:transactionId - Check payment status
 * GET /api/payments/history - User's transaction history
 */

const DEPOSIT_MIN = Number(process.env.PAYMENT_MIN_AMOUNT || 0.5);
const DEPOSIT_MAX = Number(process.env.PAYMENT_MAX_AMOUNT || 500000);
const WITHDRAWAL_MIN = Number(process.env.PAYMENT_MIN_AMOUNT || 5);
const WITHDRAWAL_MAX = Number(process.env.PAYMENT_MAX_AMOUNT || 5000);

/**
 * Auth middleware: require logged-in user
 */
async function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) {
    return sendError(res, 401, 'Authentication required');
  }
  next();
}

// Apply auth to all payment routes
router.use(requireAuth);

/**
 * POST /api/payments/deposit
 * User initiates a deposit via Zils Logistics
 * Body: { amount, transactionUUID }
 */
router.post('/deposit', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  
  let { amount, transactionUUID } = req.body || {};
  amount = Number(amount);

  // ✅ NEW: Validate that UUID was provided
  if (!transactionUUID) {
    return sendError(res, 400, 'Transaction UUID required');
  }

  // Validate amount first
  if (isNaN(amount) || amount < DEPOSIT_MIN || amount > DEPOSIT_MAX) {
    return sendError(res, 400, `Deposit amount must be between K${DEPOSIT_MIN} and K${DEPOSIT_MAX}`);
  }

  try {
    // ✅ FIX: Fetch fresh user data from DB to ensure zils_uuid is loaded
    const userRes = await db.query(
      `SELECT id, phone, zils_uuid FROM users WHERE id = $1`,
      [userId]
    );

    if (!userRes.rowCount) {
      return sendError(res, 404, 'User not found');
    }

    const userPhone = userRes.rows[0].phone;
    const userZilsUuid = userRes.rows[0].zils_uuid;

    // ✅ DEBUG: Log what we retrieved
    console.log('📤 /deposit - Fresh user from DB:', {
      userId,
      userPhone,
      userZilsUuid,
      transactionUUID,  // ← NEW: Log the transaction UUID
      row: userRes.rows[0]
    });

    // Validate phone
    if (!userPhone) {
      return sendError(res, 400, 'Phone number not found on account');
    }

    // Validate Zils UUID
    if (!userZilsUuid) {
      logger.error('payments.deposit.no_zils_uuid', { userId, userPhone });
      return sendError(res, 400, 'Zils UUID not found on account. Please logout and login again.');
    }

    const result = await runTransaction(db, async (client) => {
      // Check if user already has pending deposit
      const existingDeposit = await client.query(
        `SELECT id FROM payments 
         WHERE user_id = $1 AND type = 'deposit' 
         AND status IN ('pending', 'processing') 
         AND created_at > NOW() - INTERVAL '5 minutes'`,
        [userId]
      );

      if (existingDeposit.rowCount > 0) {
        const err = new Error('You have a pending deposit. Please wait before requesting another.');
        err.status = 409;
        throw err;
      }

      // ✅ NEW: Pass transactionUUID to Zils (instead of generating new one)
      const zilsResponse = await zils.deposit(userPhone, amount, transactionUUID);

      // Store payment record in DB
      const paymentId = require('crypto').randomUUID();
      const now = new Date().toISOString();

      await client.query(
        `INSERT INTO payments (id, user_id, type, amount, phone, mtn_transaction_id, external_id, status, mtn_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          paymentId, 
          userId, 
          'deposit', 
          amount, 
          userPhone, 
          zilsResponse.transactionId,
          transactionUUID,  // ← NEW: Store the transaction UUID as external_id
          'pending',
          'PENDING',
          now, 
          now
        ]
      );

      logger.info('payments.deposit.initiated', { 
        paymentId, 
        userId, 
        amount, 
        phone: userPhone, 
        zilsTransactionId: zilsResponse.transactionId,
        transactionUUID  // ← NEW: Log the UUID
      });

      return { 
        paymentId, 
        transactionId: zilsResponse.transactionId, 
        status: 'pending',
        amount,
        transactionUUID  // ← NEW: Return to frontend
      };
    });

    return res.status(202).json({
      ok: true,
      message: 'Deposit request sent to Zils Logistics. Please check your phone for confirmation.',
      paymentId: result.paymentId,
      transactionId: result.transactionId,
      transactionUUID: result.transactionUUID,  // ← NEW: Return UUID
      amount,
      status: result.status
    });
  } catch (err) {
    if (err.status === 409) return sendError(res, err.status, err.message);
    logger.error('payments.deposit.error', { userId, amount, transactionUUID, message: err.message });
    return sendError(res, 500, 'Failed to initiate deposit', err.message);
  }
}));

/**
 * POST /api/payments/withdraw
 * User initiates a withdrawal via Zils Logistics
 * Body: { amount, transactionUUID }
 */
router.post('/withdraw', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  
  let { amount, transactionUUID } = req.body || {};
  amount = Number(amount);

  // ✅ NEW: Validate that UUID was provided
  if (!transactionUUID) {
    return sendError(res, 400, 'Transaction UUID required');
  }

  // Validate amount
  if (isNaN(amount) || amount < WITHDRAWAL_MIN || amount > WITHDRAWAL_MAX) {
    return sendError(res, 400, `Withdrawal amount must be between K${WITHDRAWAL_MIN} and K${WITHDRAWAL_MAX}`);
  }

  try {
    // ✅ FIX: Fetch fresh user data from DB to ensure zils_uuid is loaded
    const userRes = await db.query(
      `SELECT id, phone, zils_uuid, balance FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (!userRes.rowCount) {
      return sendError(res, 404, 'User not found');
    }

    const userPhone = userRes.rows[0].phone;
    const userZilsUuid = userRes.rows[0].zils_uuid;
    const currentBalance = Number(userRes.rows[0].balance || 0);

    // ✅ DEBUG: Log what we retrieved
    console.log('📤 /withdraw - Fresh user from DB:', {
      userId,
      userPhone,
      userZilsUuid,
      transactionUUID,  // ← NEW: Log the transaction UUID
      balance: currentBalance,
      row: userRes.rows[0]
    });

    // Validate phone
    if (!userPhone) {
      return sendError(res, 400, 'Phone number not found on account');
    }

    // Validate Zils UUID
    if (!userZilsUuid) {
      logger.error('payments.withdraw.no_zils_uuid', { userId, userPhone });
      return sendError(res, 400, 'Zils UUID not found on account. Please logout and login again.');
    }

    // Check balance
    if (currentBalance < amount) {
      return sendError(res, 402, `Insufficient balance. You have K ${currentBalance.toFixed(2)}, but requested K ${amount.toFixed(2)}`);
    }

    const result = await runTransaction(db, async (client) => {
      // Check pending withdrawals
      const pendingWithdraw = await client.query(
        `SELECT id FROM payments 
         WHERE user_id = $1 AND type = 'withdraw' 
         AND status IN ('pending', 'processing') 
         AND created_at > NOW() - INTERVAL '5 minutes'`,
        [userId]
      );

      if (pendingWithdraw.rowCount > 0) {
        const err = new Error('You have a pending withdrawal. Please wait before requesting another.');
        err.status = 409;
        throw err;
      }

      // Deduct balance (optimistic: will refund if Zils fails)
      await client.query(
        `UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2`,
        [amount, userId]
      );

      // ✅ NEW: Pass transactionUUID to Zils (instead of generating new one)
      const zilsResponse = await zils.withdrawal(userPhone, amount, transactionUUID);

      // Store payment record
      const paymentId = require('crypto').randomUUID();
      const now = new Date().toISOString();

      await client.query(
        `INSERT INTO payments (id, user_id, type, amount, phone, mtn_transaction_id, external_id, status, mtn_status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          paymentId, 
          userId, 
          'withdraw', 
          amount, 
          userPhone, 
          zilsResponse.transactionId,
          transactionUUID,  // ← NEW: Store the transaction UUID as external_id
          'processing',
          'PROCESSING',
          now, 
          now
        ]
      );

      logger.info('payments.withdraw.initiated', { 
        paymentId, 
        userId, 
        amount, 
        phone: userPhone, 
        zilsTransactionId: zilsResponse.transactionId,
        transactionUUID  // ← NEW: Log the UUID
      });

      return { 
        paymentId, 
        transactionId: zilsResponse.transactionId, 
        status: 'processing', 
        newBalance: currentBalance - amount,
        amount,
        transactionUUID  // ← NEW: Return to frontend
      };
    });

    return res.status(202).json({
      ok: true,
      message: 'Withdrawal initiated. Money will arrive shortly.',
      paymentId: result.paymentId,
      transactionId: result.transactionId,
      transactionUUID: result.transactionUUID,  // ← NEW: Return UUID
      amount,
      status: result.status,
      newBalance: result.newBalance
    });
  } catch (err) {
    if (err.status === 402) return sendError(res, err.status, err.message);
    if (err.status === 409) return sendError(res, err.status, err.message);
    if (err.status === 404) return sendError(res, err.status, err.message);
    logger.error('payments.withdraw.error', { userId, amount, transactionUUID, message: err.message });
    return sendError(res, 500, 'Failed to initiate withdrawal', err.message);
  }
}));

/**
 * GET /api/payments/status/:transactionId
 * Check status of a transaction by UUID or Transaction ID
 */
router.get('/status/:transactionId', requireAuth, wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  const { transactionId } = req.params;

  if (!transactionId) {
    return sendError(res, 400, 'Transaction ID required');
  }

  try {
    console.log('Checking status for:', transactionId);

    // Find by UUID (external_id) or payment ID
    const paymentRes = await db.query(
      `SELECT 
        id,
        user_id,
        type,
        amount,
        phone,
        mtn_transaction_id,
        external_id,
        status,
        mtn_status,
        created_at,
        updated_at
       FROM payments 
       WHERE external_id = $1 OR id = $1 OR mtn_transaction_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [transactionId]
    );

    if (!paymentRes.rowCount) {
      return sendError(res, 404, 'Transaction not found');
    }

    const payment = paymentRes.rows[0];

    logger.info('payments.status.check', {
      transactionId,
      paymentId: payment.id,
      status: payment.status
    });

    return res.json({
      ok: true,
      transactionId: payment.id,
      type: payment.type,
      amount: payment.amount,
      phone: payment.phone,
      status: payment.status,
      mtnStatus: payment.mtn_status,
      mtnTransactionId: payment.mtn_transaction_id,
      uuid: payment.external_id,
      createdAt: payment.created_at,
      updatedAt: payment.updated_at,
      message: `Transaction status: ${payment.status.toUpperCase()}`
    });

  } catch (err) {
    logger.error('payments.status.error', { transactionId, message: err.message });
    return sendError(res, 500, 'Failed to check transaction status', err.message);
  }
}));

/**
 * GET /api/payments/status/:transactionId
 * Check status of a payment
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
      `SELECT id, user_id, type, amount, status, mtn_transaction_id, mtn_status, created_at, updated_at 
       FROM payments WHERE mtn_transaction_id = $1`,
      [transactionId]
    );

    if (!paymentRes.rowCount) {
      return sendError(res, 404, 'Payment not found');
    }

    const payment = paymentRes.rows[0];

    // Only user can view their own payment
    if (payment.user_id !== userId) {
      return sendError(res, 403, 'Unauthorized');
    }

    // Poll Zils API for latest status
    const zilsStatus = await zils.checkTransactionStatus(transactionId);

    logger.info('payments.status.checked', { transactionId, status: zilsStatus.status });

    return res.json({
      ok: true,
      paymentId: payment.id,
      type: payment.type,
      amount: payment.amount,
      status: zilsStatus.status,
      details: zilsStatus.details,
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
      `SELECT id, type, amount, phone, status, mtn_transaction_id, mtn_status, created_at, updated_at 
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
 * =================== ZILS WEBHOOK CALLBACK ===================
 * POST /api/payments/zils-webhook
 * ZILS calls this endpoint when a deposit/withdrawal is confirmed
 * This is where we credit the user's account balance on success
 */
router.post('/zils-webhook', express.json(), wrapAsync(async (req, res) => {
  const db = req.app.locals.db;
  
  // Parse ZILS callback payload
  const { txnId, uuid, status, amount } = req.body;

  logger.info('payments.zils_webhook.received', { 
    txnId, 
    uuid, 
    status, 
    amount,
    fullPayload: req.body
  });

  if (!txnId && !uuid) {
    logger.warn('payments.zils_webhook.missing_txn_id', { body: req.body });
    return res.status(400).json({ ok: false, error: 'Missing txnId or uuid from ZILS' });
  }

  try {
    // 1. Find the payment record by transaction ID or UUID
    const paymentRes = await db.query(
      `SELECT id, user_id, amount, type, status FROM payments 
       WHERE mtn_transaction_id = $1 OR external_id = $1 OR mtn_transaction_id = $2 OR external_id = $2
       LIMIT 1`,
      [txnId || '', uuid || '']
    );

    if (!paymentRes.rowCount) {
      logger.warn('payments.zils_webhook.payment_not_found', { txnId, uuid });
      return res.status(404).json({ ok: false, error: 'Payment not found' });
    }

    const payment = paymentRes.rows[0];

    // 2. Check if already processed (idempotency - don't double-credit)
    if (['confirmed', 'completed', 'failed', 'expired'].includes(payment.status)) {
      logger.info('payments.zils_webhook.already_processed', { 
        paymentId: payment.id, 
        currentStatus: payment.status 
      });
      return res.json({ 
        ok: true, 
        message: 'Payment already processed', 
        status: payment.status 
      });
    }

    // 3. Determine new status based on ZILS response
    let newStatus = 'pending';
    const statusUpper = (status || '').toUpperCase();

    if (statusUpper.includes('SUCCESS') || statusUpper === 'CONFIRMED' || statusUpper === 'COMPLETED' || statusUpper === 'OK') {
      newStatus = 'confirmed';
    } else if (statusUpper.includes('FAIL') || statusUpper === 'FAILED' || statusUpper === 'ERROR') {
      newStatus = 'failed';
    } else if (statusUpper === 'EXPIRED' || statusUpper.includes('TIMEOUT')) {
      newStatus = 'expired';
    }

    logger.info('payments.zils_webhook.processing', { 
      paymentId: payment.id, 
      transactionId: txnId,
      newStatus, 
      amount: payment.amount,
      paymentType: payment.type
    });

    // 4. Use transaction to ensure atomicity (all-or-nothing)
    await runTransaction(db, async (client) => {
      // Update payment status
      await client.query(
        `UPDATE payments 
         SET status = $1, mtn_status = $2, updated_at = NOW() 
         WHERE id = $3`,
        [newStatus, status, payment.id]
      );

      // **CREDIT USER BALANCE IF DEPOSIT SUCCESSFUL**
      if (payment.type === 'deposit' && newStatus === 'confirmed') {
        await client.query(
          `UPDATE users 
           SET balance = balance + $1, updatedat = NOW() 
           WHERE id = $2`,
          [payment.amount, payment.user_id]
        );

        logger.info('payments.zils_webhook.balance_credited', { 
          userId: payment.user_id, 
          amount: payment.amount,
          paymentId: payment.id,
          transactionId: txnId,
          newUserBalance: 'fetching...'
        });
      }

      // If WITHDRAWAL and CONFIRMED, balance was already deducted when initiated
      if (payment.type === 'withdraw' && newStatus === 'confirmed') {
        logger.info('payments.zils_webhook.withdrawal_confirmed', { 
          userId: payment.user_id,
          amount: payment.amount,
          paymentId: payment.id
        });
      }

      // If payment FAILED, refund the balance (for withdrawals only, since deposit hasn't been credited yet)
      if (newStatus === 'failed' && payment.type === 'withdraw') {
        await client.query(
          `UPDATE users 
           SET balance = balance + $1, updatedat = NOW() 
           WHERE id = $2`,
          [payment.amount, payment.user_id]
        );

        logger.info('payments.zils_webhook.withdrawal_refunded', { 
          userId: payment.user_id, 
          amount: payment.amount,
          paymentId: payment.id
        });
      }
    });

    // Fetch updated user balance to return in response
    const updatedUser = await db.query(
      `SELECT id, balance FROM users WHERE id = $1`,
      [payment.user_id]
    );

    const userNewBalance = updatedUser.rows[0]?.balance || 0;

    logger.info('payments.zils_webhook.success', { 
      paymentId: payment.id,
      status: newStatus,
      userId: payment.user_id,
      userNewBalance
    });

    return res.json({
      ok: true,
      message: `✅ Payment ${newStatus}. User balance updated.`,
      paymentId: payment.id,
      status: newStatus,
      userNewBalance,
      transactionId: txnId
    });

  } catch (err) {
    logger.error('payments.zils_webhook.error', { 
      message: err && err.message ? err.message : String(err),
      txnId,
      uuid,
      stack: err && err.stack ? err.stack : undefined
    });
    return res.status(500).json({ 
      ok: false, 
      error: 'Failed to process ZILS webhook',
      details: err && err.message ? err.message : 'Unknown error'
    });
  }
}));

module.exports = router;
