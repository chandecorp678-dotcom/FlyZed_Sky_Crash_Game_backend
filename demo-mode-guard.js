'use strict';

const { ensureDemoSchema } = require('./demo-mode');
const gameEngine = require('./gameEngine');

/**
 * Guard the legacy real-money endpoints from accidentally processing a demo request
 * or selecting a demo bet for real-money cashout.
 */
async function guardRealMoneyGameMode(req, res, next) {
  if (req.method !== 'POST' || !['/start', '/cashout'].includes(req.path)) return next();
  const requestedMode = String(req.body?.mode || 'REAL').toUpperCase();
  if (requestedMode === 'DEMO') {
    return res.status(400).json({ error: 'Use the dedicated /api/demo endpoints for demo gameplay.' });
  }
  if (requestedMode !== 'REAL') return res.status(400).json({ error: 'Unsupported game mode.' });
  if (!req.user?.id) return next();
  try {
    const db = req.app.locals.db;
    await ensureDemoSchema(db);
    const status = gameEngine.getRoundStatus();
    if (!status?.roundId) return next();
    const activeDemoBet = await db.query(
      `SELECT id FROM demo_bets WHERE user_id = $1 AND round_id = $2 AND status = 'active' LIMIT 1`,
      [req.user.id, status.roundId]
    );
    if (activeDemoBet.rowCount) {
      return res.status(409).json({ error: 'You have an active demo bet in this shared round. Finish it before using real-money gameplay.' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = guardRealMoneyGameMode;
