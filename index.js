require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

/* ======= LISTING ======= */
app.get('/api/competitions', async (_req,res)=>{
  const { rows } = await db.query(`SELECT id,code,name FROM competitions ORDER BY code`);
  res.json(rows);
});

app.get('/api/fixtures', async (req,res)=>{
  const { competition_code } = req.query;
  let q = `
    SELECT f.id, c.code AS competition, f.start_time, f.status,
           th.name AS home, ta.name AS away
    FROM fixtures f
    JOIN competitions c ON c.id=f.competition_id
    JOIN teams th ON th.id=f.home_team_id
    JOIN teams ta ON ta.id=f.away_team_id`;
  const p = [];
  if (competition_code){ q += ` WHERE c.code=$1`; p.push(competition_code); }
  q += ` ORDER BY f.start_time`;
  const { rows } = await db.query(q, p);
  res.json(rows);
});

app.get('/api/races', async (req,res)=>{
  const { type } = req.query; // DOG | HORSE
  let q = `SELECT id, rtype, track, race_no, start_time, status FROM race_events`;
  const p = [];
  if (type){ q += ` WHERE rtype=$1`; p.push(type.toUpperCase()); }
  q += ` ORDER BY start_time`;
  const { rows } = await db.query(q, p);
  res.json(rows);
});

app.get('/api/selections', async (req,res)=>{
  const { fixture_id, race_event_id, color_draw_id } = req.query;
  let q = `SELECT s.id, m.kind, m.label, s.name, s.price
           FROM selections s JOIN markets m ON m.id=s.market_id`;
  const p = [], w = [];
  if (fixture_id){ p.push(+fixture_id); w.push(`m.fixture_id=$${p.length}`); }
  if (race_event_id){ p.push(+race_event_id); w.push(`m.race_event_id=$${p.length}`); }
  if (color_draw_id){ p.push(+color_draw_id); w.push(`m.color_draw_id=$${p.length}`); }
  if (w.length) q += ` WHERE ` + w.join(' AND ');
  const { rows } = await db.query(q, p);
  res.json(rows);
});

app.get('/api/colors/draws/latest', async (_req,res)=>{
  const { rows:[d] } = await db.query(
    `SELECT id, draw_no, start_time, status
     FROM color_draws WHERE status='scheduled' ORDER BY start_time LIMIT 1`
  );
  if (!d) return res.json(null);
  const { rows: picks } = await db.query(
    `SELECT s.id, s.name AS color, s.price
     FROM selections s JOIN markets m ON m.id=s.market_id
     WHERE m.color_draw_id=$1 ORDER BY s.name`, [d.id]
  );
  res.json({ draw: d, picks });
});

/* ======= TICKETS ======= */
app.post('/api/tickets', async (req,res)=>{
  const { agent_code, stake, items } = req.body;
  if (!stake || !items?.length) return res.status(400).json({error:'stake/items required'});
  try {
    await db.query('BEGIN');
    const { rows: sel } = await db.query(
      `SELECT id, price FROM selections WHERE id = ANY($1::int[])`,
      [items.map(i=>+i.selection_id)]
    );
    if (sel.length !== items.length) throw new Error('Invalid selection id');

    const productOdds = sel.reduce((acc,s)=> acc * Number(s.price), 1.0);
    const stakeCents = Math.round(Number(stake)*100);
    const payoutCents = Math.round(stakeCents * productOdds);

    const { rows:[t] } = await db.query(
      `INSERT INTO tickets (agent_code, stake_cents, potential_payout_cents)
       VALUES ($1,$2,$3) RETURNING id`,
      [agent_code||null, stakeCents, payoutCents]
    );

    for (const s of sel){
      await db.query(
        `INSERT INTO ticket_items (ticket_id, selection_id, unit_odds)
         VALUES ($1,$2,$3)`,
        [t.id, s.id, s.price]
      );
    }
    await db.query('COMMIT');
    res.json({ ticket_id: t.id, stake: stakeCents/100, potential_payout: payoutCents/100 });
  } catch(e){
    await db.query('ROLLBACK');
    res.status(400).json({error: e.message});
  }
});

/* ======= START ======= */
const port = process.env.PORT || 3000;
app.listen(port, ()=> console.log(`API on :${port}`));
