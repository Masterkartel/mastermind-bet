// index.js — Mastermind Bet (float, tickets, cashier UI, odds, virtuals engine + auto-settle)
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const bwipjs = require('bwip-js');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---- limits (in cents) ----
const MIN_STAKE = parseInt(process.env.MIN_STAKE_CENTS || '2000', 10);   // 20 KES
const MAX_STAKE = 100000;   // 1,000 KES
const MAX_PAYOUT = 2000000; // 20,000 KES
const MIN_ODDS = 1.01;
const MAX_ODDS = 1000;

// --- helpers ---
async function withTxn(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  // base schema + safe alters
  const sql = `
  CREATE TABLE IF NOT EXISTS wallets (
    id BIGSERIAL PRIMARY KEY,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('house','agent','cashier')),
    owner_id   TEXT,
    currency   TEXT NOT NULL DEFAULT 'KES',
    balance_cents BIGINT NOT NULL DEFAULT 0,
    UNIQUE(owner_type, owner_id)
  );

  CREATE TABLE IF NOT EXISTS wallet_ledger (
    id BIGSERIAL PRIMARY KEY,
    wallet_id BIGINT NOT NULL REFERENCES wallets(id),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('credit','debit')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    balance_after_cents BIGINT NOT NULL,
    ref_type TEXT,
    ref_id   TEXT,
    memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS transfers (
    id BIGSERIAL PRIMARY KEY,
    from_wallet BIGINT REFERENCES wallets(id),
    to_wallet   BIGINT REFERENCES wallets(id),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    requested_by TEXT,
    approved_by  TEXT,
    memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id BIGSERIAL PRIMARY KEY,
    uid TEXT UNIQUE NOT NULL,
    cashier_id TEXT NOT NULL,
    stake_cents BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    potential_win_cents BIGINT,
    payout_cents BIGINT,
    odds NUMERIC(6,2),
    product_code TEXT,
    event_id BIGINT,
    market_code TEXT,
    selection_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
  );

  -- VIRTUALS
  CREATE TABLE IF NOT EXISTS virtual_products (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'internal',
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS virtual_events (
    id BIGSERIAL PRIMARY KEY,
    product_code TEXT NOT NULL REFERENCES virtual_products(code),
    provider_event_id TEXT NOT NULL,
    home_team TEXT,
    away_team TEXT,
    start_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN|CLOSED|RESULTED
    result_payload JSONB,
    UNIQUE(product_code, provider_event_id)
  );

  CREATE TABLE IF NOT EXISTS virtual_markets (
    id BIGSERIAL PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES virtual_events(id) ON DELETE CASCADE,
    market_code TEXT NOT NULL,            -- '1X2','GGNG','OU25','RACE_WIN'
    selection_code TEXT NOT NULL,         -- '1','X','2','GG','NG','OV','UN','#1'
    selection_name TEXT NOT NULL,
    odds NUMERIC(6,2) NOT NULL
  );

  -- seed wallets (demo)
  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'house', NULL, 'KES', 0
  WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE owner_type='house' AND owner_id IS NULL);

  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'agent', 'agent1', 'KES', 0
  WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE owner_type='agent' AND owner_id='agent1');

  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'cashier', 'cashier1', 'KES', 0
  WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE owner_type='cashier' AND owner_id='cashier1');

  -- seed products
  INSERT INTO virtual_products(code,name,sort_order)
  VALUES ('EPL','EPL',1),('DOGS','Dogs',2),('HORSES','Horses',3)
  ON CONFLICT (code) DO NOTHING;
  `;
  await pool.query(sql);

  // constraints
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tickets_stake_min_chk') THEN
        ALTER TABLE tickets ADD CONSTRAINT tickets_stake_min_chk CHECK (stake_cents >= 2000);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tickets_stake_max_chk') THEN
        ALTER TABLE tickets ADD CONSTRAINT tickets_stake_max_chk CHECK (stake_cents <= 100000);
      END IF;
    END$$;
  `);
}

async function getWallet(client, ownerType, ownerId=null) {
  const { rows } = await client.query(
    'SELECT * FROM wallets WHERE owner_type=$1 AND ((owner_id IS NULL AND $2::text IS NULL) OR owner_id=$2) FOR UPDATE',
    [ownerType, ownerId]
  );
  if (!rows[0]) {
    const ins = await client.query(
      'INSERT INTO wallets(owner_type, owner_id) VALUES ($1,$2) RETURNING *',
      [ownerType, ownerId]
    );
    return ins.rows[0];
  }
  return rows[0];
}

async function ledger(client, walletId, type, amount, refType, refId, memo) {
  const bal = await client.query('SELECT balance_cents FROM wallets WHERE id=$1', [walletId]);
  const after = bal.rows[0].balance_cents;
  await client.query(
    'INSERT INTO wallet_ledger(wallet_id,entry_type,amount_cents,balance_after_cents,ref_type,ref_id,memo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [walletId, type, amount, after, refType, refId, memo || null]
  );
}

// --- auth (header keys for now) ---
function needAdmin(req, res, next) {
  if (req.header('x-admin-key') === process.env.ADMIN_KEY) return next();
  return res.status(401).json({error:'admin key required'});
}
function needAgent(req, res, next) {
  if (req.header('x-agent-key') === process.env.AGENT_KEY) return next();
  return res.status(401).json({error:'agent key required'});
}
function needCashier(req, res, next) {
  if (req.header('x-cashier-key') === process.env.CASHIER_KEY) return next();
  return res.status(401).json({error:'cashier key required'});
}

// --- utils ---
function makeTicketUid() { return 'T' + crypto.randomBytes(6).toString('hex').toUpperCase(); }
const pick = (arr)=> arr[Math.floor(Math.random()*arr.length)];

// ========== CASHIER DASHBOARD / CORE ==========

app.get('/health', (_req, res)=> res.json({ok:true}));

// BALANCES
app.get('/balances', needAdmin, async (_req,res) => {
  const { rows } = await pool.query('SELECT owner_type, owner_id, balance_cents FROM wallets ORDER BY owner_type, owner_id');
  res.json(rows);
});

// LEDGER (admin)
app.get('/admin/ledger', needAdmin, async (_req,res)=>{
  const { rows } = await pool.query('SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

// CASHIER SUMMARY: float + today KPIs + limits
app.get('/cashier/summary', needCashier, async (_req, res) => {
  const cashierId = 'cashier1';
  const w = await pool.query(
    `SELECT balance_cents FROM wallets WHERE owner_type='cashier' AND owner_id=$1`,
    [cashierId]
  );
  const balance_cents = w.rows[0]?.balance_cents ?? 0;

  const k = await pool.query(`
    SELECT
      COALESCE(SUM(stake_cents),0) AS total_stake_cents,
      COALESCE(SUM(CASE WHEN status IN ('WON','CANCELLED') THEN payout_cents ELSE 0 END),0) AS total_payout_cents,
      COUNT(*) FILTER (WHERE status='PENDING')   AS pending_count,
      COUNT(*) FILTER (WHERE status='WON')       AS won_count,
      COUNT(*) FILTER (WHERE status='LOST')      AS lost_count,
      COUNT(*) FILTER (WHERE status='CANCELLED') AS cancelled_count
    FROM tickets
    WHERE cashier_id=$1 AND created_at::date = CURRENT_DATE;
  `,[cashierId]);

  const kp = k.rows[0] || {};
  res.json({
    balance_cents,
    limits: { min_stake_cents: MIN_STAKE, max_stake_cents: MAX_STAKE, max_payout_cents: MAX_PAYOUT },
    today: {
      total_stake_cents: Number(kp.total_stake_cents || 0),
      total_payout_cents: Number(kp.total_payout_cents || 0),
      pending_count: Number(kp.pending_count || 0),
      won_count: Number(kp.won_count || 0),
      lost_count: Number(kp.lost_count || 0),
      cancelled_count: Number(kp.cancelled_count || 0)
    }
  });
});

// CASHIER: list last 20 tickets (include odds)
app.get('/cashier/tickets', needCashier, async (_req, res) => {
  const cashierId = 'cashier1';
  const { rows } = await pool.query(
    `SELECT uid, stake_cents, potential_win_cents, odds, status, payout_cents, created_at
       FROM tickets
      WHERE cashier_id=$1
      ORDER BY created_at DESC
      LIMIT 20`,
    [cashierId]
  );
  res.json(rows);
});

// ====== VIRTUALS: PUBLIC CASHIER APIS ======

app.get('/virtual/products', async (_req,res)=>{
  const { rows } = await pool.query(`SELECT code,name,sort_order FROM virtual_products WHERE is_active=TRUE ORDER BY sort_order,code`);
  res.json(rows);
});

app.get('/virtual/events', async (req,res)=>{
  const product = req.query.product;
  if (!product) return res.status(400).json({error:'product required'});
  const { rows } = await pool.query(
    `SELECT id, product_code, provider_event_id, home_team, away_team, start_at, status
       FROM virtual_events
      WHERE product_code=$1 AND start_at > now() - interval '2 minutes'
      ORDER BY start_at ASC
      LIMIT 30`,
    [product]
  );
  res.json(rows);
});

app.get('/virtual/markets', async (req,res)=>{
  const eventId = parseInt(req.query.event_id,10);
  if (!eventId) return res.status(400).json({error:'event_id required'});
  const { rows } = await pool.query(
    `SELECT market_code, selection_code, selection_name, odds
       FROM virtual_markets
      WHERE event_id=$1
      ORDER BY market_code, selection_code`,
    [eventId]
  );
  res.json(rows);
});

// ========= PLACE BET =========
// Two flows:
// A) Virtuals: product_code+event_id+market_code+selection_code → use odds from DB
// B) Manual: no product/event → require odds param from client
app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  const hasVirtual = !!(req.body.product_code && req.body.event_id && req.body.market_code && req.body.selection_code);

  // Validate stake limits
  if (!Number.isFinite(stake) || stake < MIN_STAKE) {
    return res.status(400).json({error:`min stake ${MIN_STAKE} cents (KES ${MIN_STAKE/100})`});
  }
  if (stake > MAX_STAKE) {
    return res.status(400).json({error:`max stake ${MAX_STAKE/100} KES`});
  }

  await withTxn(async (client)=>{
    const cashier = await getWallet(client,'cashier','cashier1');
    // lock & check balance
    const w = await client.query('SELECT balance_cents FROM wallets WHERE id=$1 FOR UPDATE',[cashier.id]);
    if ((w.rows[0]?.balance_cents ?? 0) < stake) throw new Error('insufficient funds');

    let odds, potential, ticketUid = makeTicketUid();

    if (hasVirtual) {
      // confirm event is OPEN and selection exists
      const evq = await client.query(
        `SELECT id,status,start_at FROM virtual_events WHERE id=$1 FOR UPDATE`,
        [req.body.event_id]
      );
      const ev = evq.rows[0];
      if (!ev) throw new Error('virtual event not found');
      if (ev.status !== 'OPEN') throw new Error('event closed');

      const mq = await client.query(
        `SELECT odds FROM virtual_markets 
          WHERE event_id=$1 AND market_code=$2 AND selection_code=$3 LIMIT 1`,
        [ev.id, req.body.market_code, req.body.selection_code]
      );
      if (!mq.rows[0]) throw new Error('market/selection not available');
      odds = Number(mq.rows[0].odds);
      if (!Number.isFinite(odds) || odds < MIN_ODDS || odds > MAX_ODDS) throw new Error('invalid odds');

      potential = Math.floor(stake * odds);
      if (potential > MAX_PAYOUT) potential = MAX_PAYOUT;

      // reserve stake
      await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2',[stake, cashier.id]);
      await ledger(client, cashier.id, 'debit', stake, 'stake', ticketUid, 'stake reserved');

      await client.query(
        `INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents,odds,
                             product_code,event_id,market_code,selection_code)
         VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,$9)`,
        [ticketUid,'cashier1',stake,potential,odds,
         req.body.product_code, ev.id, req.body.market_code, req.body.selection_code]
      );

    } else {
      // manual odds path (legacy)
      odds = Number(req.body.odds);
      if (!Number.isFinite(odds) || odds < MIN_ODDS || odds > MAX_ODDS) {
        throw new Error(`odds must be between ${MIN_ODDS} and ${MAX_ODDS}`);
      }
      potential = Math.floor(stake * odds);
      if (potential > MAX_PAYOUT) potential = MAX_PAYOUT;

      await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2',[stake, cashier.id]);
      await ledger(client, cashier.id, 'debit', stake, 'stake', ticketUid, 'stake reserved');

      await client.query(
        `INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents,odds)
         VALUES ($1,$2,$3,'PENDING',$4,$5)`,
        [ticketUid,'cashier1',stake,potential,odds]
      );
    }

    res.json({ ok:true, ticket_uid: ticketUid, stake_cents: stake, odds, potential_win_cents: potential, max_payout_cents: MAX_PAYOUT });
  }).catch(e=> res.status(400).json({error:e.message}));
});

// ADMIN: settle ticket manually (still available)
app.post('/admin/settle-ticket', needAdmin, async (req,res)=>{
  const { uid, outcome } = req.body; // WON | LOST | CANCELLED
  if (!uid || !['WON','LOST','CANCELLED'].includes(outcome)) {
    return res.status(400).json({error:'uid + outcome required (WON|LOST|CANCELLED)'});
  }

  await withTxn(async (client)=>{
    const { rows } = await client.query('SELECT * FROM tickets WHERE uid=$1 FOR UPDATE',[uid]);
    if (!rows[0]) throw new Error('ticket not found');
    const t = rows[0];
    if (t.status !== 'PENDING') throw new Error('already settled');

    const cashier = await getWallet(client,'cashier',t.cashier_id);
    let payout = 0;

    if (outcome === 'WON') {
      const basePotential = t.potential_win_cents ?? Math.floor(t.stake_cents * (Number(t.odds)||2));
      payout = Math.min(basePotential, MAX_PAYOUT);
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'payout',uid,'ticket won');
    } else if (outcome === 'CANCELLED') {
      payout = t.stake_cents; // refund stake
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'refund',uid,'ticket cancelled');
    }

    await client.query(
      'UPDATE tickets SET status=$1, payout_cents=$2, settled_at=now() WHERE id=$3',
      [outcome, payout, t.id]
    );
  }).then(()=> res.json({ok:true, uid, outcome}))
    .catch(e=> res.status(400).json({error:e.message}));
});

// TICKETS: get one
app.get('/tickets/:uid', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).json({ error: 'ticket not found' });
  res.json(rows[0]);
});

// --- BARCODE PNG
app.get('/tickets/:uid/barcode.png', async (req, res) => {
  const { uid } = req.params;
  try {
    const png = await bwipjs.toBuffer({
      bcid: 'code128', text: uid, scale: 3, height: 10, includetext: true, textxalign: 'center'
    });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(400).json({ error: 'barcode failed' });
  }
});

// --- Printable Ticket (shows ODDS)
app.get('/tickets/:uid/print', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).send('Ticket not found');
  const t = rows[0];
  const color = t.status==='WON'?'#16a34a':(t.status==='LOST'?'#dc2626':'#6b7280');

  res.set('Content-Type', 'text/html');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Ticket ${t.uid}</title>
<style>
body{font-family:system-ui,Arial,sans-serif;padding:16px}
.card{width:360px;border:1px solid #e5e7eb;border-radius:12px;padding:16px;position:relative;overflow:hidden}
.row{display:flex;justify-content:space-between;margin:6px 0}
.bar{margin:12px auto;text-align:center}
.wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:52px;opacity:0.12;color:${color};transform:rotate(-18deg)}
.badge{display:inline-block;padding:4px 10px;border-radius:9999px;color:white;background:${color}}
.muted{color:#6b7280}
</style></head>
<body>
<div class="card">
  <div class="wm">${t.status}</div>
  <div class="row"><div><strong>Mastermind Bet</strong></div><div class="badge">${t.status}</div></div>
  <div class="row"><div class="muted">Ticket</div><div>${t.uid}</div></div>
  ${t.product_code ? `<div class="row"><div class="muted">Game</div><div>${t.product_code} • ${t.market_code}/${t.selection_code}</div></div>`:''}
  <div class="row"><div class="muted">Cashier</div><div>${t.cashier_id}</div></div>
  <div class="row"><div class="muted">Odds</div><div>${t.odds ? Number(t.odds).toFixed(2) : '—'}</div></div>
  <div class="row"><div class="muted">Stake</div><div>KES ${(t.stake_cents/100).toFixed(0)}</div></div>
  <div class="row"><div class="muted">Potential Win</div><div>KES ${((t.potential_win_cents||0)/100).toFixed(0)}</div></div>
  <div class="row"><div class="muted">Payout</div><div>KES ${((t.payout_cents||0)/100).toFixed(0)}</div></div>
  <div class="bar"><img src="/tickets/${t.uid}/barcode.png" alt="barcode"/></div>
  <div class="muted" style="text-align:center;font-size:12px">Verify: mastermind-bet.com/tickets/${t.uid}</div>
</div>
<script>window.print()</script>
</body></html>`);
});

// --- Cashier Dashboard / POS (kept minimal; your earlier fancy dashboard still works)
app.get('/pos', (_req, res) => {
  res.set('Content-Type','text/html');
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><title>Mastermind Cashier</title>
<style>
  :root{--line:#e5e7eb;--ok:#16a34a;--bad:#dc2626;--muted:#6b7280}
  body{font-family:system-ui,Arial;padding:16px;max-width:980px;margin:auto}
  input,button{padding:10px;font-size:16px}
  .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
  .card{border:1px solid var(--line);border-radius:12px;padding:12px}
  .k{font-size:13px;color:var(--muted)} .v{font-size:22px;font-weight:800}
  .row{display:flex;gap:8px;margin:12px 0}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border:1px solid var(--line);padding:8px;font-size:14px;text-align:center}
  .won{color:var(--ok);font-weight:700} .lost{color:var(--bad);font-weight:700} .cancel{color:#6b7280;font-weight:700}
  @media (max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:600px){.grid{grid-template-columns:1fr}}
  .pill{display:inline-block;background:#111827;color:#fff;border-radius:999px;padding:4px 10px;font-size:12px}
</style></head>
<body>
  <h2>Cashier Dashboard</h2>
  <div style="color:#6b7280;font-size:12px">Enter your <b>x-cashier-key</b> then use the controls.</div>
  <div class="row"><input id="key" placeholder="x-cashier-key" style="flex:1"/></div>

  <div class="grid" id="cards">
    <div class="card"><div class="k">Float Balance</div><div class="v" id="bal">KES 0</div></div>
    <div class="card"><div class="k">Today Stake</div><div class="v" id="tstake">KES 0</div></div>
    <div class="card"><div class="k">Today Payouts</div><div class="v" id="tpayout">KES 0</div></div>
    <div class="card"><div class="k">Pending / Won / Lost</div><div class="v"><span id="p">0</span> / <span id="w">0</span> / <span id="l">0</span></div></div>
  </div>

  <div class="card" style="margin-top:12px;">
    <div class="k">Limits</div>
    <div class="v" id="limits">Min 20 · Max 1000 · Max Payout 20000</div>
  </div>

  <h3 style="margin-top:18px;">Place Manual Bet</h3>
  <div class="row">
    <input id="stake" type="number" placeholder="Stake KES (min 20, max 1000)" />
    <input id="odds"  type="number" step="0.01" placeholder="Odds (e.g. 1.80)" />
    <button onclick="placeManual()">Place</button>
  </div>
  <div id="msg" style="color:#6b7280;font-size:12px"></div>

  <h3 style="margin-top:24px;">Virtual Games</h3>
  <div id="v-products" style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-bottom:10px;"></div>
  <div id="v-events" style="overflow:auto;white-space:nowrap;border:1px solid #e5e7eb;border-radius:8px;padding:6px 8px;"></div>
  <table id="v-odds"><thead>
    <tr><th>#</th><th>HOME</th><th>AWAY</th><th>1</th><th>X</th><th>2</th><th>GG</th><th>NG</th><th>OV2.5</th><th>UN2.5</th></tr>
  </thead><tbody></tbody></table>

  <h3 style="margin-top:18px;">Recent Tickets</h3>
  <button onclick="loadTickets()">Refresh</button>
  <table id="t"><thead><tr><th>UID</th><th>Stake</th><th>Odds</th><th>Status</th><th>Print</th></tr></thead><tbody></tbody></table>

<script>
function fmtKES(c){ return 'KES '+(Math.round((c||0)/100)).toLocaleString(); }
async function loadSummary(){
  const key = document.getElementById('key').value.trim(); if(!key) return;
  const j = await (await fetch('/cashier/summary',{headers:{'x-cashier-key':key}})).json();
  if(j.error){ document.getElementById('msg').textContent=j.error; return; }
  document.getElementById('bal').textContent = fmtKES(j.balance_cents);
  document.getElementById('tstake').textContent = fmtKES(j.today.total_stake_cents);
  document.getElementById('tpayout').textContent = fmtKES(j.today.total_payout_cents);
  document.getElementById('p').textContent = j.today.pending_count;
  document.getElementById('w').textContent = j.today.won_count;
  document.getElementById('l').textContent = j.today.lost_count;
  document.getElementById('limits').textContent = \`Min \${Math.round(j.limits.min_stake_cents/100)} · Max \${Math.round(j.limits.max_stake_cents/100)} · Max Payout \${Math.round(j.limits.max_payout_cents/100)}\`;
}
async function placeManual(){
  const key = document.getElementById('key').value.trim();
  const stakeKES = parseInt(document.getElementById('stake').value||'0',10);
  const odds = Number(document.getElementById('odds').value||'0');
  const res = await fetch('/bets/place',{method:'POST',headers:{'Content-Type':'application/json','x-cashier-key':key},body:JSON.stringify({stake_cents:stakeKES*100,odds})});
  const data = await res.json(); document.getElementById('msg').textContent = JSON.stringify(data);
  await loadSummary(); await loadTickets();
}
async function loadTickets(){
  const key = document.getElementById('key').value.trim();
  const rows = await (await fetch('/cashier/tickets',{headers:{'x-cashier-key':key}})).json();
  const tb = document.querySelector('#t tbody'); tb.innerHTML='';
  (rows||[]).forEach(r=>{
    const tr = document.createElement('tr');
    const cls = r.status==='WON'?'won':(r.status==='LOST'?'lost':'cancel');
    tr.innerHTML = \`<td>\${r.uid}</td><td>\${fmtKES(r.stake_cents)}</td><td>\${r.odds?Number(r.odds).toFixed(2):'—'}</td><td class="\${cls}">\${r.status}</td><td><a href="/tickets/\${r.uid}/print" target="_blank">Print</a></td>\`;
    tb.appendChild(tr);
  });
}
async function vInit(){
  const p = await (await fetch('/virtual/products')).json();
  const c = document.getElementById('v-products'); c.innerHTML='';
  p.forEach(prod=>{
    const d = document.createElement('button');
    d.textContent = prod.name;
    d.style='padding:10px;border:1px solid #e5e7eb;border-radius:8px;background:#111827;color:#fff;font-weight:700';
    d.onclick = ()=> vLoadEvents(prod.code);
    c.appendChild(d);
  });
}
async function vLoadEvents(code){
  const evs = await (await fetch('/virtual/events?product='+encodeURIComponent(code))).json();
  const strip = document.getElementById('v-events'); strip.innerHTML='';
  evs.forEach(e=>{
    const b=document.createElement('button');
    b.textContent=(e.home_team||'HOME')+' vs '+(e.away_team||'AWAY')+' @ '+new Date(e.start_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    b.style='margin-right:8px;padding:6px 10px;border:1px solid #e5e7eb;border-radius:9999px';
    b.onclick=()=>vShowOdds(e);
    strip.appendChild(b);
  });
  if(evs[0]) vShowOdds(evs[0]);
}
async function vShowOdds(e){
  const data = await (await fetch('/virtual/markets?event_id='+e.id)).json();
  const tb = document.querySelector('#v-odds tbody'); tb.innerHTML='';
  const get = (m,s)=> data.find(x=>x.market_code===m && x.selection_code===s)?.odds;
  const row = document.createElement('tr');
  row.innerHTML = \`
    <td>1</td><td>\${e.home_team||'HOME'}</td><td>\${e.away_team||'AWAY'}</td>
    \${['1','X','2'].map(k=> '<td style="cursor:pointer" onclick="vPick('+e.id+',\\'1X2\\',\\''+k+'\\',\\''+e.product_code+'\\')">'+(get('1X2',k)?.toFixed(2)||'-')+'</td>').join('')}
    \${['GG','NG'].map(k=> '<td style="cursor:pointer" onclick="vPick('+e.id+',\\'GGNG\\',\\''+k+'\\',\\''+e.product_code+'\\')">'+(get('GGNG',k)?.toFixed(2)||'-')+'</td>').join('')}
    \${['OV','UN'].map(k=> '<td style="cursor:pointer" onclick="vPick('+e.id+',\\'OU25\\',\\''+k+'\\',\\''+e.product_code+'\\')">'+(get('OU25',k)?.toFixed(2)||'-')+'</td>').join('')}
  \`;
  tb.appendChild(row);
}
async function vPick(eventId,market,sel,product){
  const key=document.getElementById('key').value.trim();
  const stakeKES = Number(prompt('Stake KES (20-1000):','50')||'0');
  if(!stakeKES) return;
  const res = await fetch('/bets/place',{method:'POST',headers:{'Content-Type':'application/json','x-cashier-key':key},body:JSON.stringify({
    product_code:product,event_id:eventId,market_code:market,selection_code:sel,stake_cents:stakeKES*100
  })});
  const data = await res.json(); alert(JSON.stringify(data)); loadTickets(); loadSummary();
}
document.getElementById('key').addEventListener('change',()=>{ loadSummary(); loadTickets(); });
vInit();
</script>
</body></html>`);
});

// ========== VIRTUALS ENGINE (internal RNG) ==========
// Creates events, sets odds, results, and auto-settles tickets.

const TEAMS = ['AEK','LIV','PSV','BAR','ROM','FCB','MCI','PSG','RMA','JUV','NAP','CHE','CEL','BEN','ZEN','BVB','MAR','ATM','BAS','MUN'];

function makeOdds3Way() {
  // random probabilities with small house margin
  let a = Math.random(), b = Math.random(), c = Math.random();
  const sum = a+b+c;
  a/=sum; b/=sum; c/=sum;
  const margin = 1.08; // 8% margin
  return [
    Math.max(1.15, (margin/a)), // 1
    Math.max(1.15, (margin/b)), // X
    Math.max(1.15, (margin/c))  // 2
  ].map(v => Math.round(v*100)/100);
}
function makeOddsYesNo() {
  let a = Math.random(), b = Math.random(); const sum=a+b; a/=sum; b/=sum;
  const margin = 1.06;
  return [
    Math.max(1.10, (margin/a)), // YES/GG or OV
    Math.max(1.10, (margin/b))  // NO/NG or UN
  ].map(v => Math.round(v*100)/100);
}
async function createFootballEvent(productCode, startInSec=90){
  const home = pick(TEAMS), away = pick(TEAMS.filter(t=>t!==home));
  const provider_event_id = crypto.randomBytes(4).toString('hex');
  const start_at = new Date(Date.now()+startInSec*1000).toISOString();
  const ev = await pool.query(
    `INSERT INTO virtual_events(product_code,provider_event_id,home_team,away_team,start_at,status)
     VALUES ($1,$2,$3,$4,$5,'OPEN') RETURNING id`,
    [productCode, provider_event_id, home, away, start_at]
  );
  const eventId = ev.rows[0].id;
  const [o1,oX,o2] = makeOdds3Way();
  const [gg,ng]   = makeOddsYesNo();
  const [ov,un]   = makeOddsYesNo();

  await pool.query(
    `INSERT INTO virtual_markets(event_id,market_code,selection_code,selection_name,odds) VALUES
     ($1,'1X2','1','Home', $2),($1,'1X2','X','Draw',$3),($1,'1X2','2','Away',$4),
     ($1,'GGNG','GG','Both Teams Score',$5),($1,'GGNG','NG','No Goal',$6),
     ($1,'OU25','OV','Over 2.5',$7),($1,'OU25','UN','Under 2.5',$8)`,
    [eventId,o1,oX,o2,gg,ng,ov,un]
  );
}
async function createRaceEvent(productCode, startInSec=60){
  const provider_event_id = crypto.randomBytes(4).toString('hex');
  const start_at = new Date(Date.now()+startInSec*1000).toISOString();
  const ev = await pool.query(
    `INSERT INTO virtual_events(product_code,provider_event_id,start_at,status)
     VALUES ($1,$2,$3,'OPEN') RETURNING id`,
    [productCode, provider_event_id, start_at]
  );
  const eventId = ev.rows[0].id;
  // 8 runners with random odds (win market only)
  const runners = Array.from({length:8}, (_,i)=> '#'+(i+1));
  // make normalized probabilities then convert to odds with margin
  let probs = runners.map(()=> Math.random());
  const sum = probs.reduce((a,b)=>a+b,0); probs = probs.map(p=>p/sum);
  const margin = 1.15;
  for (let i=0;i<runners.length;i++){
    const o = Math.max(1.10, margin / probs[i]);
    await pool.query(
      `INSERT INTO virtual_markets(event_id,market_code,selection_code,selection_name,odds)
       VALUES ($1,'RACE_WIN',$2,$2,$3)`,
      [eventId, runners[i], Math.round(o*100)/100]
    );
  }
}
async function closeAndResultEvents(){
  // Close events that started
  await pool.query(`UPDATE virtual_events SET status='CLOSED' WHERE status='OPEN' AND start_at <= now()`);

  // Result events that are closed for > 10s
  const { rows } = await pool.query(
    `SELECT * FROM virtual_events WHERE status='CLOSED' AND start_at <= now() - interval '10 seconds' LIMIT 50`
  );
  for (const ev of rows) {
    if (ev.product_code==='EPL') {
      // generate football score
      const gh = Math.random()<0.5?0:(Math.random()<0.5?1:2) + (Math.random()<0.2?1:0);
      const ga = Math.random()<0.5?0:(Math.random()<0.5?1:2) + (Math.random()<0.2?1:0);
      const res = {home:ev.home_team, away:ev.away_team, score:`${gh}-${ga}`};
      await pool.query(`UPDATE virtual_events SET status='RESULTED', result_payload=$2 WHERE id=$1`, [ev.id, res]);
      await settleFootball(ev.id, gh, ga);
    } else {
      // race: pick random winner
      const { rows: mk } = await pool.query(`SELECT selection_code FROM virtual_markets WHERE event_id=$1 AND market_code='RACE_WIN'`, [ev.id]);
      const winner = pick(mk.map(x=>x.selection_code));
      const res = {winner};
      await pool.query(`UPDATE virtual_events SET status='RESULTED', result_payload=$2 WHERE id=$1`, [ev.id, res]);
      await settleRaceWin(ev.id, winner);
    }
  }
}
async function settleFootball(eventId, gh, ga){
  // fetch tickets
  const { rows: tks } = await pool.query(`SELECT * FROM tickets WHERE status='PENDING' AND event_id=$1`, [eventId]);
  for (const t of tks) {
    let outcome = 'LOST';
    if (t.market_code==='1X2') {
      const r = gh>ga?'1':(gh<ga?'2':'X');
      if (t.selection_code===r) outcome='WON';
    } else if (t.market_code==='GGNG') {
      const r = (gh>0 && ga>0)?'GG':'NG';
      if (t.selection_code===r) outcome='WON';
    } else if (t.market_code==='OU25') {
      const tot = gh+ga; const r = tot>2?'OV':'UN';
      if (t.selection_code===r) outcome='WON';
    }
    await settleTicketByOutcome(t, outcome);
  }
}
async function settleRaceWin(eventId, winner){
  const { rows: tks } = await pool.query(`SELECT * FROM tickets WHERE status='PENDING' AND event_id=$1`, [eventId]);
  for (const t of tks) {
    const outcome = (t.market_code==='RACE_WIN' && t.selection_code===winner) ? 'WON' : 'LOST';
    await settleTicketByOutcome(t, outcome);
  }
}
async function settleTicketByOutcome(t, outcome){
  await withTxn(async (client)=>{
    const cashier = await getWallet(client,'cashier',t.cashier_id);
    let payout = 0;
    if (outcome==='WON') {
      const base = t.potential_win_cents ?? Math.floor(t.stake_cents * (Number(t.odds)||2));
      payout = Math.min(base, MAX_PAYOUT);
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'payout',t.uid,'auto-settle win');
    } else if (outcome==='CANCELLED') {
      payout = t.stake_cents;
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'refund',t.uid,'auto-settle cancel');
    }
    await client.query(`UPDATE tickets SET status=$1, payout_cents=$2, settled_at=now() WHERE id=$3`,
      [outcome, payout, t.id]);
  });
}

// scheduler: every 15s create upcoming events; every 5s close/result & settle
async function schedulerTick(){
  // ensure we have a few upcoming events per product
  const { rows: prods } = await pool.query(`SELECT code FROM virtual_products WHERE is_active=TRUE ORDER BY sort_order`);
  for (const p of prods) {
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM virtual_events WHERE product_code=$1 AND start_at > now() AND status='OPEN'`,
      [p.code]
    );
    if (cnt[0].n < 5) {
      if (p.code==='EPL') await createFootballEvent('EPL', 60 + Math.floor(Math.random()*60));
      else await createRaceEvent(p.code, 45 + Math.floor(Math.random()*45));
    }
  }
  await closeAndResultEvents();
}
setInterval(()=> schedulerTick().catch(console.error), 5000);

// start
migrate()
  .then(()=> app.listen(3000, ()=> console.log('App on :3000')))
  .catch(err=> { console.error(err); process.exit(1); });
