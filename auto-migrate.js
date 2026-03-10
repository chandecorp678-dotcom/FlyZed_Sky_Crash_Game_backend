'use strict';

/**
 * AUTO-MIGRATE SERVICE
 * Runs automatically on server startup
 * Creates all database tables if they don't exist
 */

const logger = require('./logger');

async function runAutoMigrations(db) {
  if (!db) {
    logger.warn('auto-migrate.db_not_initialized');
    return false;
  }

  try {
    logger.info('auto-migrate.starting');

    // ==================== USERS TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        username TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        balance NUMERIC(18,2) NOT NULL DEFAULT 0,
        freerounds INTEGER NOT NULL DEFAULT 0,
        zils_uuid VARCHAR(255) UNIQUE,
        createdat TIMESTAMPTZ NOT NULL,
        updatedat TIMESTAMPTZ NOT NULL
      )
    `);
    logger.info('auto-migrate.users_table_created');

    // Create indexes for users
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_zils_uuid ON users (zils_uuid)`);

    // ==================== ROUNDS TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id UUID PRIMARY KEY,
        round_id TEXT UNIQUE NOT NULL,
        crash_point NUMERIC(10,2),
        server_seed_hash TEXT,
        server_seed TEXT,
        commit_idx BIGINT,
        server_seed_revealed_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        settlement_window_seconds INTEGER DEFAULT 300,
        settlement_closed_at TIMESTAMPTZ,
        meta JSONB DEFAULT '{}'::jsonb,
        createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.rounds_table_created');

    // Create indexes for rounds
    await db.query(`CREATE INDEX IF NOT EXISTS idx_rounds_round_id ON rounds (round_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_rounds_started_at ON rounds (started_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_rounds_settlement_closed_at ON rounds (settlement_closed_at)`);

    // ==================== BETS TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id UUID PRIMARY KEY,
        round_id TEXT NOT NULL,
        user_id UUID,
        bet_amount NUMERIC(18,2) NOT NULL,
        payout NUMERIC(18,2),
        status TEXT NOT NULL DEFAULT 'active',
        bet_placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ,
        meta JSONB DEFAULT '{}'::jsonb,
        createdat TIMESTAMPTZ NOT NULL,
        updatedat TIMESTAMPTZ NOT NULL
      )
    `);
    logger.info('auto-migrate.bets_table_created');

    // Create indexes for bets
    await db.query(`CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_bets_round_id ON bets (round_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_bets_createdat ON bets (createdat DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_bets_claimed_at ON bets (claimed_at DESC)`);

    // ==================== SEED COMMITS TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS seed_commits (
        id SERIAL PRIMARY KEY,
        idx BIGINT UNIQUE NOT NULL,
        seed_hash TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.seed_commits_table_created');

    // Create index for seed_commits
    await db.query(`CREATE INDEX IF NOT EXISTS idx_seed_commits_idx ON seed_commits (idx DESC)`);

    // ==================== PAYMENTS TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw')),
        amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
        phone TEXT NOT NULL,
        mtn_transaction_id TEXT UNIQUE NOT NULL,
        external_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired', 'confirmed')),
        mtn_status TEXT,
        error_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.payments_table_created');

    // Create indexes for payments
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments (created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_mtn_transaction_id ON payments (mtn_transaction_id)`);

    // ==================== PAYMENT AUDIT TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_audit (
        id SERIAL PRIMARY KEY,
        payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        old_status TEXT,
        new_status TEXT,
        reason TEXT,
        changed_by TEXT,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.payment_audit_table_created');

    // Create indexes for payment_audit
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_audit_payment_id ON payment_audit (payment_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_audit_changed_at ON payment_audit (changed_at DESC)`);

    // ==================== MONITORING SNAPSHOTS TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS monitoring_snapshots (
        id UUID PRIMARY KEY,
        rtp NUMERIC(5, 2) NOT NULL DEFAULT 95.00,
        total_bets NUMERIC(18, 2) NOT NULL DEFAULT 0,
        total_payouts NUMERIC(18, 2) NOT NULL DEFAULT 0,
        active_rounds INTEGER NOT NULL DEFAULT 0,
        pending_payments INTEGER NOT NULL DEFAULT 0,
        user_count INTEGER NOT NULL DEFAULT 0,
        anomalies_detected INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.monitoring_snapshots_table_created');

    // Create index for monitoring_snapshots
    await db.query(`CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_created_at ON monitoring_snapshots (created_at DESC)`);

    // ==================== KILL SWITCH LOG TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS kill_switch_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
        target TEXT NOT NULL CHECK (target IN ('game_rounds', 'payments', 'all')),
        reason TEXT,
        activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.kill_switch_log_table_created');

    // Create indexes for kill_switch_log
    await db.query(`CREATE INDEX IF NOT EXISTS idx_kill_switch_log_activated_at ON kill_switch_log (activated_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_kill_switch_log_target ON kill_switch_log (target)`);

    // ==================== LEGAL COMPLIANCE TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS legal_compliance (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        terms_accepted BOOLEAN NOT NULL DEFAULT false,
        terms_accepted_at TIMESTAMPTZ,
        terms_version VARCHAR(50) DEFAULT 'v1.0',
        age_verified BOOLEAN NOT NULL DEFAULT false,
        age_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.legal_compliance_table_created');

    // Create indexes for legal_compliance
    await db.query(`CREATE INDEX IF NOT EXISTS idx_legal_compliance_user_id ON legal_compliance (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_legal_compliance_terms_accepted ON legal_compliance (terms_accepted)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_legal_compliance_age_verified ON legal_compliance (age_verified)`);

    // ==================== SELF EXCLUSION TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS self_exclusion (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        excluded_until TIMESTAMPTZ NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cancelled_at TIMESTAMPTZ
      )
    `);
    logger.info('auto-migrate.self_exclusion_table_created');

    // Create indexes for self_exclusion
    await db.query(`CREATE INDEX IF NOT EXISTS idx_self_exclusion_excluded_until ON self_exclusion (excluded_until)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_self_exclusion_user_id ON self_exclusion (user_id)`);

    // ==================== LEGAL AUDIT LOG TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS legal_audit_log (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('terms_accepted', 'age_verified', 'self_excluded', 'exclusion_cancelled', 'daily_limit_exceeded')),
        details JSONB DEFAULT '{}',
        ip_address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.legal_audit_log_table_created');

    // Create indexes for legal_audit_log
    await db.query(`CREATE INDEX IF NOT EXISTS idx_legal_audit_log_user_id ON legal_audit_log (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_legal_audit_log_action ON legal_audit_log (action)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_legal_audit_log_created_at ON legal_audit_log (created_at DESC)`);

    // ==================== PLAYER OUTCOME AUDIT TABLE ====================
    await db.query(`
      CREATE TABLE IF NOT EXISTS player_outcome_audit (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        round_id TEXT NOT NULL,
        game_number_today INTEGER NOT NULL,
        predetermined_outcome TEXT NOT NULL CHECK (predetermined_outcome IN ('win', 'loss')),
        reason TEXT NOT NULL,
        bet_amount NUMERIC(18,2),
        forced_crash_point NUMERIC(10,2),
        actual_crash_point NUMERIC(10,2),
        actual_multiplier NUMERIC(10,2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info('auto-migrate.player_outcome_audit_table_created');

    // Create indexes for player_outcome_audit
    await db.query(`CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_user_id ON player_outcome_audit (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_round_id ON player_outcome_audit (round_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_created_at ON player_outcome_audit (created_at DESC)`);

    logger.info('auto-migrate.success', { 
      message: '✅ All database tables created successfully!'
    });

    return true;
  } catch (err) {
    logger.error('auto-migrate.error', { 
      message: err.message,
      stack: err.stack
    });
    return false;
  }
}

module.exports = { runAutoMigrations };
