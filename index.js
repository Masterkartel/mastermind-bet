// index.js — Mastermind Bet API (Node 14+ compatible)
require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');

const app = express();
app.use(express.json());

// serve static
app.use(express.static(path.join(__dirname, 'public')));

// pretty routes (root -> POS)
app.get(/^\/pos\/?$/i, (_, res) => res.sendFile(path.join(__dirname, 'public', 'pos.html')));
app.get(/^\/virtual\/?$/i, (_, res) => res.sendFile(path.join(__dirname, 'public', 'virtual.html')));
app.get(/^\/history\/?$/i, (_, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get(/^\/admin\/?$/i, (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'pos.html')));

// health
app.get('/health', (_, res) => res.json({ ok: true }));

/* ===== Helpers ===== */
async function getNum(key, fallback) {
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  if (!r.rows.length) return fallback;
  const n = Number(r.rows[0].value);
  return Number.isFinite(n) ? n : fallback;
}
async function getLimits() {
  const [min_stake, max_stake, max_payout] = await Promise.all([
    getNum('min_stake', 20),
    getNum('max_stake', 1000),
    getNum('max_payout', 20000),
  ]);
  return { min_stake, max_stake, max_payout };
}

/* ========= LISTS ========= */

// competitions
app.get('/api/competitions', async (_req, res) => {
  try {
    const r = await db.query('SELECT id, code, name FROM competitions ORDER BY code');
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: 'failed to load competitions' });
  }
});

// fixtures (by competition_code optional)
app.get('/api/fixtures', async (req, res) => {
  try {
    const code = req.query.competition_code;
    let q = `
      SELECT f.id, c.code AS competition, f.start_time, f.status,
             th.name AS home, ta.name AS away
      FROM fixtures f
      JOIN competitions c ON c.id=f.competition_id
      JOIN teams th ON th.id=f.home_team_id
      JOIN teams ta ON ta.id=f.away_team_id
    `;
    const p = [];
    if (code) { q += ' WHERE c.code=$1'; p.push(code); }
    q += ' ORDER BY f.start_time';
    const r = await db.query(q, p);
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: 'failed to load fixtures' });
  }
});

// races (DOG | HORSE)
app.get('/api/races', async (req, res) => {
  try {
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    let q = 'SELECT id, rtype, track, race_no, start_time, status FROM race_events';
    const p = [];
    if (type) { q += ' WHERE rtype=$1'; p.push(type); }
    q += ' ORDER BY start_time';
    const r = await db.query(q, p);
    res.json(r.rows);
  } catch {
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
      SELECT s.id, m.kind, m.label, s.name, s.price, s.is_winner
      FROM selections s
      JOIN markets m ON m.id = s.market_id
    `;
    const p = []; const w = [];
    if (fixture_id) { p.push(fixture_id); w.push('m.fixture_id=$' + p.length); }
    if (race_event_id) { p.push(race_event_id); w.push('m.race_event_id=$' + p.length); }
    if (color_draw_id) { p.push(color_draw_id); w.push('m.color_draw_id=$' + p.length); }
    if (w.length) q += ' WHERE ' + w.join(' AND ');
    q += ' ORDER BY m.id, s.id';

    const r = await db.query(q, p);
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: 'failed to load selections' });
  }
});

// color game: latest draw
app.get('/api/colors/draws/latest', async (_req, res) => {
  try {
    const qd = await db.query(
      `SELECT id, draw_no, start_time, status
       FROM color_draws
       WHERE status='scheduled'
       ORDER BY start_time
       LIMIT 1`
    );
    const d = qd.rows[0];
    if (!d) return res.json(null);

    const qp = await db.query(
      `SELECT s.id, s.name AS color, s.price
       FROM selections s
       JOIN markets m ON m.id = s.market_id
       WHERE m.color_draw_id=$1 AND m.label='WINNING COLOR'
       ORDER BY s.name`,
      [d.id]
    );
    const noc = await db.query(
      `SELECT s.id, s.name, s.price
       FROM selections s
       JOIN markets m ON m.id=s.market_id
       WHERE m.color_draw_id=$1 AND m.label='NUMBER OF COLORS'
       ORDER BY s.name`,
      [d.id]
    );

    res.json({ draw: d, picks: qp.rows, number_of_colors: noc.rows });
  } catch {
    res.status(500).json({ error: 'failed to load color draw' });
  }
});

/* ========= VIRTUAL DASH HELPERS ========= */

// next kickoff per league
app.get('/virtual/state', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT c.code, MIN(f.start_time) AS next_start
       FROM competitions c
       JOIN fixtures f ON f.competition_id=c.id AND f.status='scheduled'
       GROUP BY c.code ORDER BY c.code`
    );
    const leagues = r.rows.map(row => ({
      code: row.code,
      round: 1,
      endsAt: new Date(row.next_start).getTime(),
    }));
    res.json({ leagues });
  } catch {
    res.json({ leagues: [] });
  }
});

// league detail with grouped markets
app.get('/virtual/league/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '');
    const fx = await db.query(
      `SELECT f.id, th.name AS home, ta.name AS away, f.start_time
       FROM fixtures f
       JOIN competitions c ON c.id=f.competition_id
       JOIN teams th ON th.id=f.home_team_id
       JOIN teams ta ON ta.id=f.away_team_id
       WHERE c.code=$1 AND f.status='scheduled'
       ORDER BY f.start_time, f.id`,
      [code]
    );

    const out = [];
    for (const f of fx.rows) {
      const mk = await db.query(
        `SELECT m.id, m.label, s.id AS selection_id, s.name, s.price
         FROM markets m
         JOIN selections s ON s.market_id=m.id
         WHERE m.fixture_id=$1
         ORDER BY m.id, s.id`,
        [f.id]
      );
      const grouped = {};
      mk.rows.forEach(r => {
        if (!grouped[r.label]) grouped[r.label] = {};
        grouped[r.label][r.name] = Number(r.price);
      });
      out.push({
        id: f.id,
        home: f.home, away: f.away,
        kickoff: f.start_time,
        markets: grouped,
      });
    }
    res.json({ code, fixtures: out });
  } catch {
    res.status(500).json({ error: 'failed to load league' });
  }
});

// colors summary
app.get('/virtual/colors', async (_req, res) => {
  try {
    const qd = await db.query(
      `SELECT id, draw_no, start_time
       FROM color_draws
       WHERE status='scheduled'
       ORDER BY start_time LIMIT 1`
    );
    if (!qd.rows.length) return res.json(null);
    const d = qd.rows[0];
    const ps = await db.query(
      `SELECT s.id, s.name AS color, s.price
       FROM selections s JOIN markets m ON m.id=s.market_id
       WHERE m.color_draw_id=$1 AND m.label='WINNING COLOR'
       ORDER BY s.name`,
      [d.id]
    );
    res.json({ draw_no: d.draw_no, starts_at: d.start_time, picks: ps.rows });
  } catch {
    res.json(null);
  }
});

/* ========= AGENTS ========= */

// (same as before… left unchanged for brevity)

/* ========= TICKETS ========= */

// (same as before… left unchanged)

/* ========= AUTO-SETTLER ========= */

// (same as before… left unchanged)

/* ========= START ========= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API on :${port}`));
