-- db/hotfix_round_casts.sql
-- Recreate functions to cast double precision -> numeric before round(...,2)

BEGIN;

-- Recreate create_fixture_selections with proper casts
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

  -- 1X2 base price ranges (cast before round)
  ph := round( (1.60 + random()*0.70)::numeric, 2);
  pd := round( (2.80 + random()*0.80)::numeric, 2);
  pa := round( (2.10 + random()*1.10)::numeric, 2);

  PERFORM ensure_selection(m1x2,'H',ph);
  PERFORM ensure_selection(m1x2,'D',pd);
  PERFORM ensure_selection(m1x2,'A',pa);

  -- Double Chance (keep numeric)
  PERFORM ensure_selection(mdc,'1X', round( (1.0/((0.92/ph)+(0.92/pd)))::numeric, 2) );
  PERFORM ensure_selection(mdc,'12', round( (1.0/((0.92/ph)+(0.92/pa)))::numeric, 2) );
  PERFORM ensure_selection(mdc,'X2', round( (1.0/((0.92/pd)+(0.92/pa)))::numeric, 2) );

  -- GG/NG with casts
  PERFORM ensure_selection(mgg,'GG', round( (1.55 + random()*0.65)::numeric, 2));
  PERFORM ensure_selection(mgg,'NG', round( (1.55 + random()*0.65)::numeric, 2));

  -- O/U ladder with casts
  pO05 := round( (1.08 + random()*0.08)::numeric, 2);  pU05 := round( (5.00 + random()*1.50)::numeric, 2);
  pO15 := round( (1.22 + random()*0.18)::numeric, 2);  pU15 := round( (2.70 + random()*1.20)::numeric, 2);
  pO25 := round( (1.45 + random()*0.45)::numeric, 2);  pU25 := round( (1.80 + random()*1.10)::numeric, 2);

  PERFORM ensure_selection(mou,'O05', pO05);
  PERFORM ensure_selection(mou,'U05', pU05);
  PERFORM ensure_selection(mou,'O15', pO15);
  PERFORM ensure_selection(mou,'U15', pU15);
  PERFORM ensure_selection(mou,'O25', pO25);
  PERFORM ensure_selection(mou,'U25', pU25);
  PERFORM ensure_selection(mou,'O35', round( (2.10 + random()*2.20)::numeric, 2));
  PERFORM ensure_selection(mou,'U35', round( (1.45 + random()*0.60)::numeric, 2));
  PERFORM ensure_selection(mou,'O45', round( (2.70 + random()*2.80)::numeric, 2));
  PERFORM ensure_selection(mou,'U45', round( (1.30 + random()*0.40)::numeric, 2));
  PERFORM ensure_selection(mou,'O55', round( (3.80 + random()*2.50)::numeric, 2));
  PERFORM ensure_selection(mou,'U55', round( (1.22 + random()*0.25)::numeric, 2));

  -- Home O/U
  PERFORM ensure_selection(mhou,'H_O05', round( (1.50 + random()*0.35)::numeric, 2));
  PERFORM ensure_selection(mhou,'H_U05', round( (2.60 + random()*1.10)::numeric, 2));
  PERFORM ensure_selection(mhou,'H_O15', round( (1.95 + random()*0.60)::numeric, 2));
  PERFORM ensure_selection(mhou,'H_U15', round( (1.55 + random()*0.50)::numeric, 2));
  PERFORM ensure_selection(mhou,'H_O25', round( (2.80 + random()*1.30)::numeric, 2));
  PERFORM ensure_selection(mhou,'H_U25', round( (1.35 + random()*0.40)::numeric, 2));

  -- Away O/U
  PERFORM ensure_selection(maou,'A_O05', round( (1.55 + random()*0.35)::numeric, 2));
  PERFORM ensure_selection(maou,'A_U05', round( (2.70 + random()*1.10)::numeric, 2));
  PERFORM ensure_selection(maou,'A_O15', round( (2.05 + random()*0.60)::numeric, 2));
  PERFORM ensure_selection(maou,'A_U15', round( (1.55 + random()*0.50)::numeric, 2));
  PERFORM ensure_selection(maou,'A_O25', round( (2.90 + random()*1.30)::numeric, 2));
  PERFORM ensure_selection(maou,'A_U25', round( (1.35 + random()*0.40)::numeric, 2));

  -- 1X2 + O/U 1.5
  PERFORM ensure_selection(m1o15,'H&O', round( (1.0/((0.92/ph)*(0.65)))::numeric, 2) );
  PERFORM ensure_selection(m1o15,'H&U', round( (1.0/((0.92/ph)*(0.35)))::numeric, 2) );
  PERFORM ensure_selection(m1o15,'D&O', round( (1.0/((0.92/pd)*(0.65)))::numeric, 2) );
  PERFORM ensure_selection(m1o15,'D&U', round( (1.0/((0.92/pd)*(0.35)))::numeric, 2) );
  PERFORM ensure_selection(m1o15,'A&O', round( (1.0/((0.92/pa)*(0.65)))::numeric, 2) );
  PERFORM ensure_selection(m1o15,'A&U', round( (1.0/((0.92/pa)*(0.35)))::numeric, 2) );

  -- 1X2 + O/U 2.5
  PERFORM ensure_selection(m1o25,'H&O', round( (1.0/((0.92/ph)*(0.50)))::numeric, 2) );
  PERFORM ensure_selection(m1o25,'H&U', round( (1.0/((0.92/ph)*(0.50)))::numeric, 2) );
  PERFORM ensure_selection(m1o25,'D&O', round( (1.0/((0.92/pd)*(0.50)))::numeric, 2) );
  PERFORM ensure_selection(m1o25,'D&U', round( (1.0/((0.92/pd)*(0.50)))::numeric, 2) );
  PERFORM ensure_selection(m1o25,'A&O', round( (1.0/((0.92/pa)*(0.50)))::numeric, 2) );
  PERFORM ensure_selection(m1o25,'A&U', round( (1.0/((0.92/pa)*(0.50)))::numeric, 2) );

  -- Total Goals Bands
  PERFORM ensure_selection(mtgb,'TG_0_1', round( (2.6 + random()*1.8)::numeric, 2));
  PERFORM ensure_selection(mtgb,'TG_2_3', round( (1.7 + random()*0.9)::numeric, 2));
  PERFORM ensure_selection(mtgb,'TG_4_5', round( (2.8 + random()*1.9)::numeric, 2));
  PERFORM ensure_selection(mtgb,'TG_6P',  round( (5.0 + random()*4.5)::numeric, 2));
END;
$$;

-- Recreate create_color_selections with casts
CREATE OR REPLACE FUNCTION public.create_color_selections(draw_id int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  m_win int;
  m_cnt int;
BEGIN
  SELECT id INTO m_win
  FROM markets
  WHERE color_draw_id = draw_id AND kind='COLOR' AND label='WINNING COLOR'
  LIMIT 1;
  IF m_win IS NULL THEN
    INSERT INTO markets (color_draw_id, kind, label)
    VALUES (draw_id, 'COLOR', 'WINNING COLOR')
    RETURNING id INTO m_win;
  END IF;

  SELECT id INTO m_cnt
  FROM markets
  WHERE color_draw_id = draw_id AND kind='COLOR' AND label='NUMBER OF COLORS'
  LIMIT 1;
  IF m_cnt IS NULL THEN
    INSERT INTO markets (color_draw_id, kind, label)
    VALUES (draw_id, 'COLOR', 'NUMBER OF COLORS')
    RETURNING id INTO m_cnt;
  END IF;

  PERFORM ensure_selection(m_win,'RED',    round( (2.2 + random()*0.8)::numeric, 2));
  PERFORM ensure_selection(m_win,'BLUE',   round( (2.2 + random()*0.8)::numeric, 2));
  PERFORM ensure_selection(m_win,'GREEN',  round( (2.2 + random()*0.8)::numeric, 2));
  PERFORM ensure_selection(m_win,'YELLOW', round( (2.6 + random()*1.2)::numeric, 2));
  PERFORM ensure_selection(m_win,'PURPLE', round( (3.2 + random()*2.0)::numeric, 2));
  PERFORM ensure_selection(m_win,'ORANGE', round( (3.2 + random()*2.0)::numeric, 2));

  PERFORM ensure_selection(m_cnt,'ONE',   round( (3.0 + random()*1.5)::numeric, 2));
  PERFORM ensure_selection(m_cnt,'TWO',   round( (2.0 + random()*0.8)::numeric, 2));
  PERFORM ensure_selection(m_cnt,'THREE', round( (2.2 + random()*1.2)::numeric, 2));
  PERFORM ensure_selection(m_cnt,'FOUR',  round( (4.0 + random()*2.5)::numeric, 2));
END;
$$;

-- Recreate create_race_selections with casts
CREATE OR REPLACE FUNCTION public.create_race_selections(reid int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  mid int;
  r record;
  base numeric := 1.8;
BEGIN
  SELECT id INTO mid
  FROM markets
  WHERE race_event_id = reid AND kind='RACE'
  LIMIT 1;
  IF mid IS NULL THEN
    INSERT INTO markets (race_event_id, kind, label)
    VALUES (reid, 'RACE', 'Race Winner')
    RETURNING id INTO mid;
  END IF;

  FOR r IN
    SELECT number, label
    FROM race_runners
    WHERE race_event_id = reid
    ORDER BY number
  LOOP
    PERFORM ensure_selection(mid, r.label, round( (base + (r.number-1)*0.35 + random()*0.25)::numeric, 2));
  END LOOP;
END;
$$;

COMMIT;
