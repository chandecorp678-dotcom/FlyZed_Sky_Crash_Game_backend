// dbHelper.js - small helper to run transactions safely //
const logger = require('./logger');

async function runTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      logger.warn('dbHelper.rollback_failed', { message: rbErr && rbErr.message ? rbErr.message : String(rbErr) });
    }
    throw err;
  } finally {
    try { client.release(); } catch (e) { /* swallow */ }
  }
}

module.exports = {
  runTransaction
};
