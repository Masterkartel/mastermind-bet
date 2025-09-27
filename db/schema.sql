-- Football
CREATE TABLE IF NOT EXISTS competitions (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT,
  competition_id INT REFERENCES competitions(id) ON DELETE SET NULL
);
CREATE TYPE fixture_status AS ENUM ('scheduled','live','settled','void');
CREATE TABLE IF NOT EXISTS fixtures (
  id SERIAL PRIMARY KEY,
  competition_id INT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  matchday INT,
  start_time TIMESTAMPTZ NOT NULL,
  status fixture_status NOT NULL DEFAULT 'scheduled',
  home_team_id INT NOT NULL REFERENCES teams(id),
  away_team_id INT NOT NULL REFERENCES teams(id)
);

-- Unified markets
CREATE TYPE market_kind AS ENUM ('FOOTBALL_MAIN','RACE_WIN','RACE_FORECAST','COLOR_PICK');
CREATE TABLE IF NOT EXISTS markets (
  id SERIAL PRIMARY KEY,
  kind market_kind NOT NULL,
  label TEXT NOT NULL,
  fixture_id INT,
  race_event_id INT,
  color_draw_id INT
);
CREATE TABLE IF NOT EXISTS selections (
  id SERIAL PRIMARY KEY,
  market_id INT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  outcome TEXT,
  price DECIMAL(8,2) NOT NULL CHECK (price>=1.01)
);

-- Races
CREATE TYPE race_type AS ENUM ('DOG','HORSE');
CREATE TABLE IF NOT EXISTS race_events (
  id SERIAL PRIMARY KEY,
  rtype race_type NOT NULL,
  track TEXT NOT NULL,
  race_no INT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  status fixture_status NOT NULL DEFAULT 'scheduled'
);
CREATE TABLE IF NOT EXISTS race_runners (
  id SERIAL PRIMARY KEY,
  race_event_id INT NOT NULL REFERENCES race_events(id) ON DELETE CASCADE,
  number INT NOT NULL,
  label TEXT NOT NULL
);

-- Color game
CREATE TABLE IF NOT EXISTS color_draws (
  id SERIAL PRIMARY KEY,
  draw_no INT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  status fixture_status NOT NULL DEFAULT 'scheduled'
);
CREATE TABLE IF NOT EXISTS color_map (
  number INT PRIMARY KEY,
  color TEXT NOT NULL
);

-- Tickets
CREATE TYPE ticket_status AS ENUM ('open','won','lost','void');
CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  agent_code TEXT,
  stake_cents INT NOT NULL CHECK (stake_cents>0),
  potential_payout_cents INT NOT NULL,
  status ticket_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ticket_items (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  selection_id INT NOT NULL REFERENCES selections(id) ON DELETE RESTRICT,
  unit_odds DECIMAL(8,2) NOT NULL
);
