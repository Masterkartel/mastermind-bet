-- db/auth_patch.sql
-- Enable pgcrypto for bcrypt hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- USERS table (admin & agents live here)
CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  role          text NOT NULL CHECK (role IN ('admin','agent')),
  phone         text UNIQUE NOT NULL,   -- use phone for login
  name          text NOT NULL,
  pass_hash     text NOT NULL,          -- bcrypt
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamp NOT NULL DEFAULT now()
);

-- Link agents to existing agents table (code = phone by default)
-- Your existing agents table: agents(code,name,balance_cents,is_active)
-- We will keep agents.code = users.phone (for agents)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS owner_user_id int;

-- CASHIERS table (belong to a single agent)
CREATE TABLE IF NOT EXISTS cashiers (
  id            serial PRIMARY KEY,
  agent_code    text NOT NULL REFERENCES agents(code) ON DELETE CASCADE,
  name          text NOT NULL,
  pin_hash      text NOT NULL,      -- bcrypt
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamp NOT NULL DEFAULT now()
);

-- SESSIONS (simple DB session store)
CREATE TABLE IF NOT EXISTS sessions (
  token         text PRIMARY KEY,   -- random string
  user_id       int REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('admin','agent','cashier')),
  agent_code    text,               -- set for agent & cashier sessions
  cashier_id    int,                -- set for cashier session
  created_at    timestamp NOT NULL DEFAULT now(),
  expires_at    timestamp NOT NULL
);

-- ADMIN seed (phone + password)
-- Phone: 0715151010
-- Password: Oury2933#
INSERT INTO users(role, phone, name, pass_hash)
SELECT 'admin','0715151010','Mastermind Admin', crypt('Oury2933#', gen_salt('bf', 10))
WHERE NOT EXISTS (SELECT 1 FROM users WHERE phone='0715151010');

-- Helper functions for bcrypt verify
-- (We just use crypt() = pass check in SQL when needed, but Node will do checks)
