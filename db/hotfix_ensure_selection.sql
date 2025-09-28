-- db/hotfix_ensure_selection.sql
BEGIN;

-- Drop dependents first so we can safely drop ensure_selection
DROP FUNCTION IF EXISTS public.create_fixture_selections(integer);

-- Drop the broken overload of ensure_selection if present
DROP FUNCTION IF EXISTS public.ensure_selection(integer, text, numeric);

-- Recreate ensure_selection with unambiguous parameter names
CREATE OR REPLACE FUNCTION public.ensure_selection(
  p_market_id int,
  p_sel_name  text,
  p_sel_price numeric
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_sid int;
BEGIN
  SELECT id
    INTO v_sid
    FROM selections
   WHERE market_id = p_market_id
     AND name      = p_sel_name
   LIMIT 1;

  IF v_sid IS NULL THEN
    INSERT INTO selections (market_id, name, price)
    VALUES (p_market_id, p_sel_name, p_sel_price)
    RETURNING id INTO v_sid;
  ELSE
    -- idempotent: refresh price if rerun
    UPDATE selections
       SET price = p_sel_price
     WHERE id = v_sid;
  END IF;

  RETURN v_sid;
END;
$$;

-- Recreate create_fixture_selections to ensure it binds to the new ensure_selection
CREATE OR REPLACE FUNCTION public.create_fixture_selections(fid int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  m1x2 int; mou int; mdc int; mgg int; mhou int; maou int; m1o15 int; m1o25 int; mtgb int;
  ph numeric; pd numeric; pa numeric;
  pO05 numeric; pU05 numeric; pO15 numeric; pU15 numeric; pO25 numeric; pU25 numeric;
BEGIN
  -- ensure markets
  m1x2  := ensure_fixture_market(fid,'1X2','Match Result');
  mou   := ensure_fixture_market(fid,'OU','Over/Under Goals');
  mdc   := ensure_fixture_market(fid,'DC','Double Chance');
  mgg   := ensure_fixture_market(fid,'GGNG','Both Teams to Score');
  mhou  := ensure_fixture_market(fid,'HOU','Home Over/Under');
  maou  := ensure_fixture_market(fid,'AOU','Away Over/Under');
  m1o15 := ensure_fixture_market(fid,'1X2OU15','1X2 + Over/Under 1.5');
  m1o25 := ensure_fixture_market(fid,'1X2OU25','1X2 + Over/Under 2.5');
  mtgb  := ensure_fixture_market(fid,'TGB','Total Goals Bands');

  -- base 1X2 price ranges
  ph := round( (1.60 + random()*0.70)::numeric, 2);
  pd := round( (2.80 + random()*0.80)::numeric, 2);
  pa := round( (2.10 + random()*1.10)::numeric, 2);

  PERFORM ensure_selection(m1x2,'H',ph);
  PERFORM ensure_selection(m1x2,'D',pd);
  PERFORM ensure_selection(m1x2,'A',pa);

  -- Double Chance
  PERFORM ensure_selection(mdc,'1X', round( (1.0/( (0.92/ph)+(0.92/pd) ))::numeric,2) );
  PERFORM ensure_selection(mdc,'12', round( (1.0/( (0.92/ph)+(0.92/pa) ))::numeric,2) );
  PERFORM ensure_selection(mdc,'X2', round( (1.0/( (0.92/pd)+(0.92/pa) ))::numeric,2) );

  -- GG/NG
  PERFORM ensure_selection(mgg,'GG', round(1.55 + random()*0.65,2));
  PERFORM ensure_selection(mgg,'NG', round(1.55 + random()*0.65,2));

  -- O/U ladder
  pO05 := round(1.08 + random()*0.08,2); pU05 := round(5.00 + random()*1.50,2);
  pO15 := round(1.22 + random()*0.18,2); pU15 := round(2.70 + random()*1.20,2);
  pO25 := round(1.45 + random()*0.45,2); pU25 := round(1.80 + random()*1.10,2);

  PERFORM ensure_selection(mou,'O05', pO05);
  PERFORM ensure_selection(mou,'U05', pU05);
  PERFORM ensure_selection(mou,'O15', pO15);
  PERFORM ensure_selection(mou,'U15', pU15);
  PERFORM ensure_selection(mou,'O25', pO25);
  PERFORM ensure_selection(mou,'U25', pU25);
  PERFORM ensure_selection(mou,'O35', round(2.10 + random()*2.20,2));
  PERFORM ensure_selection(mou,'U35', round(1.45 + random()*0.60,2));
  PERFORM ensure_selection(mou,'O45', round(2.70 + random()*2.80,2));
  PERFORM ensure_selection(mou,'U45', round(1.30 + random()*0.40,2));
  PERFORM ensure_selection(mou,'O55', round(3.80 + random()*2.50,2));
  PERFORM ensure_selection(mou,'U55', round(1.22 + random()*0.25,2));

  -- Home O/U
  PERFORM ensure_selection(mhou,'H_O05', round(1.50 + random()*0.35,2));
  PERFORM ensure_selection(mhou,'H_U05', round(2.60 + random()*1.10,2));
  PERFORM ensure_selection(mhou,'H_O15', round(1.95 + random()*0.60,2));
  PERFORM ensure_selection(mhou,'H_U15', round(1.55 + random()*0.50,2));
  PERFORM ensure_selection(mhou,'H_O25', round(2.80 + random()*1.30,2));
  PERFORM ensure_selection(mhou,'H_U25', round(1.35 + random()*0.40,2));

  -- Away O/U
  PERFORM ensure_selection(maou,'A_O05', round(1.55 + random()*0.35,2));
  PERFORM ensure_selection(maou,'A_U05', round(2.70 + random()*1.10,2));
  PERFORM ensure_selection(maou,'A_O15', round(2.05 + random()*0.60,2));
  PERFORM ensure_selection(maou,'A_U15', round(1.55 + random()*0.50,2));
  PERFORM ensure_selection(maou,'A_O25', round(2.90 + random()*1.30,2));
  PERFORM ensure_selection(maou,'A_U25', round(1.35 + random()*0.40,2));

  -- 1X2 + O/U 1.5
  PERFORM ensure_selection(m1o15,'H&O', round( (1.0/((0.92/ph)*(0.65)))::numeric,2) );
  PERFORM ensure_selection(m1o15,'H&U', round( (1.0/((0.92/ph)*(0.35)))::numeric,2) );
  PERFORM ensure_selection(m1o15,'D&O', round( (1.0/((0.92/pd)*(0.65)))::numeric,2) );
  PERFORM ensure_selection(m1o15,'D&U', round( (1.0/((0.92/pd)*(0.35)))::numeric,2) );
  PERFORM ensure_selection(m1o15,'A&O', round( (1.0/((0.92/pa)*(0.65)))::numeric,2) );
  PERFORM ensure_selection(m1o15,'A&U', round( (1.0/((0.92/pa)*(0.35)))::numeric,2) );

  -- 1X2 + O/U 2.5
  PERFORM ensure_selection(m1o25,'H&O', round( (1.0/((0.92/ph)*(0.50)))::numeric,2) );
  PERFORM ensure_selection(m1o25,'H&U', round( (1.0/((0.92/ph)*(0.50)))::numeric,2) );
  PERFORM ensure_selection(m1o25,'D&O', round( (1.0/((0.92/pd)*(0.50)))::numeric,2) );
  PERFORM ensure_selection(m1o25,'D&U', round( (1.0/((0.92/pd)*(0.50)))::numeric,2) );
  PERFORM ensure_selection(m1o25,'A&O', round( (1.0/((0.92/pa)*(0.50)))::numeric,2) );
  PERFORM ensure_selection(m1o25,'A&U', round( (1.0/((0.92/pa)*(0.50)))::numeric,2) );

  -- Total Goals Bands
  PERFORM ensure_selection(mtgb,'TG_0_1', round(2.6 + random()*1.8,2));
  PERFORM ensure_selection(mtgb,'TG_2_3', round(1.7 + random()*0.9,2));
  PERFORM ensure_selection(mtgb,'TG_4_5', round(2.8 + random()*1.9,2));
  PERFORM ensure_selection(mtgb,'TG_6P',  round(5.0 + random()*4.5,2));
END;
$$;

COMMIT;
