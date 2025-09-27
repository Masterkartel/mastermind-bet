const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bwipjs = require('bwip-js');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- ENV (with safe defaults)
const PORT = Number(process.env.PORT || 3000);
const STAKE_MIN_KES = Number(process.env.STAKE_MIN_KES || 20);
const STAKE_MAX_KES = Number(process.env.STAKE_MAX_KES || 1000);
const PAYOUT_MAX_KES = Number(process.env.PAYOUT_MAX_KES || 20000);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---- Health
app.get('/health', (_,res) => res.json({ ok: true, port: PORT }));

// ---- Barcode (PNG) for ticket codes
app.get('/barcode/:code', async (req,res) => {
  try {
    const png = await bwipjs.toBuffer({
      bcid: 'code128',
      text: req.params.code,
      scale: 3,
      height: 12,
      includetext: true,
      textxalign: 'center'
    });
    res.set('Content-Type','image/png').send(png);
  } catch (e) {
    res.status(400).send('barcode error');
  }
});

// ---- Seed sample league/teams/fixtures/markets (for quick demo)
app.post('/admin/seed-sample', async (_req,res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO leagues(code,name) VALUES
      ('EPL','English Premier League')
      ON CONFLICT (code) DO NOTHING;
    `);

    const { rows: lrows } = await client.query(`SELECT id FROM leagues WHERE code='EPL'`);
    const leagueId = lrows[0].id;

    const { rows: tcount } = await client.query('SELECT count(*) FROM teams WHERE league_id=$1', [leagueId]);
    if (Number(tcount[0].count) < 4) {
      await client.query(`
        INSERT INTO teams(league_id,code3,name,rating) VALUES
        ($1,'ARS','Arsenal',85),
        ($1,'CHE','Chelsea',80),
        ($1,'MCI','Man City',90),
        ($1,'MUN','Man United',82)
      `,[leagueId]);
    }

    const teams = await client.query(
      'SELECT id FROM teams WHERE league_id=$1 ORDER BY code3 LIMIT 4', [leagueId]
    );
    const [t1,t2,t3,t4] = teams.rows;

    const now = Date.now();
    const k1 = new Date(now + 5*60*1000);
    const k2 = new Date(now + 10*60*1000);

    const fxIns = await client.query(`
      INSERT INTO fixtures(id,league_id,kickoff_at,home_team,away_team,status)
      VALUES
      (gen_random_uuid(),$1,$2,$3,$4,'OPEN'),
      (gen_random_uuid(),$1,$5,$6,$7,'OPEN')
      RETURNING id
    `,[leagueId,k1,t1.id,t2.id,k2,t3.id,t4.id]);

    async function mk(fid) {
      const m1 = await client.query(
        `INSERT INTO markets(id,fixture_id,code) VALUES (gen_random_uuid(),$1,'1X2') RETURNING id`, [fid]
      );
      await client.query(`
        INSERT INTO selections(id,market_id,code,price) VALUES
        (gen_random_uuid(),$1,'1',1.90),
        (gen_random_uuid(),$1,'X',3.40),
        (gen_random_uuid(),$1,'2',3.60)
      `,[m1.rows[0].id]);

      const m2 = await client.query(
        `INSERT INTO markets(id,fixture_id,code) VALUES (gen_random_uuid(),$1,'OU_2_5') RETURNING id`, [fid]
      );
      await client.query(`
        INSERT INTO selections(id,market_id,code,price) VALUES
        (gen_random_uuid(),$1,'OV',1.95),
        (gen_random_uuid(),$1,'UN',1.85)
      `,[m2.rows[0].id]);
    }

    for (const r of fxIns.rows) { await mk(r.id); }

    await client.query('COMMIT');
    res.json({ ok:true, fixtures: fxIns.rows.map(x=>x.id) });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error: e.message });
  } finally {
    client.release();
  }
});

// ---- Cashier APIs
app.get('/api/fixtures', async (req,res) => {
  const league = req.query.league || 'EPL';
  const q = `
    SELECT f.id, f.kickoff_at,
           th.code3 AS home_code, ta.code3 AS away_code
    FROM fixtures f
    JOIN leagues l ON l.id=f.league_id AND l.code=$1
    JOIN teams th ON th.id=f.home_team
    JOIN teams ta ON ta.id=f.away_team
    WHERE f.status='OPEN'
    ORDER BY f.kickoff_at ASC
  `;
  const { rows } = await pool.query(q, [league]);
  res.json(rows);
});

app.get('/api/fixtures/:id/markets', async (req,res) => {
  const { id } = req.params;
  const q = `
    SELECT m.id AS market_id, m.code AS market,
           json_agg(json_build_object('selection_id',s.id,'code',s.code,'price',s.price)
             ORDER BY s.code) AS selections
    FROM markets m
    JOIN selections s ON s.market_id=m.id
    WHERE m.fixture_id=$1 AND m.status='OPEN'
    GROUP BY m.id, m.code
    ORDER BY m.code
  `;
  const { rows } = await pool.query(q, [id]);
  res.json(rows);
});

// Create ticket with stake & payout caps
app.post('/api/tickets', async (req,res) => {
  try {
    const { shop_id=null, cashier_id=null, stake_kes, lines } = req.body;
    if (!Array.isArray(lines) || lines.length===0) {
      return res.status(400).json({ ok:false, error:'No selections' });
    }

    const stake_cents = Math.round(Number(stake_kes) * 100);
    const min_c = STAKE_MIN_KES * 100;
    const max_c = STAKE_MAX_KES * 100;
    const cap_c = PAYOUT_MAX_KES * 100;

    if (!Number.isFinite(stake_cents) || stake_cents < min_c || stake_cents > max_c) {
      return res.status(400).json({ ok:false, error:`Stake must be between ${STAKE_MIN_KES}-${STAKE_MAX_KES} KES` });
    }

    const ids = lines.map(l=>l.selection_id);
    const q = `
      SELECT s.id, s.price, m.id AS market_id
      FROM selections s JOIN markets m ON m.id=s.market_id
      WHERE s.id = ANY($1::uuid[]) AND m.status='OPEN'
    `;
    const { rows } = await pool.query(q, [ids]);
    if (rows.length !== ids.length) {
      return res.status(400).json({ ok:false, error:'Invalid selections' });
    }

    let acc = 1.0;
    for (const r of rows) acc *= Number(r.price);
    let potential_cents = Math.floor(stake_cents * acc);
    if (potential_cents > cap_c) potential_cents = cap_c;

    const code = 'MM-' + Date.now().toString(36).toUpperCase();
    const t = await pool.query(`
      INSERT INTO tickets(code,shop_id,cashier_id,stake_cents,potential_win_cents,status)
      VALUES ($1,$2,$3,$4,$5,'PENDING')
      RETURNING id, code, potential_win_cents, created_at
    `,[code, shop_id, cashier_id, stake_cents, potential_cents]);

    const ticketId = t.rows[0].id;
    for (const r of rows) {
      await pool.query(`
        INSERT INTO ticket_lines(ticket_id,market_id,selection_id,price)
        VALUES ($1,$2,$3,$4)
      `,[ticketId, r.market_id, r.id, r.price]);
    }

    res.json({
      ok:true,
      code,
      stake_kes: (stake_cents/100).toFixed(2),
      potential_kes: (potential_cents/100).toFixed(2)
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Reprint / Fetch ticket
app.get('/api/tickets/:code', async (req,res) => {
  const { code } = req.params;
  const t = await pool.query(`
    SELECT id,code,stake_cents,potential_win_cents,status,created_at
    FROM tickets WHERE code=$1
  `,[code]);
  if (!t.rowCount) return res.status(404).json({ ok:false, error:'Not found' });

  const lines = await pool.query(`
    SELECT tl.price, m.code AS market, s.code AS pick
    FROM ticket_lines tl
    JOIN selections s ON s.id=tl.selection_id
    JOIN markets m    ON m.id=tl.market_id
    WHERE tl.ticket_id=$1
  `,[t.rows[0].id]);

  res.json({
    ok:true,
    ...t.rows[0],
    stake_kes: (t.rows[0].stake_cents/100).toFixed(2),
    potential_kes: (t.rows[0].potential_win_cents/100).toFixed(2),
    lines: lines.rows
  });
});

// ---- Homepage => POS
app.get('/', (_,res) => res.sendFile(path.join(__dirname,'public','pos.html')));

// ---- Start
app.listen(PORT, () => console.log(`App on :${PORT}`));
