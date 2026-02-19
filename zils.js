'use strict';

const https = require('https');
const logger = require('./logger');
const crypto = require('crypto');

/**
 * ZILS LOGISTICS PAYMENT GATEWAY
 * Handles deposits (collections) and withdrawals (disbursements)
 * 
 * TOKEN LOCATION: Both Headers AND Body (per Zils requirement)
 */

const ZILS_COLLECTIONS_URL = process.env.ZILS_COLLECTIONS_URL || 'https://collections.zilslogistics.com/api/v1/wallets/external';
const ZILS_DISBURSEMENTS_URL = process.env.ZILS_DISBURSEMENTS_URL || 'https://disbursements.zilslogistics.com/api/v1/wallets/external';
const ZILS_API_TOKEN = process.env.ZILS_API_TOKEN;
const ZILS_MERCHANT_PHONE = process.env.ZILS_MERCHANT_PHONE || '0761948460';

if (!ZILS_API_TOKEN) {
  logger.error('zils.initialization_failed', { message: 'ZILS_API_TOKEN not set in environment' });
}

logger.info('zils.initialized', { 
  collectionsUrl: ZILS_COLLECTIONS_URL,
  disbursementsUrl: ZILS_DISBURSEMENTS_URL,
  merchantPhone: ZILS_MERCHANT_PHONE,
  tokenLocation: 'BOTH Headers AND Body'  // ← NEW
});

/**
 * Make HTTPS request to Zils API
 * @param {string} method - HTTP method (GET, POST)
 * @param {string} fullUrl - Complete URL (no path appending)
 * @param {object} headers - Additional headers
 * @param {object} body - Request body
 */
function httpsRequest(method, fullUrl, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(fullUrl);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ZILS_API_TOKEN}`,  // ← Token in headers
          ...headers
        },
        timeout: 30000
      };

      logger.info('zils.httpsRequest.start', { method, url: fullUrl });

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            logger.info('zils.httpsRequest.success', { method, statusCode: res.statusCode, url: fullUrl });
            resolve({ status: res.statusCode, headers: res.headers, body: json });
          } catch (e) {
            logger.warn('zils.httpsRequest.parse_error', { message: e.message, data });
            resolve({ status: res.statusCode, headers: res.headers, body: data });
          }
        });
      });

      req.on('error', (err) => {
        logger.error('zils.httpsRequest.error', { method, url: fullUrl, message: err.message });
        reject(err);
      });

      req.on('timeout', () => {
        req.abort();
        logger.error('zils.httpsRequest.timeout', { method, url: fullUrl });
        reject(new Error('Zils API request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    } catch (err) {
      logger.error('zils.httpsRequest.exception', { method, fullUrl, message: err.message });
      reject(err);
    }
  });
}

/**
 * DEPOSIT - Customer sends money to merchant
 * Flow: Customer Phone → Merchant Phone
 * 
 * @param {string} customerPhone - Customer's phone number (e.g., "0768031801")
 * @param {number} amount - Amount to deposit (integer, e.g., 100 for K100)
 * @param {string} transactionUUID - Transaction UUID (generated per request)
 * @returns {object} { transactionId, status, amount }
 */
async function deposit(customerPhone, amount, transactionUUID) {
  try {
    if (!customerPhone || !amount || !transactionUUID) {
      throw new Error('Missing required parameters: customerPhone, amount, transactionUUID');
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    // Normalize phone (remove + if present)
    const normalizedPhone = String(customerPhone).replace('+', '').trim();

    const requestBody = {
      amount: numAmount,
      sender: normalizedPhone,  // Customer sends money
      receiver: ZILS_MERCHANT_PHONE,  // To merchant account
      uuid: transactionUUID,  // ← NEW: Use transaction UUID (not permanent)
      token: ZILS_API_TOKEN,  // ← NEW: Token in body as well
      description: `FlyZed Deposit - ${transactionUUID}`
    };

    logger.info('zils.deposit.start', { 
      customerPhone: normalizedPhone, 
      amount: numAmount, 
      transactionUUID,
      tokenInBody: true  // ← NEW: Log that token is in body
    });

    // ✅ Use complete URL from environment
    const response = await httpsRequest(
      'POST',
      ZILS_COLLECTIONS_URL,
      {},
      requestBody  // ← Body now includes token
    );

    if (response.status >= 200 && response.status < 300) {
      logger.info('zils.deposit.success', { 
        transactionUUID, 
        customerPhone: normalizedPhone, 
        amount: numAmount,
        responseBody: response.body
      });
      
      return {
        transactionId: response.body.txnId || transactionUUID,  // ← Use Zils txnId if provided
        status: 'pending',
        amount: numAmount,
        customerPhone: normalizedPhone,
        createdAt: new Date().toISOString(),
        apiResponse: response.body
      };
    } else {
      logger.error('zils.deposit.failed', { 
        status: response.status, 
        body: response.body, 
        customerPhone: normalizedPhone,
        transactionUUID
      });
      throw new Error(`Zils API error: ${response.status} - ${JSON.stringify(response.body)}`);
    }
  } catch (err) {
    logger.error('zils.deposit.error', { 
      message: err.message, 
      customerPhone: customerPhone,
      amount: amount,
      transactionUUID: transactionUUID
    });
    throw err;
  }
}

/**
 * WITHDRAWAL - Send money via ZILS Disbursement API
 * Uses the NEW endpoint you provided
 * 
 * @param {string} customerPhone - Customer's phone number (e.g., "0768031801")
 * @param {number} amount - Amount to withdraw (e.g., 100 for K100)
 * @param {string} transactionUUID - Transaction UUID
 * @returns {object} { transactionId, status, amount }
 */
async function withdrawal(customerPhone, amount, transactionUUID) {
  try {
    if (!customerPhone || !amount || !transactionUUID) {
      throw new Error('Missing required parameters: customerPhone, amount, transactionUUID');
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error('Amount must be a positive number');
    }

    // Normalize phone
    const normalizedPhone = String(customerPhone).replace('+', '').trim();

    // ✅ NEW DISBURSEMENT API PAYLOAD (per your ZILS spec)
    const requestBody = {
      receiver: normalizedPhone,     // Customer phone
      amount: numAmount,             // K amount
      uuid: transactionUUID,         // Unique transaction ID
      token: ZILS_API_TOKEN          // Your API token
    };

    logger.info('zils.withdrawal.start', { 
      customerPhone: normalizedPhone, 
      amount: numAmount, 
      transactionUUID,
      endpoint: 'https://disbursements.zilslogistics.com/api/v1/wallets/external'
    });

    // ✅ Call NEW disbursement endpoint
    const response = await httpsRequest(
      'POST',
      'https://disbursements.zilslogistics.com/api/v1/wallets/external',
      {},
      requestBody
    );

    if (response.status >= 200 && response.status < 300) {
      logger.info('zils.withdrawal.success', { 
        transactionUUID, 
        customerPhone: normalizedPhone, 
        amount: numAmount,
        responseBody: response.body
      });
      
      return {
        transactionId: response.body.txnId || transactionUUID,
        status: 'pending',  // ZILS will confirm via callback/polling
        amount: numAmount,
        customerPhone: normalizedPhone,
        createdAt: new Date().toISOString(),
        apiResponse: response.body
      };
    } else {
      logger.error('zils.withdrawal.failed', { 
        status: response.status, 
        body: response.body, 
        customerPhone: normalizedPhone,
        transactionUUID
      });
      throw new Error(`ZILS API error: ${response.status} - ${JSON.stringify(response.body)}`);
    }
  } catch (err) {
    logger.error('zils.withdrawal.error', { 
      message: err.message, 
      customerPhone,
      amount,
      transactionUUID
    });
    throw err;
  }
}

/**
 * CHECK TRANSACTION STATUS
 * Query Zils to check if payment was successful
 * 
 * @param {string} transactionId - The transaction ID to check
 * @returns {object} { status, transactionId, details }
 */
async function checkTransactionStatus(transactionId) {
  try {
    if (!transactionId) {
      throw new Error('Transaction ID required');
    }

    logger.info('zils.checkStatus.start', { transactionId });

    // ✅ Query on collections endpoint with transaction ID
    const statusUrl = `${ZILS_COLLECTIONS_URL}/${transactionId}`;

    const requestBody = {
      token: ZILS_API_TOKEN  // ← NEW: Token in body for status check
    };

    const response = await httpsRequest(
      'GET',
      statusUrl,
      {},
      requestBody  // ← Include token in body
    );

    if (response.status >= 200 && response.status < 300) {
      const body = response.body;
      
      logger.info('zils.checkStatus.success', { 
        transactionId, 
        status: body.status || body.statusCode 
      });

      return {
        transactionId,
        status: (body.status || body.statusCode || 'unknown').toUpperCase(),
        details: body,
        timestamp: new Date().toISOString()
      };
    } else {
      logger.error('zils.checkStatus.failed', { 
        status: response.status, 
        body: response.body, 
        transactionId 
      });
      throw new Error(`Failed to check transaction status: ${response.status}`);
    }
  } catch (err) {
    logger.error('zils.checkStatus.error', { 
      message: err.message, 
      transactionId 
    });
    throw err;
  }
}

module.exports = {
  deposit,
  withdrawal,
  checkTransactionStatus,
  ZILS_MERCHANT_PHONE
};
