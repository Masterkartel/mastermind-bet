-- db/auth_patch.sql
-- Auth + user hierarchy for Mastermind Bet
-- Safe to re-run (idempotent-ish)

BEGIN;

-- 0) Needed for hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) USERS table (admin / agent / cashier)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('admin','agent','cashier')),
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT,          -- for admin (and optionally agent)
  pin_hash      TEXT,          -- for agent/cashier 6-digit PIN
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) Make sure agents.code is unique (needed for linking)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agents_code_unique'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_code_unique UNIQUE (code);
  END IF;
END$$;

-- 3) Link: which user owns an agent account
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS owner_user_id INT;

ALTER TABLE agents
  ADD CONSTRAINT IF NOT EXISTS agents_owner_user_fk
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

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

-- 5) Helpers

-- 5a) Set/Change a user's PASSWORD (bcrypt)
CREATE OR REPLACE FUNCTION set_user_password(p_user_id INT, p_password TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users
     SET password_hash = crypt(p_password, gen_salt('bf')), pin_hash = NULL
   WHERE id = p_user_id;
END$$;

-- 5b) Set/Change a user's 6-digit PIN (bcrypt)
CREATE OR REPLACE FUNCTION set_user_pin(p_user_id INT, p_pin TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'PIN must be exactly 6 digits';
  END IF;
  UPDATE users
     SET pin_hash = crypt(p_pin, gen_salt('bf')), password_hash = NULL
   WHERE id = p_user_id;
END$$;

-- 5c) Check login with password (returns user row on success)
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

-- 5d) Check login with PIN (returns user row on success)
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

-- 5e) Create an AGENT user + link to an agents row (by code). Default PIN=000000
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

-- 5f) Create a CASHIER under an agent (by agent_code) with a 6-digit PIN
CREATE OR REPLACE FUNCTION create_cashier(p_agent_code TEXT, p_name TEXT, p_pin TEXT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE cid INT; phone_stub TEXT; uid INT;
BEGIN
  IF p_pin !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'PIN must be exactly 6 digits';
  END IF;

  -- store in cashiers table
  INSERT INTO cashiers(agent_code, name, pin_hash)
  VALUES (p_agent_code, p_name, crypt(p_pin, gen_salt('bf')))
  RETURNING id INTO cid;

  -- also create a user row for unified auth (phone = AGENTCODE-NAME uppercase, can be replaced later)
  phone_stub := upper(p_agent_code)||'-'||upper(regexp_replace(p_name,'\\s+','-','g'));
  INSERT INTO users(role, phone, name, pin_hash)
  VALUES ('cashier', phone_stub, p_name, crypt(p_pin, gen_salt('bf')))
  ON CONFLICT (phone) DO NOTHING
  RETURNING id INTO uid;

  RETURN cid;
END$$;

-- 6) Seed the main ADMIN if missing (phone 0715151010 / password Oury2933#)
DO $$
DECLARE admin_id INT;
BEGIN
  SELECT id INTO admin_id FROM users WHERE phone = '0715151010';
  IF admin_id IS NULL THEN
    INSERT INTO users(role, phone, name, password_hash)
    VALUES ('admin', '0715151010', 'Mastermind Admin', crypt('Oury2933#', gen_salt('bf')))
    RETURNING id INTO admin_id;
  ELSE
    -- Ensure role/password are set correctly if it already existed
    UPDATE users
       SET role='admin',
           password_hash = crypt('Oury2933#', gen_salt('bf')),
           pin_hash = NULL,
           is_active = TRUE
     WHERE id = admin_id;
  END IF;
END$$;

COMMIT;
