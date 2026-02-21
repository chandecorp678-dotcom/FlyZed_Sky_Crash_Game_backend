-- migration-0-init-complete.sql
-- Complete FlyZed Database Schema with all fixes
-- This replaces all individual migration files

-- ==================== USERS TABLE ====================
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
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);
CREATE INDEX IF NOT EXISTS idx_users_zils_uuid ON users (zils_uuid);

-- ==================== ROUNDS TABLE ====================
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
);

CREATE INDEX IF NOT EXISTS idx_rounds_round_id ON rounds (round_id);
CREATE INDEX IF NOT EXISTS idx_rounds_started_at ON rounds (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_settlement_closed_at ON rounds (settlement_closed_at);

-- ==================== BETS TABLE ====================
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
);

CREATE INDEX IF NOT EXISTS idx_bets_user_id ON bets (user_id);
CREATE INDEX IF NOT EXISTS idx_bets_round_id ON bets (round_id);
CREATE INDEX IF NOT EXISTS idx_bets_createdat ON bets (createdat DESC);
CREATE INDEX IF NOT EXISTS idx_bets_claimed_at ON bets (claimed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_user_round ON bets (user_id, round_id) WHERE status = 'active';

-- ==================== SEED COMMITS TABLE ====================
CREATE TABLE IF NOT EXISTS seed_commits (
  id SERIAL PRIMARY KEY,
  idx BIGINT UNIQUE NOT NULL,
  seed_hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seed_commits_idx ON seed_commits (idx DESC);

-- ==================== PAYMENTS TABLE (WITH CONFIRMED STATUS FIX) ====================
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
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_mtn_transaction_id ON payments (mtn_transaction_id);

-- ==================== PAYMENT AUDIT TABLE ====================
CREATE TABLE IF NOT EXISTS payment_audit (
  id SERIAL PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT,
  reason TEXT,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_audit_payment_id ON payment_audit (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_audit_changed_at ON payment_audit (changed_at DESC);

-- ==================== PAYMENT AUDIT TRIGGER ====================
CREATE OR REPLACE FUNCTION payment_audit_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO payment_audit (payment_id, old_status, new_status, changed_at)
    VALUES (NEW.id, OLD.status, NEW.status, NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_status_audit ON payments;
CREATE TRIGGER payment_status_audit AFTER UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION payment_audit_trigger();

-- ==================== MONITORING SNAPSHOTS TABLE ====================
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
);

CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_created_at ON monitoring_snapshots (created_at DESC);

-- ==================== KILL SWITCH LOG TABLE ====================
CREATE TABLE IF NOT EXISTS kill_switch_log (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
  target TEXT NOT NULL CHECK (target IN ('game_rounds', 'payments', 'all')),
  reason TEXT,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kill_switch_log_activated_at ON kill_switch_log (activated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kill_switch_log_target ON kill_switch_log (target);

-- ==================== LEGAL COMPLIANCE TABLE ====================
CREATE TABLE IF NOT EXISTS legal_compliance (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  terms_accepted BOOLEAN NOT NULL DEFAULT false,
  terms_accepted_at TIMESTAMPTZ,
  terms_version VARCHAR(50) DEFAULT 'v1.0',
  age_verified BOOLEAN NOT NULL DEFAULT false,
  age_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legal_compliance_user_id ON legal_compliance (user_id);
CREATE INDEX IF NOT EXISTS idx_legal_compliance_terms_accepted ON legal_compliance (terms_accepted);
CREATE INDEX IF NOT EXISTS idx_legal_compliance_age_verified ON legal_compliance (age_verified);

-- ==================== SELF EXCLUSION TABLE ====================
CREATE TABLE IF NOT EXISTS self_exclusion (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  excluded_until TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_self_exclusion_excluded_until ON self_exclusion (excluded_until);
CREATE INDEX IF NOT EXISTS idx_self_exclusion_user_id ON self_exclusion (user_id);

-- ==================== LEGAL AUDIT LOG TABLE ====================
CREATE TABLE IF NOT EXISTS legal_audit_log (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('terms_accepted', 'age_verified', 'self_excluded', 'exclusion_cancelled', 'daily_limit_exceeded')),
  details JSONB DEFAULT '{}',
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legal_audit_log_user_id ON legal_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_legal_audit_log_action ON legal_audit_log (action);
CREATE INDEX IF NOT EXISTS idx_legal_audit_log_created_at ON legal_audit_log (created_at DESC);

-- ==================== MIGRATION COMPLETE ====================
-- This migration file includes:
-- ✅ All tables (users, rounds, bets, seed_commits, payments, monitoring_snapshots, kill_switch_log, legal_compliance, self_exclusion, legal_audit_log)
-- ✅ All indexes for performance
-- ✅ Payment status constraint now includes 'confirmed' status
-- ✅ Payment audit trigger for tracking status changes
-- ✅ All foreign key relationships and constraints
