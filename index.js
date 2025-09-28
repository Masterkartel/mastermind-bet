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
app.get(/^\/dogs\/?$/i,   (_, res) => res.sendFile(path.join(__dirname, 'public', 'dogs.html')));
app.get(/^\/horses\/?$/i, (_, res) => res.sendFile(path.join(__dirname, 'public', 'horses.html')));
app.get(/^\/colors\/?$/i, (_, res) => res.sendFile(path.join(__dirname, 'public', 'colors.html')));

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

// color game: next draw + picks
// list next N color draws (used for toggle tabs on Colors page)
app.get('/api/colors/draws', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 5), 1), 20);
    const r = await db.query(
      `SELECT id, draw_no, start_time, status
       FROM color_draws
       WHERE status='scheduled' AND start_time >= NOW() - INTERVAL '5 minutes'
       ORDER BY start_time
       LIMIT $1`,
      [limit]
    );
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: 'failed to load draws' });
  }
});

// get a specific draw (same shape as /latest)
app.get('/api/colors/draws/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    const dRes = await db.query(
      `SELECT id, draw_no, start_time, status
       FROM color_draws WHERE id=$1`, [id]
    );
    const d = dRes.rows[0];
    if (!d) return res.json(null);

    const win = await db.query(
      `SELECT s.id, s.name AS color, s.price
       FROM selections s
       JOIN markets m ON m.id = s.market_id
       WHERE m.color_draw_id=$1 AND m.label='WINNING COLOR'
       ORDER BY s.name`,
      [id]
    );
    const noc = await db.query(
      `SELECT s.id, s.name, s.price
       FROM selections s
       JOIN markets m ON m.id=s.market_id
       WHERE m.color_draw_id=$1 AND m.label='NUMBER OF COLORS'
       ORDER BY s.name`,
      [id]
    );

    res.json({ draw: d, picks: win.rows, number_of_colors: noc.rows });
  } catch {
    res.status(500).json({ error: 'failed to load draw' });
  }
});

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
    // also number-of-colors if present
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

// colors summary for countdown
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

app.get('/api/agents/:code', async (req, res) => {
  try {
    const r = await db.query('SELECT code,name,balance_cents,is_active FROM agents WHERE code=$1', [req.params.code]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const a = r.rows[0];
    res.json({ code: a.code, name: a.name, balance: (a.balance_cents||0)/100, is_active: a.is_active });
  } catch {
    res.status(500).json({ error: 'failed' });
  }
});

/* ========= TICKETS ========= */

// place ticket (enforce limits + agent balance + payout cap)
app.post('/api/tickets', async (req, res) => {
  const { agent_code, stake, items } = req.body || {};
  try {
    if (!stake || !items || !items.length) {
      return res.status(400).json({ error: 'stake/items required' });
    }
    const { min_stake, max_stake, max_payout } = await getLimits();
    const stakeNum = Number(stake);
    if (!(stakeNum >= min_stake && stakeNum <= max_stake)) {
      return res.status(400).json({ error: `Stake must be between ${min_stake} and ${max_stake}` });
    }

    const ids = items.map(i => Number(i.selection_id)).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'invalid selection ids' });

    await db.query('BEGIN');

    // agent check + balance
    let agentRow = null;
    if (agent_code) {
      const ar = await db.query('SELECT id, balance_cents, is_active FROM agents WHERE code=$1 FOR UPDATE', [agent_code]);
      if (!ar.rows.length) throw new Error('Invalid agent');
      agentRow = ar.rows[0];
      if (!agentRow.is_active) throw new Error('Agent disabled');
    }

    const selRes = await db.query('SELECT id, price FROM selections WHERE id = ANY($1::int[])', [ids]);
    if (selRes.rows.length !== ids.length) throw new Error('Invalid selection id');

    // compute capped payout
    let productOdds = 1.0;
    selRes.rows.forEach(s => (productOdds *= Number(s.price)));
    const stakeCents = Math.round(stakeNum * 100);
    let payoutCents = Math.round(stakeCents * productOdds);
    const cap = Math.round(Number(max_payout) * 100);
    if (payoutCents > cap) payoutCents = cap;

    // balance enforcement
    if (agentRow) {
      if ((agentRow.balance_cents || 0) < stakeCents) throw new Error('Insufficient balance');
      await db.query('UPDATE agents SET balance_cents = balance_cents - $1 WHERE id=$2', [stakeCents, agentRow.id]);
    }

    const tRes = await db.query(
      `INSERT INTO tickets (agent_code, stake_cents, potential_payout_cents)
       VALUES ($1,$2,$3) RETURNING id, created_at, status`,
      [agent_code || null, stakeCents, payoutCents]
    );
    const t = tRes.rows[0];

    for (const s of selRes.rows) {
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
      status: t.status,
    });
  } catch (e) {
    await db.query('ROLLBACK').catch(()=>{});
    res.status(400).json({ error: e.message || String(e) });
  }
});

// ticket detail
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
      code: String(t.id),
      agent_code: t.agent_code,
      stake_kes: (t.stake_cents || 0) / 100,
      potential_kes: (t.potential_payout_cents || 0) / 100,
      status: t.status,
      created_at: t.created_at,
      lines: linesRes.rows.map(r => ({ id: r.id, market: r.market, pick: r.pick, price: Number(r.price) })),
    });
  } catch {
    res.status(400).json({ error: 'failed to load ticket' });
  }
});

// ticket history (latest N)
app.get('/api/tickets', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const r = await db.query(
      `SELECT id, agent_code, stake_cents, potential_payout_cents, status, created_at
       FROM tickets ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(r.rows.map(t => ({
      id: t.id,
      stake_kes: (t.stake_cents||0)/100,
      potential_kes: (t.potential_payout_cents||0)/100,
      status: t.status,
      created_at: t.created_at,
      agent_code: t.agent_code,
    })));
  } catch {
    res.status(500).json({ error: 'failed to load history' });
  }
});

/* ========= ADMIN (lightweight) ========= */

// limits
app.get('/admin/limits', async (_req, res) => {
  try { res.json(await getLimits()); } catch { res.status(500).json({ error: 'failed' }); }
});
app.post('/admin/limits', async (req, res) => {
  try {
    const { min_stake, max_stake, max_payout } = req.body || {};
    await db.query('BEGIN');
    await db.query(`INSERT INTO settings(key,value) VALUES('min_stake',$1)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(min_stake)]);
    await db.query(`INSERT INTO settings(key,value) VALUES('max_stake',$1)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(max_stake)]);
    await db.query(`INSERT INTO settings(key,value) VALUES('max_payout',$1)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [String(max_payout)]);
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await db.query('ROLLBACK').catch(()=>{});
    res.status(400).json({ error: e.message || 'failed' });
  }
});

// agents
app.get('/admin/agents', async (_req, res) => {
  const r = await db.query('SELECT code,name,balance_cents,is_active FROM agents ORDER BY code');
  res.json(r.rows.map(a => ({ code:a.code, name:a.name, balance:(a.balance_cents||0)/100, is_active:a.is_active })));
});
app.post('/admin/agents', async (req, res) => {
  const { code, name, add_balance } = req.body||{};
  try{
    await db.query('BEGIN');
    await db.query(
      `INSERT INTO agents(code,name,balance_cents) VALUES($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name`,
      [code, name||code, Math.round(Number(add_balance||0)*100)]
    );
    if (add_balance) {
      await db.query('UPDATE agents SET balance_cents = balance_cents + $1 WHERE code=$2',
        [Math.round(Number(add_balance)*100), code]);
    }
    await db.query('COMMIT');
    res.json({ ok:true });
  }catch(e){
    await db.query('ROLLBACK').catch(()=>{});
    res.status(400).json({ error: e.message||'failed' });
  }
});

/* ========= AUTO-SETTLER (demo) =========
   Every 30s:
   - For any market whose parent start_time is in the past, pick ONE winning selection.
   - Then mark tickets 'won' if all its selections are winners, otherwise 'lost' once all are resulted.
*/
async function autoSettle() {
  try {
    // Mark one winner per eligible market
    await db.query(`
      WITH eligible AS (
        SELECT m.id AS market_id
        FROM markets m
        LEFT JOIN fixtures f ON f.id=m.fixture_id
        LEFT JOIN race_events re ON re.id=m.race_event_id
        LEFT JOIN color_draws cd ON cd.id=m.color_draw_id
        WHERE (
          (f.id IS NOT NULL AND f.start_time <= NOW())
          OR (re.id IS NOT NULL AND re.start_time <= NOW())
          OR (cd.id IS NOT NULL AND cd.start_time <= NOW())
        )
        AND NOT EXISTS (
          SELECT 1 FROM selections s WHERE s.market_id=m.id AND s.is_winner IS TRUE
        )
      )
      UPDATE selections s
      SET is_winner = TRUE, resulted_at = NOW()
      WHERE s.id IN (
        SELECT id FROM (
          SELECT s2.id,
                 ROW_NUMBER() OVER (PARTITION BY s2.market_id ORDER BY random()) AS rn
          FROM selections s2
          JOIN eligible e ON e.market_id=s2.market_id
        ) z WHERE z.rn=1
      );
    `);

    // Settle tickets that are fully resulted
    const toSettle = await db.query(`
      SELECT t.id
      FROM tickets t
      WHERE t.status='open'
        AND NOT EXISTS (
          SELECT 1
          FROM ticket_items ti
          JOIN selections s ON s.id=ti.selection_id
          WHERE ti.ticket_id=t.id AND s.is_winner IS NULL
        )
    `);

    for (const row of toSettle.rows) {
      const tid = row.id;
      const r = await db.query(`
        SELECT bool_and(s.is_winner) AS allwin
        FROM ticket_items ti
        JOIN selections s ON s.id=ti.selection_id
        WHERE ti.ticket_id=$1`, [tid]);
      const status = r.rows[0].allwin ? 'won' : 'lost';
      await db.query('UPDATE tickets SET status=$1 WHERE id=$2', [status, tid]);
    }
  } catch (_) {}
}
setInterval(autoSettle, 30000);

/* ========= START ========= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API on :${port}`));
