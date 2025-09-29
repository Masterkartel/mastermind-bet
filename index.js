// index.js — Mastermind Bet API with Auth (Admin / Agent / Cashier)
require('dotenv').config();
process.env.TZ = 'Africa/Nairobi'; // Nairobi time pinned

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(cookieParser());

// serve static
app.use(express.static(path.join(__dirname, 'public')));

// pretty routes (root -> POS)
app.get(/^\/pos\/?$/i,   (_, res) => res.sendFile(path.join(__dirname, 'public', 'pos.html')));
app.get(/^\/virtual\/?$/i, (_, res) => res.sendFile(path.join(__dirname, 'public', 'virtual.html')));
app.get(/^\/history\/?$/i, (_, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get(/^\/admin\/?$/i,   (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get(/^\/agent\/?$/i,   (_, res) => res.sendFile(path.join(__dirname, 'public', 'agent.html')));
app.get(/^\/dogs\/?$/i,    (_, res) => res.sendFile(path.join(__dirname, 'public', 'dogs.html')));
app.get(/^\/horses\/?$/i,  (_, res) => res.sendFile(path.join(__dirname, 'public', 'horses.html')));
app.get(/^\/colors\/?$/i,  (_, res) => res.sendFile(path.join(__dirname, 'public', 'colors.html')));
app.get('/',               (_, res) => res.sendFile(path.join(__dirname, 'public', 'pos.html')));

// health + Nairobi time
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/api/time', (_req, res) => {
  const now = new Date();
  res.json({ iso: now.toISOString(), tz: 'Africa/Nairobi', unix_ms: now.getTime() });
});

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

const SESSION_TTL_HOURS = 12;
function sessionExpiry() {
  return new Date(Date.now() + SESSION_TTL_HOURS*3600*1000);
}
async function createSession({ user_id, role, agent_code=null, cashier_id=null }) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires_at = sessionExpiry();
  await db.query(
    `INSERT INTO sessions(token,user_id,role,agent_code,cashier_id,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [token, user_id, role, agent_code, cashier_id, expires_at]
  );
  return { token, expires_at };
}

async function getSession(req) {
  const token = req.cookies && req.cookies.sid;
  if (!token) return null;
  const r = await db.query(
    `SELECT s.token,s.user_id,s.role,s.agent_code,s.cashier_id,s.expires_at,
            u.name, u.phone
     FROM sessions s
     LEFT JOIN users u ON u.id=s.user_id
     WHERE s.token=$1 AND s.expires_at > NOW()`,
    [token]
  );
  return r.rows[0] || null;
}

function requireRole(roles) {
  return async (req,res,next) => {
    const sess = await getSession(req);
    if (!sess || !roles.includes(sess.role)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.session = sess;
    next();
  };
}

/* ========= AUTH ========= */

// Admin login (phone + password)
app.post('/auth/admin/login', async (req, res) => {
  const { phone, password } = req.body || {};
  try {
    if (!phone || !password) return res.status(400).json({ error: 'phone/password required' });
    const r = await db.query(
      `SELECT id, role, phone, name
       FROM users
       WHERE role='admin' AND phone=$1 AND pass_hash = crypt($2, pass_hash) AND is_active=true`,
      [phone, password]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'invalid credentials' });

    const u = r.rows[0];
    const s = await createSession({ user_id: u.id, role: 'admin' });
    res.cookie('sid', s.token, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, role: 'admin', name: u.name, phone: u.phone });
  } catch (e) {
    res.status(400).json({ error: e.message || 'login failed' });
  }
});

// Agent login (phone + 6-digit PIN)
app.post('/auth/agent/login', async (req, res) => {
  const { phone, pin } = req.body || {};
  try {
    if (!phone || !pin) return res.status(400).json({ error: 'phone/pin required' });
    const ru = await db.query(
      `SELECT id, role, phone, name
       FROM users
       WHERE role='agent' AND phone=$1 AND pass_hash = crypt($2, pass_hash) AND is_active=true`,
      [phone, pin]
    );
    if (!ru.rows.length) return res.status(401).json({ error: 'invalid credentials' });

    // ensure agents row (code = phone)
    const code = phone;
    let ag = await db.query(`SELECT code FROM agents WHERE code=$1`, [code]);
    if (!ag.rows.length) {
      await db.query(
        `INSERT INTO agents(code,name,balance_cents,is_active,owner_user_id)
         VALUES($1,$2,0,true,$3)`,
        [code, ru.rows[0].name, ru.rows[0].id]
      );
    }
    const s = await createSession({ user_id: ru.rows[0].id, role: 'agent', agent_code: code });
    res.cookie('sid', s.token, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, role: 'agent', name: ru.rows[0].name, phone });
  } catch (e) {
    res.status(400).json({ error: e.message || 'login failed' });
  }
});

// Cashier login (agent_code + cashier name + PIN)
app.post('/auth/cashier/login', async (req, res) => {
  const { agent_code, name, pin } = req.body || {};
  try {
    if (!agent_code || !name || !pin) return res.status(400).json({ error: 'agent_code/name/pin required' });

    const r = await db.query(
      `SELECT c.id, c.name, c.agent_code
       FROM cashiers c
       WHERE c.agent_code=$1 AND c.name=$2
         AND c.is_active=true
         AND c.pin_hash = crypt($3, c.pin_hash)`,
      [agent_code, name, pin]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'invalid credentials' });

    const c = r.rows[0];
    const s = await createSession({
      user_id: 0, role: 'cashier', agent_code: c.agent_code, cashier_id: c.id
    });
    res.cookie('sid', s.token, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, role: 'cashier', name: c.name, agent_code: c.agent_code });
  } catch (e) {
    res.status(400).json({ error: e.message || 'login failed' });
  }
});

app.post('/auth/logout', async (req,res) => {
  const token = req.cookies && req.cookies.sid;
  if (token) await db.query(`DELETE FROM sessions WHERE token=$1`, [token]);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/me', async (req,res)=>{
  const s = await getSession(req);
  if (!s) return res.json(null);
  res.json({
    role: s.role,
    name: s.name || (s.role==='cashier' ? 'Cashier' : null),
    phone: s.phone || null,
    agent_code: s.agent_code || null,
    cashier_id: s.cashier_id || null,
  });
});

/* ========= ADMIN API ========= */

// Create/Reset Agent (admin only) — includes LOCATION
app.post('/admin/api/agents/create', requireRole(['admin']), async (req, res) => {
  const { phone, name, pin, location } = req.body || {};
  try{
    if (!phone || !/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'phone must be 10 digits' });
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!pin || !/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 6 digits' });

    await db.query('BEGIN');

    // upsert users row (role agent). Store PIN into pass_hash (used by /auth/agent/login).
    const u = await db.query(
      `INSERT INTO users(role,phone,name,pass_hash,is_active)
       VALUES('agent',$1,$2,crypt($3, gen_salt('bf',10)), true)
       ON CONFLICT (phone) DO UPDATE
       SET name=EXCLUDED.name,
           pass_hash=EXCLUDED.pass_hash,
           role='agent',
           is_active=true
       RETURNING id`, [phone, name, pin]
    );

    // ensure agents row (code = phone) with LOCATION
    await db.query(
      `INSERT INTO agents(code,name,location,balance_cents,is_active,owner_user_id)
       VALUES($1,$2,$3,0,true,$4)
       ON CONFLICT (code) DO UPDATE
       SET name=EXCLUDED.name,
           location=EXCLUDED.location,
           is_active=true`,
      [phone, name, location || null, u.rows[0].id]
    );

    await db.query('COMMIT');
    res.json({ ok:true });
  }catch(e){
    await db.query('ROLLBACK').catch(()=>{});
    res.status(400).json({ error: e.message||'failed' });
  }
});

// Reset agent PIN (default 000000) — Admin only
app.post('/admin/api/agents/reset-pin', requireRole(['admin']), async (req,res)=>{
  const { phone, new_pin } = req.body || {};
  try{
    if (!phone || !/^\d{10}$/.test(phone)) return res.status(400).json({ error:'phone must be 10 digits' });
    const pin = new_pin && /^\d{6}$/.test(new_pin) ? new_pin : '000000';
    await db.query(
      `UPDATE users SET pass_hash=crypt($2, gen_salt('bf',10))
       WHERE role='agent' AND phone=$1`,
      [phone, pin]
    );
    res.json({ ok:true, pin });
  }catch(e){
    res.status(400).json({ error: e.message||'failed' });
  }
});

// List agents (now includes location)
app.get('/admin/api/agents/list', requireRole(['admin']), async (_req,res)=>{
  const r = await db.query(
    `SELECT a.code AS phone, a.name, a.location, a.is_active, COALESCE(a.balance_cents,0) AS balance_cents
     FROM agents a ORDER BY a.code`
  );
  res.json(r.rows.map(x => ({
    phone: x.phone,
    name: x.name,
    location: x.location || '',
    is_active: x.is_active,
    balance: (x.balance_cents||0)/100
  })));
});

// Mint/Topup/Withdraw agent float
// POST /admin/api/agents/mint  { phone, amount, note? }  amount>0 add; amount<0 withdraw
app.post('/admin/api/agents/mint', requireRole(['admin']), async (req,res)=>{
  const { phone, amount, note } = req.body || {};
  try{
    const amtK = Number(amount);
    if (!phone || !/^\d{10}$/.test(phone)) return res.status(400).json({ error:'phone must be 10 digits' });
    if (!Number.isFinite(amtK) || amtK === 0) return res.status(400).json({ error:'amount must be non-zero number (KES)' });

    const delta = Math.round(amtK * 100); // to cents

    await db.query('BEGIN');
    const ar = await db.query(`SELECT id, balance_cents FROM agents WHERE code=$1 FOR UPDATE`, [phone]);
    if (!ar.rows.length) throw new Error('Agent not found');

    const cur = ar.rows[0].balance_cents || 0;
    const next = cur + delta;
    if (next < 0) throw new Error('Insufficient agent float');

    await db.query(`UPDATE agents SET balance_cents=$1 WHERE id=$2`, [next, ar.rows[0].id]);

    // Ledger
    await db.query(
      `INSERT INTO float_ledger(actor_role, actor_id, from_entity, to_entity, amount_cents, action, note)
       VALUES('admin',$1,$2,$3,$4,$5,$6)`,
      [
        req.session?.user_id || null,
        delta < 0 ? 'agent' : 'treasury',
        delta < 0 ? 'treasury' : 'agent',
        Math.abs(delta),
        (delta < 0 ? 'WITHDRAW' : 'MINT'),
        note || phone
      ]
    );

    await db.query('COMMIT');
    res.json({ ok:true, phone, new_balance_kes: next/100 });
  }catch(e){
    await db.query('ROLLBACK').catch(()=>{});
    res.status(400).json({ error: e.message||'failed' });
  }
});

/* ========= AGENT API ========= */

// Create cashier (agent only)
app.post('/agent/api/cashiers/create', requireRole(['agent']), async (req,res)=>{
  const { name, pin } = req.body || {};
  try{
    if (!name) return res.status(400).json({ error:'name required' });
    if (!pin || !/^\d{6}$/.test(pin)) return res.status(400).json({ error:'PIN must be 6 digits' });
    await db.query(
      `INSERT INTO cashiers(agent_code,name,pin_hash,is_active)
       VALUES($1,$2,crypt($3, gen_salt('bf',10)), true)`,
      [req.session.agent_code, name, pin]
    );
    res.json({ ok:true });
  }catch(e){
    res.status(400).json({ error: e.message||'failed' });
  }
});

app.get('/agent/api/cashiers', requireRole(['agent']), async (req,res)=>{
  const r = await db.query(
    `SELECT id,name,is_active,created_at FROM cashiers
     WHERE agent_code=$1 ORDER BY id DESC`,
    [req.session.agent_code]
  );
  res.json(r.rows);
});

app.post('/agent/api/cashiers/toggle', requireRole(['agent']), async (req,res)=>{
  const { cashier_id, enabled } = req.body || {};
  try{
    await db.query(
      `UPDATE cashiers SET is_active=$1
       WHERE id=$2 AND agent_code=$3`,
      [!!enabled, Number(cashier_id), req.session.agent_code]
    );
    res.json({ ok:true });
  }catch(e){
    res.status(400).json({ error: e.message||'failed' });
  }
});

/* ========= EXISTING BUSINESS (fixtures/races/colors/tickets etc.) ========= */

// competitions
app.get('/api/competitions', async (_req, res) => {
  try {
    const r = await db.query('SELECT id, code, name FROM competitions ORDER BY code');
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: 'failed to load competitions' });
  }
});

// fixtures
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

// races
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

// selections
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

/* ========= ADMIN limits ========= */
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

/* ========= TICKETS ========= */
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

    // agent check + balance (optional)
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

/* ========= AUTO-SETTLER ========= */
async function autoSettle() {
  try {
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
