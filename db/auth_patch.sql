-- db/auth_patch.sql
-- Auth + user hierarchy + sessions + compatibility for Mastermind Bet
BEGIN;

-- 0) Needed for hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) USERS (admin / agent / cashier)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('admin','agent','cashier')),
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT,          -- for admin (and optionally agent)
  pin_hash      TEXT,          -- for agent/cashier 6-digit PIN
  pass_hash     TEXT,          -- compatibility: index.js expects this
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Ensure agents.code is unique (if not already)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agents'::regclass
      AND conname  = 'agents_code_unique'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_code_unique UNIQUE (code);
  END IF;
END$$;

-- 3) Link users -> agents (owner_user_id)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS owner_user_id INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agents'::regclass
      AND conname  = 'agents_owner_user_fk'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_owner_user_fk
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END$$;

-- 4) CASHIERS table (belong to an agent)
CREATE TABLE IF NOT EXISTS cashiers (
  id         SERIAL PRIMARY KEY,
  agent_code TEXT NOT NULL REFERENCES agents(code) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,        -- 6-digit PIN hashed
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_code, name)
);

-- 5) SESSIONS (used by index.js)
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

-- 6) Helpers

-- 6a) Set/Change a user's PASSWORD (bcrypt)
CREATE OR REPLACE FUNCTION set_user_password(p_user_id INT, p_password TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users
     SET password_hash = crypt(p_password, gen_salt('bf')),
         pass_hash     = crypt(p_password, gen_salt('bf')),
         pin_hash = NULL
   WHERE id = p_user_id;
END$$;

-- 6b) Set/Change a user's 6-digit PIN (bcrypt)
CREATE OR REPLACE FUNCTION set_user_pin(p_user_id INT, p_pin TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'PIN must be exactly 6 digits';
  END IF;
  UPDATE users
     SET pin_hash = crypt(p_pin, gen_salt('bf')),
         password_hash = NULL,
         pass_hash = NULL
   WHERE id = p_user_id;
END$$;

-- 6c) Check login with password
CREATE OR REPLACE FUNCTION login_with_password(p_phone TEXT, p_password TEXT)
RETURNS users LANGUAGE sql AS $$
  SELECT *
  FROM users
  WHERE phone = p_phone
    AND password_hash IS NOT NULL
    AND password_hash = crypt(p_password, password_hash)
    AND is_active = TRUE
  LIMIT 1;
$$;

-- 6d) Check login with PIN
CREATE OR REPLACE FUNCTION login_with_pin(p_phone TEXT, p_pin TEXT)
RETURNS users LANGUAGE sql AS $$
  SELECT *
  FROM users
  WHERE phone = p_phone
    AND pin_hash IS NOT NULL
    AND pin_hash = crypt(p_pin, pin_hash)
    AND is_active = TRUE
  LIMIT 1;
$$;

-- 6e) Create an AGENT user + link to agents row
CREATE OR REPLACE FUNCTION create_agent_user(p_phone TEXT, p_name TEXT, p_agent_code TEXT, p_pin TEXT DEFAULT '000000')
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE uid INT;
BEGIN
  INSERT INTO users(role, phone, name, pin_hash)
  VALUES ('agent', p_phone, p_name, crypt(p_pin, gen_salt('bf')))
  ON CONFLICT (phone) DO UPDATE
    SET name = EXCLUDED.name,
        role = 'agent'
  RETURNING id INTO uid;

  UPDATE agents SET owner_user_id = uid
  WHERE code = p_agent_code;

  RETURN uid;
END$$;

-- 6f) Create a CASHIER under an agent
CREATE OR REPLACE FUNCTION create_cashier(p_agent_code TEXT, p_name TEXT, p_pin TEXT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE cid INT; phone_stub TEXT;
BEGIN
  IF p_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'PIN must be exactly 6 digits';
  END IF;

  INSERT INTO cashiers(agent_code, name, pin_hash)
  VALUES (p_agent_code, p_name, crypt(p_pin, gen_salt('bf')))
  RETURNING id INTO cid;

  -- Also mirror into users for unified auth
  phone_stub := upper(p_agent_code)||'-'||upper(regexp_replace(p_name,'\\s+','-','g'));
  INSERT INTO users(role, phone, name, pin_hash)
  VALUES ('cashier', phone_stub, p_name, crypt(p_pin, gen_salt('bf')))
  ON CONFLICT (phone) DO NOTHING;

  RETURN cid;
END$$;

-- 7) Seed the main ADMIN (phone 0715151010 / password Oury2933#)
DO $$
DECLARE admin_id INT;
BEGIN
  SELECT id INTO admin_id FROM users WHERE phone = '0715151010';
  IF admin_id IS NULL THEN
    INSERT INTO users(role, phone, name, password_hash, pass_hash)
    VALUES ('admin', '0715151010', 'Mastermind Admin', crypt('Oury2933#', gen_salt('bf')), crypt('Oury2933#', gen_salt('bf')))
    RETURNING id INTO admin_id;
  ELSE
    UPDATE users
       SET role='admin',
           password_hash = crypt('Oury2933#', gen_salt('bf')),
           pass_hash     = crypt('Oury2933#', gen_salt('bf')),
           pin_hash = NULL,
           is_active = TRUE
     WHERE id = admin_id;
  END IF;
END$$;

COMMIT;
