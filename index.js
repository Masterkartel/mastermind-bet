// index.js — Mastermind Bet API (Node 14+ compatible: no optional-chaining used)
require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json());

// serve /public (pos.html, virtual.html)
app.use(express.static(path.join(__dirname, 'public')));

// simple health
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ========= LISTS ========= */

// competitions
app.get('/api/competitions', async (_req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, code, name FROM competitions ORDER BY code'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'failed to load competitions' });
  }
});

// fixtures (by competition_code optional)
app.get('/api/fixtures', async (req, res) => {
  try {
    const competition_code = req.query.competition_code;
    let q = `
      SELECT f.id, c.code AS competition, f.start_time, f.status,
             th.name AS home, ta.name AS away
      FROM fixtures f
      JOIN competitions c ON c.id=f.competition_id
      JOIN teams th ON th.id=f.home_team_id
      JOIN teams ta ON ta.id=f.away_team_id
    `;
    const p = [];
    if (competition_code) {
      q += ' WHERE c.code=$1';
      p.push(competition_code);
    }
    q += ' ORDER BY f.start_time';
    const { rows } = await db.query(q, p);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'failed to load fixtures' });
  }
});

// races (DOG | HORSE)
app.get('/api/races', async (req, res) => {
  try {
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    let q = 'SELECT id, rtype, track, race_no, start_time, status FROM race_events';
    const p = [];
    if (type) {
      q += ' WHERE rtype=$1';
      p.push(type);
    }
    q += ' ORDER BY start_time';
    const { rows } = await db.query(q, p);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'failed to load races' });
  }
});

// selections (fixture_id | race_event_id | color_draw_id)
app.get('/api/selections', async (req, res) => {
  try {
    const fixture_id = req.query.fixture_id ? Number(req.query.fixture_id) : null;
    const race_event_id = req.query.race_event_id ? Number(req.query.race_event_id) : null;
    const color_draw_id = req.query.color_draw_id ? Number(req.query.color_draw_id) : null;

    let q = `
      SELECT s.id, m.kind, m.label, s.name, s.price
      FROM selections s
      JOIN markets m ON m.id = s.market_id
    `;
    const p = [];
    const w = [];

    if (fixture_id) {
      p.push(fixture_id);
      w.push('m.fixture_id=$' + p.length);
    }
    if (race_event_id) {
      p.push(race_event_id);
      w.push('m.race_event_id=$' + p.length);
    }
    if (color_draw_id) {
      p.push(color_draw_id);
      w.push('m.color_draw_id=$' + p.length);
    }
    if (w.length) q += ' WHERE ' + w.join(' AND ');

    const { rows } = await db.query(q, p);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'failed to load selections' });
  }
});

// color game: next draw + picks
app.get('/api/colors/draws/latest', async (_req, res) => {
  try {
    const qd = await db.query(
      `SELECT id, draw_no, start_time, status
       FROM color_draws
       WHERE status='scheduled'
       ORDER BY start_time
       LIMIT 1`
    );
    const d = qd.rows.length ? qd.rows[0] : null;
    if (!d) return res.json(null);

    const qp = await db.query(
      `SELECT s.id, s.name AS color, s.price
       FROM selections s
       JOIN markets m ON m.id = s.market_id
       WHERE m.color_draw_id=$1
       ORDER BY s.name`,
      [d.id]
    );
    res.json({ draw: d, picks: qp.rows });
  } catch (e) {
    res.status(500).json({ error: 'failed to load color draw' });
  }
});

/* ========= TICKETS ========= */

// place ticket
app.post('/api/tickets', async (req, res) => {
  try {
    const agent_code = req.body ? req.body.agent_code : null;
    const stake = req.body ? req.body.stake : null;
    const items = req.body ? req.body.items : null;

    if (!stake || !items || !items.length) {
      return res.status(400).json({ error: 'stake/items required' });
    }

    // fetch selections
    const ids = items.map(function (i) { return Number(i.selection_id); }).filter(Boolean);
    if (!ids.length) {
      return res.status(400).json({ error: 'invalid selection ids' });
    }

    await db.query('BEGIN');

    const selRes = await db.query(
      'SELECT id, price FROM selections WHERE id = ANY($1::int[])',
      [ids]
    );
    if (selRes.rows.length !== ids.length) {
      throw new Error('Invalid selection id');
    }

    // compute payout
    let productOdds = 1.0;
    selRes.rows.forEach(function (s) { productOdds *= Number(s.price); });
    const stakeCents = Math.round(Number(stake) * 100);
    const payoutCents = Math.round(stakeCents * productOdds);

    const tRes = await db.query(
      `INSERT INTO tickets (agent_code, stake_cents, potential_payout_cents)
       VALUES ($1,$2,$3) RETURNING id, created_at, status`,
      [agent_code || null, stakeCents, payoutCents]
    );
    const t = tRes.rows[0];

    // items
    for (let i = 0; i < selRes.rows.length; i++) {
      const s = selRes.rows[i];
      await db.query(
        `INSERT INTO ticket_items (ticket_id, selection_id, unit_odds)
         VALUES ($1,$2,$3)`,
        [t.id, s.id, s.price]
      );
    }

    await db.query('COMMIT');
    res.json({
      ticket_id: t.id,
      stake: stakeCents / 100,
      potential_payout: payoutCents / 100,
      created_at: t.created_at,
      status: t.status
    });
  } catch (e) {
    await db.query('ROLLBACK').catch(function(){});
    res.status(400).json({ error: String(e.message || e) });
  }
});

// reprint / ticket details
app.get('/api/tickets/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    const tRes = await db.query(
      `SELECT id, agent_code, stake_cents, potential_payout_cents, status, created_at
       FROM tickets WHERE id=$1`,
      [id]
    );
    if (!tRes.rows.length) return res.status(404).json({ error: 'not found' });
    const t = tRes.rows[0];

    const linesRes = await db.query(
      `SELECT ti.id,
              m.label AS market,
              s.name AS pick,
              ti.unit_odds AS price
       FROM ticket_items ti
       JOIN selections s ON s.id = ti.selection_id
       JOIN markets m    ON m.id = s.market_id
       WHERE ti.ticket_id=$1
       ORDER BY ti.id`,
      [id]
    );

    res.json({
      id: t.id,
      code: String(t.id), // simple code == id (you can change format later)
      agent_code: t.agent_code,
      stake_kes: (t.stake_cents || 0) / 100,
      potential_kes: (t.potential_payout_cents || 0) / 100,
      status: t.status,
      created_at: t.created_at,
      lines: linesRes.rows.map(function (r) {
        return { id: r.id, market: r.market, pick: r.pick, price: Number(r.price) };
      })
    });
  } catch (e) {
    res.status(400).json({ error: 'failed to load ticket' });
  }
});

/* ========= START ========= */

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API on :${port}`);
});
