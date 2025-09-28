-- db/patch_selections_fix2.sql
-- Fix ensure_selection signature + backfill alias shadowing

-- 1) Drop the old ensure_selection (keeps data intact)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'ensure_selection'
      AND pg_get_function_identity_arguments(oid) = 'integer, text, numeric'
  ) THEN
    EXECUTE 'DROP FUNCTION ensure_selection(integer, text, numeric)';
  END IF;
END$$;

-- 2) Recreate ensure_selection with stable parameter names
CREATE OR REPLACE FUNCTION ensure_selection(p_market_id int, p_sel_name text, p_sel_price numeric)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_sid int;
BEGIN
  SELECT id INTO v_sid
  FROM selections
  WHERE market_id = p_market_id AND name = p_sel_name
  LIMIT 1;

  IF v_sid IS NULL THEN
    INSERT INTO selections (market_id, name, price)
    VALUES (p_market_id, p_sel_name, p_sel_price)
    RETURNING id INTO v_sid;
  ELSE
    -- idempotent: refresh price if you rerun
    UPDATE selections
    SET price = p_sel_price
    WHERE id = v_sid;
  END IF;

  RETURN v_sid;
END$$;

-- 3) Rewrite backfills with SAFE aliases (avoid variable/alias clashes)

-- Fixtures
CREATE OR REPLACE FUNCTION backfill_fixture_selections()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  n int := 0;
  fx record;
BEGIN
  FOR fx IN
    SELECT f.id AS id
    FROM fixtures f
    WHERE NOT EXISTS (
      SELECT 1
      FROM markets m
      JOIN selections s ON s.market_id = m.id
      WHERE m.fixture_id = f.id
    )
  LOOP
    PERFORM create_fixture_selections(fx.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END$$;

-- Colors
CREATE OR REPLACE FUNCTION backfill_color_selections()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  n int := 0;
  cdrec record;
BEGIN
  FOR cdrec IN
    SELECT cd.id AS id
    FROM color_draws cd
    WHERE NOT EXISTS (
      SELECT 1
      FROM markets m
      JOIN selections s ON s.market_id = m.id
      WHERE m.color_draw_id = cd.id
    )
  LOOP
    PERFORM create_color_selections(cdrec.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END$$;

-- Races
CREATE OR REPLACE FUNCTION backfill_race_selections()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  n int := 0;
  revent record;
BEGIN
  FOR revent IN
    SELECT re.id AS id
    FROM race_events re
    WHERE NOT EXISTS (
      SELECT 1
      FROM markets m
      JOIN selections s ON s.market_id = m.id
      WHERE m.race_event_id = re.id
    )
  LOOP
    PERFORM create_race_selections(revent.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END$$;

-- 4) One-call wrapper
CREATE OR REPLACE FUNCTION backfill_all()
RETURNS TABLE(fixtures int, colors int, races int) LANGUAGE plpgsql AS $$
BEGIN
  fixtures := backfill_fixture_selections();
  colors   := backfill_color_selections();
  races    := backfill_race_selections();
  RETURN NEXT;
END$$;
