-- Add settlement tracking to bets table
ALTER TABLE bets ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS bet_placed_at TIMESTAMPTZ DEFAULT NOW();

-- Add index for faster claimed lookups
CREATE INDEX IF NOT EXISTS idx_bets_claimed_at ON bets (claimed_at DESC);

-- Add settlement window to rounds (in seconds from crash)
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS settlement_window_seconds INTEGER DEFAULT 300;

-- Ensure rounds tracks when settlement closes
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS settlement_closed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_rounds_settlement_closed_at ON rounds (settlement_closed_at);
