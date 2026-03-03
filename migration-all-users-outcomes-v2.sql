-- ==================== ALL USERS OUTCOMES TRACKING MIGRATION ====================
-- Applies predetermined crash points to ALL players (not just new users)
-- Schema: Adds tracking columns to users table + audit log

-- ==================== ADD NEW COLUMNS TO USERS TABLE ====================
ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played_today_reset_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_game_outcome TEXT; -- 'win' or 'loss' for alternating sequence
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_games_played INTEGER NOT NULL DEFAULT 0;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_games_played_today ON users (games_played_today);
CREATE INDEX IF NOT EXISTS idx_users_games_played_today_reset_at ON users (games_played_today_reset_at);

-- ==================== RENAME EXISTING TABLE (if migrating from new-user-only) ====================
-- Drop old table if exists (optional, only if you had the old table)
-- DROP TABLE IF EXISTS new_user_outcome_audit CASCADE;

-- ==================== CREATE OUTCOME AUDIT LOG TABLE FOR ALL USERS ====================
-- Tracks all predetermined outcomes (for transparency & debugging)
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
);

CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_user_id ON player_outcome_audit (user_id);
CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_round_id ON player_outcome_audit (round_id);
CREATE INDEX IF NOT EXISTS idx_player_outcome_audit_created_at ON player_outcome_audit (created_at DESC);

-- ==================== MIGRATION COMPLETE ====================
-- All users now have:
-- - games_played_today counter (resets daily at 00:00 UTC)
-- - last_game_outcome tracking (for alternating pattern)
-- - Predetermined outcomes: Lose, Lose, Win, Lose, Win, Lose...
-- - Crash points: 1.00x, 1.37x, then random (1.50-4.56 for win, 1.00-1.37 for loss)
