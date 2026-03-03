-- ==================== NEW USER OUTCOMES TRACKING MIGRATION V2 ====================
-- Implements: Daily reset system with realistic predetermined crash points
-- Schema: Adds tracking columns to users table + audit log for transparency

-- ==================== ADD NEW COLUMNS TO USERS TABLE ====================
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_new_user BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played_today_reset_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_game_outcome TEXT; -- 'win' or 'loss' for alternating sequence
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_games_played INTEGER NOT NULL DEFAULT 0;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_is_new_user ON users (is_new_user);
CREATE INDEX IF NOT EXISTS idx_users_games_played_today ON users (games_played_today);
CREATE INDEX IF NOT EXISTS idx_users_games_played_today_reset_at ON users (games_played_today_reset_at);

-- ==================== CREATE OUTCOME AUDIT LOG TABLE ====================
-- Tracks when outcomes are predetermined (for transparency & debugging)
CREATE TABLE IF NOT EXISTS new_user_outcome_audit (
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
);

CREATE INDEX IF NOT EXISTS idx_new_user_outcome_audit_user_id ON new_user_outcome_audit (user_id);
CREATE INDEX IF NOT EXISTS idx_new_user_outcome_audit_round_id ON new_user_outcome_audit (round_id);
CREATE INDEX IF NOT EXISTS idx_new_user_outcome_audit_created_at ON new_user_outcome_audit (created_at DESC);

-- ==================== MIGRATION COMPLETE ====================
-- V2 Changes:
-- - Game 1: Force crash at 1.00x
-- - Game 2: Force crash at 1.37x
-- - Game 3+: Win rounds crash randomly between 1.50x - 4.56x
-- - Game 3+: Loss rounds crash randomly between 1.00x - 1.37x
