-- Phase 9.3 Migration: Payment transactions table

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw')),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  phone TEXT NOT NULL,
  mtn_transaction_id TEXT UNIQUE NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
  mtn_status TEXT,
  error_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_mtn_transaction_id ON payments (mtn_transaction_id);

-- Audit log table
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

-- Create update trigger for audit
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
