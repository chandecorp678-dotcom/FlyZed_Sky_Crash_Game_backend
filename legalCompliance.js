'use strict';

const logger = require('./logger');

/**
 * LEGAL COMPLIANCE SERVICE
 * - Terms & Conditions acceptance
 * - Age verification (18+)
 * - Responsible gaming messaging
 * - Demo mode management
 */

const DEMO_MODE = (process.env.DEMO_MODE || 'false').toLowerCase() === 'true';
const DEMO_STARTING_BALANCE = Number(process.env.DEMO_STARTING_BALANCE || 1000);
const DAILY_LOSS_LIMIT = Number(process.env.DAILY_LOSS_LIMIT || 10000); // Max loss per day (ZMW)

logger.info('legalCompliance.initialized', { demoMode: DEMO_MODE, demoStartingBalance: DEMO_STARTING_BALANCE, dailyLossLimit: DAILY_LOSS_LIMIT });

/**
 * Check if demo mode is active
 */
function isDemoMode() {
  return DEMO_MODE;
}

/**
 * Generate Terms & Conditions text
 * Returns HTML-formatted T&C
 */
function getTermsAndConditions() {
  return `
    <h2>Ka Ndeke – Terms & Conditions</h2>
    
    <h3>1. ACCEPTANCE OF TERMS</h3>
    <p>By using Ka Ndeke, you agree to these Terms & Conditions. If you do not agree, please do not use our service.</p>
    
    <h3>2. AGE REQUIREMENT</h3>
    <p>You must be at least 18 years old to use this service. By accepting these terms, you confirm you are 18 or older.</p>
    
    <h3>3. DEMO MODE</h3>
    <p>Ka Ndeke may operate in demo mode with virtual funds. No real money is involved in demo mode. Demo balances are not persisted and will be reset.</p>
    
    <h3>4. REAL MONEY MODE</h3>
    <p>In real-money mode, all transactions are genuine. You are responsible for your gambling decisions and financial losses.</p>
    
    <h3>5. RESPONSIBLE GAMBLING</h3>
    <p>Ka Ndeke promotes responsible gambling. Please gamble responsibly and within your means.</p>
    <ul>
      <li>Set limits on how much you spend</li>
      <li>Never gamble money you cannot afford to lose</li>
      <li>Take regular breaks</li>
      <li>Seek help if you have gambling problems</li>
    </ul>
    
    <h3>6. DAILY LOSS LIMITS</h3>
    <p>Ka Ndeke enforces daily loss limits to promote responsible gaming. You cannot lose more than ZMW ${DAILY_LOSS_LIMIT} per day.</p>
    
    <h3>7. SELF-EXCLUSION</h3>
    <p>You can self-exclude from Ka Ndeke for 7, 30, or 90 days at any time. During self-exclusion, you cannot access your account.</p>
    
    <h3>8. ACCOUNT SUSPENSION</h3>
    <p>Ka Ndeke reserves the right to suspend accounts that violate these terms or engage in suspicious activity.</p>
    
    <h3>9. PAYMENT PROCESSING</h3>
    <p>All deposits and withdrawals are processed through MTN Mobile Money. Ka Ndeke is not responsible for payment delays or failures from MTN.</p>
    
    <h3>10. DISPUTES</h3>
    <p>For disputes, contact support@kandeke.example.com with details of your claim.</p>
    
    <h3>11. LIABILITY DISCLAIMER</h3>
    <p>Ka Ndeke is provided "as is" without warranties. We are not liable for losses incurred through gambling on our platform.</p>
    
    <h3>12. CHANGES TO TERMS</h3>
    <p>Ka Ndeke may update these terms at any time. Continued use constitutes acceptance of updated terms.</p>
    
    <p><strong>Last Updated: ${new Date().toISOString().split('T')[0]}</strong></p>
  `;
}

/**
 * Accept Terms & Conditions
 */
async function acceptTermsAndConditions(db, userId) {
  try {
    const now = new Date().toISOString();

    await db.query(
      `INSERT INTO legal_compliance (user_id, terms_accepted, terms_accepted_at, age_verified, age_verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         terms_accepted = $2,
         terms_accepted_at = $3,
         updated_at = $7`,
      [userId, true, now, false, null, now, now]
    );

    logger.info('legalCompliance.termsAccepted', { userId });
    return { accepted: true, acceptedAt: now };
  } catch (err) {
    logger.error('legalCompliance.acceptTerms.error', { userId, message: err.message });
    throw err;
  }
}

/**
 * Verify age (18+)
 */
async function verifyAge(db, userId, ageConfirmed = true) {
  try {
    const now = new Date().toISOString();

    if (!ageConfirmed) {
      throw new Error('User must confirm they are 18 or older');
    }

    await db.query(
      `INSERT INTO legal_compliance (user_id, age_verified, age_verified_at, terms_accepted, terms_accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         age_verified = $2,
         age_verified_at = $3,
         updated_at = $7`,
      [userId, true, now, false, null, now, now]
    );

    logger.info('legalCompliance.ageVerified', { userId, age: '18+' });
    return { verified: true, verifiedAt: now };
  } catch (err) {
    logger.error('legalCompliance.verifyAge.error', { userId, message: err.message });
    throw err;
  }
}

/**
 * Get compliance status for user
 */
async function getComplianceStatus(db, userId) {
  try {
    const result = await db.query(
      `SELECT user_id, terms_accepted, terms_accepted_at, age_verified, age_verified_at
       FROM legal_compliance WHERE user_id = $1`,
      [userId]
    );

    if (!result.rowCount) {
      return {
        userId,
        termsAccepted: false,
        ageVerified: false,
        compliant: false
      };
    }

    const row = result.rows[0];
    return {
      userId: row.user_id,
      termsAccepted: row.terms_accepted || false,
      termsAcceptedAt: row.terms_accepted_at,
      ageVerified: row.age_verified || false,
      ageVerifiedAt: row.age_verified_at,
      compliant: (row.terms_accepted && row.age_verified)
    };
  } catch (err) {
    logger.error('legalCompliance.getComplianceStatus.error', { userId, message: err.message });
    return null;
  }
}

/**
 * Check daily loss and apply limit
 */
async function checkDailyLossLimit(db, userId) {
  try {
    const query = `
      SELECT SUM(CASE WHEN status = 'lost' THEN bet_amount ELSE 0 END) as total_losses
      FROM bets
      WHERE user_id = $1 AND DATE(createdat) = DATE(NOW())
    `;

    const result = await db.query(query, [userId]);
    const totalLosses = Number(result.rows[0]?.total_losses || 0);
    const remainingLimit = Math.max(0, DAILY_LOSS_LIMIT - totalLosses);

    return {
      userId,
      totalLossesToday: totalLosses,
      dailyLimit: DAILY_LOSS_LIMIT,
      remainingLimit,
      limitExceeded: totalLosses >= DAILY_LOSS_LIMIT
    };
  } catch (err) {
    logger.error('legalCompliance.checkDailyLossLimit.error', { userId, message: err.message });
    return null;
  }
}

/**
 * Self-exclude user
 */
async function selfExclude(db, userId, daysToExclude = 7) {
  try {
    const now = new Date();
    const excludeUntil = new Date(now.getTime() + daysToExclude * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO self_exclusion (user_id, excluded_until, reason, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         excluded_until = $2,
         created_at = $4`,
      [userId, excludeUntil.toISOString(), 'User self-excluded', now.toISOString()]
    );

    logger.warn('legalCompliance.selfExcluded', { userId, daysToExclude, excludeUntil });
    return {
      excluded: true,
      excludedUntil: excludeUntil.toISOString(),
      daysToExclude
    };
  } catch (err) {
    logger.error('legalCompliance.selfExclude.error', { userId, message: err.message });
    throw err;
  }
}

/**
 * Check if user is self-excluded
 */
async function isUserExcluded(db, userId) {
  try {
    const result = await db.query(
      `SELECT excluded_until FROM self_exclusion 
       WHERE user_id = $1 AND excluded_until > NOW()`,
      [userId]
    );

    if (!result.rowCount) {
      return { excluded: false };
    }

    const row = result.rows[0];
    return {
      excluded: true,
      excludedUntil: row.excluded_until,
      daysRemaining: Math.ceil((new Date(row.excluded_until) - Date.now()) / (24 * 60 * 60 * 1000))
    };
  } catch (err) {
    logger.error('legalCompliance.isUserExcluded.error', { userId, message: err.message });
    return null;
  }
}

/**
 * Cancel self-exclusion
 */
async function cancelSelfExclusion(db, userId) {
  try {
    await db.query(
      `DELETE FROM self_exclusion WHERE user_id = $1`,
      [userId]
    );

    logger.info('legalCompliance.selfExclusionCancelled', { userId });
    return { cancelled: true };
  } catch (err) {
    logger.error('legalCompliance.cancelSelfExclusion.error', { userId, message: err.message });
    throw err;
  }
}

module.exports = {
  isDemoMode,
  getTermsAndConditions,
  acceptTermsAndConditions,
  verifyAge,
  getComplianceStatus,
  checkDailyLossLimit,
  selfExclude,
  isUserExcluded,
  cancelSelfExclusion,
  DAILY_LOSS_LIMIT,
  DEMO_MODE,
  DEMO_STARTING_BALANCE
};
