-- === Admins (for admin panel login)
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed one admin if missing (change later)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admins WHERE lower(email)=lower('admin@mastermind-bet.com')) THEN
    INSERT INTO admins(email, password_hash)
    VALUES ('admin@mastermind-bet.com', '$2a$10$ZyY5/5m1nHFdR8i8bD8GouR1wzQz5m8gTqEYi7wT8z2yJqoJr2WnW'); -- 'ChangeMe!234'
  END IF;
END$$;

-- === Agents: keep your table, but ensure columns we need exist
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS float_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- one-time backfill: if balance_cents already exists use it as float
UPDATE agents SET float_cents = balance_cents WHERE balance_cents IS NOT NULL;

-- === Cashiers
CREATE TABLE IF NOT EXISTS cashiers (
  id SERIAL PRIMARY KEY,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  float_cents INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- === Float ledger (auditable movements)
CREATE TABLE IF NOT EXISTS float_ledger (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_role TEXT NOT NULL,           -- 'admin' | 'agent'
  actor_id BIGINT NOT NULL,
  from_entity TEXT NOT NULL,          -- 'treasury' | 'agent' | 'cashier'
  to_entity TEXT NOT NULL,            -- 'agent' | 'cashier' | 'treasury'
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  action TEXT NOT NULL,               -- 'MINT' | 'TOPUP' | 'WITHDRAW'
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_float_ledger_ts ON float_ledger(ts DESC);

-- === Tickets: make sure agent_code exists for linking to agent code strings (already present in your schema)
-- (No change here; just confirming your design.)
