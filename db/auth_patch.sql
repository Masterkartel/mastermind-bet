-- db/auth_patch.sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- USERS (supports your index.js which checks pass_hash)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('admin','agent','cashier')),
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT,
  pin_hash      TEXT,
  pass_hash     TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- agents.code unique (used as phone/code)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='agents'::regclass AND conname='agents_code_unique'
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_code_unique UNIQUE (code);
  END IF;
END$$;

-- link agents -> users (owner_user_id)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_user_id INT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='agents'::regclass AND conname='agents_owner_user_fk'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_owner_user_fk
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END$$;

-- CASHIERS (by agent_code)
CREATE TABLE IF NOT EXISTS cashiers (
  id         SERIAL PRIMARY KEY,
  agent_code TEXT NOT NULL REFERENCES agents(code) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_code, name)
);

-- SESSIONS (your index.js uses this)
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','agent','cashier')),
  agent_code  TEXT,
  cashier_id  INT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- FLOAT LEDGER (simple audit)
CREATE TABLE IF NOT EXISTS float_ledger (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_role TEXT NOT NULL,           -- 'admin' | 'agent'
  actor_id   BIGINT,                  -- optional
  from_entity TEXT NOT NULL,          -- 'treasury' | 'agent' | 'cashier'
  to_entity   TEXT NOT NULL,          -- 'agent' | 'cashier' | 'treasury'
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  action TEXT NOT NULL,               -- 'MINT' | 'TOPUP' | 'WITHDRAW'
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_float_ledger_ts ON float_ledger(ts DESC);

-- helper fns (password / pin)
CREATE OR REPLACE FUNCTION set_user_password(p_user_id INT, p_password TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users
     SET password_hash = crypt(p_password, gen_salt('bf')),
         pass_hash     = crypt(p_password, gen_salt('bf')),
         pin_hash      = NULL
   WHERE id = p_user_id;
END$$;

CREATE OR REPLACE FUNCTION set_user_pin(p_user_id INT, p_pin TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'PIN must be exactly 6 digits';
  END IF;
  UPDATE users
     SET pin_hash      = crypt(p_pin, gen_salt('bf')),
         password_hash = NULL,
         pass_hash     = NULL
   WHERE id = p_user_id;
END$$;

-- seed admin compatible with your checks
INSERT INTO users(role, phone, name, password_hash, pass_hash, pin_hash, is_active)
VALUES (
  'admin',
  '0715151010',
  'Mastermind Admin',
  crypt('Oury2933#', gen_salt('bf')),
  crypt('Oury2933#', gen_salt('bf')),
  NULL,
  TRUE
)
ON CONFLICT (phone) DO UPDATE
SET role='admin',
    name=EXCLUDED.name,
    password_hash=EXCLUDED.password_hash,
    pass_hash=EXCLUDED.pass_hash,
    pin_hash=NULL,
    is_active=TRUE;

COMMIT;
