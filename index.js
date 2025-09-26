// index.js — float engine + tickets + ledger + settle + limits + barcode/print/POS + odds + cashier dashboard
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
  );

  -- seed example wallets
  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'house', NULL, 'KES', 0
  WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE owner_type='house' AND owner_id IS NULL);

  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'agent', 'agent1', 'KES', 0
  WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE owner_type='agent' AND owner_id='agent1');

  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'cashier', 'cashier1', 'KES', 0
  WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE owner_type='cashier' AND owner_id='cashier1');
  `;
  await pool.query(sql);

  // Ensure odds column exists (for older DBs)
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS odds NUMERIC(6,2);`);

  // Add stake constraints safely (skip if already exist)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tickets_stake_min_chk'
      ) THEN
        ALTER TABLE tickets ADD CONSTRAINT tickets_stake_min_chk CHECK (stake_cents >= 2000);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tickets_stake_max_chk'
      ) THEN
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
function makeTicketUid() {
  return 'T' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

// --- endpoints ---
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
    `SELECT balance_cents
       FROM wallets
      WHERE owner_type='cashier' AND owner_id=$1`,
    [cashierId]
  );
  const balance_cents = w.rows[0]?.balance_cents ?? 0;

  const todaySql = `
    SELECT
      COALESCE(SUM(stake_cents),0) AS total_stake_cents,
      COALESCE(SUM(CASE WHEN status IN ('WON','CANCELLED') THEN payout_cents ELSE 0 END),0) AS total_payout_cents,
      COUNT(*) FILTER (WHERE status='PENDING')   AS pending_count,
      COUNT(*) FILTER (WHERE status='WON')       AS won_count,
      COUNT(*) FILTER (WHERE status='LOST')      AS lost_count,
      COUNT(*) FILTER (WHERE status='CANCELLED') AS cancelled_count
    FROM tickets
    WHERE cashier_id=$1
      AND created_at::date = CURRENT_DATE;
  `;
  const k = await pool.query(todaySql, [cashierId]);
  const kp = k.rows[0] || {};

  res.json({
    balance_cents,
    limits: {
      min_stake_cents: MIN_STAKE,
      max_stake_cents: MAX_STAKE,
      max_payout_cents: MAX_PAYOUT
    },
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

// CASHIER: place bet with stake limits + ODDS-based potential_win (capped)
app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  const odds  = Number(req.body.odds); // required

  // Validate stake limits (KES 20..1000)
  if (!Number.isFinite(stake) || stake < MIN_STAKE) {
    return res.status(400).json({error:`min stake ${MIN_STAKE} cents (KES ${MIN_STAKE/100})`});
  }
  if (stake > MAX_STAKE) {
    return res.status(400).json({error:`max stake ${MAX_STAKE/100} KES`});
  }

  // Validate odds (sane range)
  if (!Number.isFinite(odds) || odds < MIN_ODDS || odds > MAX_ODDS) {
    return res.status(400).json({error:`odds must be between ${MIN_ODDS} and ${MAX_ODDS}`});
  }

  await withTxn(async (client)=>{
    const cashier = await getWallet(client,'cashier','cashier1');

    // lock & check balance
    const w = await client.query('SELECT balance_cents FROM wallets WHERE id=$1 FOR UPDATE',[cashier.id]);
    if ((w.rows[0]?.balance_cents ?? 0) < stake) throw new Error('insufficient funds');

    // reserve stake
    await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2',[stake, cashier.id]);
    const ticketUid = makeTicketUid();
    await ledger(client, cashier.id, 'debit', stake, 'stake', ticketUid, 'stake reserved');

    // potential win = stake * odds, capped at MAX_PAYOUT (20,000 KES)
    let potential = Math.floor(stake * odds);
    if (potential > MAX_PAYOUT) potential = MAX_PAYOUT;

    await client.query(
      'INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents,odds) VALUES ($1,$2,$3,$4,$5,$6)',
      [ticketUid, 'cashier1', stake, 'PENDING', potential, odds]
    );

    res.json({
      ok:true,
      ticket_uid: ticketUid,
      stake_cents: stake,
      odds,
      potential_win_cents: potential,
      max_payout_cents: MAX_PAYOUT
    });
  }).catch(e=> res.status(400).json({error:e.message}));
});

// ADMIN: settle ticket (WON/LOST/CANCELLED) with payout cap
app.post('/admin/settle-ticket', needAdmin, async (req,res)=>{
  const { uid, outcome } = req.body; // outcome = WON | LOST | CANCELLED
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
    // LOST → payout stays 0

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

// --- BARCODE PNG for a ticket UID
app.get('/tickets/:uid/barcode.png', async (req, res) => {
  const { uid } = req.params;
  try {
    const png = await bwipjs.toBuffer({
      bcid: 'code128',
      text: uid,
      scale: 3,
      height: 10,
      includetext: true,
      textxalign: 'center'
    });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(400).json({ error: 'barcode failed' });
  }
});

// --- Printable Ticket page with watermark color by status (shows ODDS)
app.get('/tickets/:uid/print', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).send('Ticket not found');

  const t = rows[0];
  const color =
    t.status === 'WON' ? '#16a34a' :
    t.status === 'LOST' ? '#dc2626' :
    '#6b7280'; // PENDING/CANCELLED grey

  res.set('Content-Type', 'text/html');
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Ticket ${t.uid}</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;padding:16px}
  .card{width:360px;border:1px solid #e5e7eb;border-radius:12px;padding:16px;position:relative;overflow:hidden}
  .row{display:flex;justify-content:space-between;margin:6px 0}
  .bar{margin:12px auto;text-align:center}
  .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      font-weight:800;font-size:52px;opacity:0.12;color:${color};transform:rotate(-18deg)}
  .badge{display:inline-block;padding:4px 10px;border-radius:9999px;color:white;background:${color}}
  .muted{color:#6b7280}
</style>
</head>
<body>
  <div class="card">
    <div class="wm">${t.status}</div>
    <div class="row"><div><strong>Mastermind Bet</strong></div><div class="badge">${t.status}</div></div>
    <div class="row"><div class="muted">Ticket</div><div>${t.uid}</div></div>
    <div class="row"><div class="muted">Cashier</div><div>${t.cashier_id}</div></div>
    <div class="row"><div class="muted">Odds</div><div>${t.odds ? Number(t.odds).toFixed(2) : '—'}</div></div>
    <div class="row"><div class="muted">Stake</div><div>KES ${(t.stake_cents/100).toFixed(0)}</div></div>
    <div class="row"><div class="muted">Potential Win</div><div>KES ${((t.potential_win_cents||0)/100).toFixed(0)}</div></div>
    <div class="row"><div class="muted">Payout</div><div>KES ${((t.payout_cents||0)/100).toFixed(0)}</div></div>
    <div class="bar">
      <img src="/tickets/${t.uid}/barcode.png" alt="barcode"/>
    </div>
    <div class="muted" style="text-align:center;font-size:12px">Verify: mastermind-bet.com/tickets/${t.uid}</div>
  </div>
  <script>window.print()</script>
</body>
</html>`);
});

// --- Cashier Dashboard / POS
app.get('/pos', (_req, res) => {
  res.set('Content-Type','text/html');
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Mastermind Cashier</title>
<style>
  :root{--line:#e5e7eb;--ok:#16a34a;--bad:#dc2626;--muted:#6b7280}
  body{font-family:system-ui,Arial;padding:16px;max-width:980px;margin:auto}
  input,button{padding:10px;font-size:16px}
  .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
  .card{border:1px solid var(--line);border-radius:12px;padding:12px}
  .k{font-size:13px;color:var(--muted)}
  .v{font-size:22px;font-weight:800}
  .row{display:flex;gap:8px;margin:12px 0}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border:1px solid var(--line);padding:8px;font-size:14px}
  .won{color:var(--ok);font-weight:700}
  .lost{color:var(--bad);font-weight:700}
  .cancel{color:#6b7280;font-weight:700}
  @media (max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:600px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
  <h2>Cashier Dashboard</h2>
  <div style="color:#6b7280;font-size:12px">Enter your <b>x-cashier-key</b> then use the controls.</div>
  <div class="row"><input id="key" placeholder="x-cashier-key" style="flex:1"/></div>

  <!-- KPI CARDS -->
  <div class="grid" id="cards">
    <div class="card"><div class="k">Float Balance</div><div class="v" id="bal">KES 0</div></div>
    <div class="card"><div class="k">Today Stake</div><div class="v" id="tstake">KES 0</div></div>
    <div class="card"><div class="k">Today Payouts</div><div class="v" id="tpayout">KES 0</div></div>
    <div class="card"><div class="k">Pending / Won / Lost</div><div class="v"><span id="p">0</span> / <span id="w">0</span> / <span id="l">0</span></div></div>
  </div>

  <!-- LIMITS -->
  <div class="card" style="margin-top:12px;">
    <div class="k">Limits</div>
    <div class="v" id="limits">Min 20 · Max 1000 · Max Payout 20000</div>
  </div>

  <!-- PLACE BET -->
  <h3 style="margin-top:18px;">Place Bet</h3>
  <div class="row">
    <input id="stake" type="number" placeholder="Stake KES (min 20, max 1000)" />
    <input id="odds"  type="number" step="0.01" placeholder="Odds (e.g. 1.80)" />
    <button onclick="placeBet()">Place</button>
  </div>
  <div id="msg" style="color:#6b7280;font-size:12px"></div>

  <!-- TICKETS -->
  <h3 style="margin-top:18px;">Recent Tickets</h3>
  <button onclick="loadTickets()">Refresh</button>
  <table id="t">
    <thead><tr><th>UID</th><th>Stake</th><th>Odds</th><th>Status</th><th>Print</th></tr></thead>
    <tbody></tbody>
  </table>

<script>
function fmtKES(cents){ return 'KES '+(Math.round((cents||0)/100)).toLocaleString(); }

async function loadSummary(){
  const key = document.getElementById('key').value.trim();
  if(!key) return;
  const res = await fetch('/cashier/summary',{headers:{'x-cashier-key':key}});
  const j = await res.json();
  if(j.error){ document.getElementById('msg').textContent = j.error; return; }
  document.getElementById('bal').textContent = fmtKES(j.balance_cents);
  document.getElementById('tstake').textContent = fmtKES(j.today.total_stake_cents);
  document.getElementById('tpayout').textContent = fmtKES(j.today.total_payout_cents);
  document.getElementById('p').textContent = j.today.pending_count;
  document.getElementById('w').textContent = j.today.won_count;
  document.getElementById('l').textContent = j.today.lost_count;
  const lim = j.limits;
  document.getElementById('limits').textContent =
    \`Min \${Math.round(lim.min_stake_cents/100)} · Max \${Math.round(lim.max_stake_cents/100)} · Max Payout \${Math.round(lim.max_payout_cents/100)}\`;
}

async function placeBet(){
  const key = document.getElementById('key').value.trim();
  const stakeKES = parseInt(document.getElementById('stake').value||'0',10);
  const odds = Number(document.getElementById('odds').value||'0');
  const stake_cents = stakeKES*100;
  const res = await fetch('/bets/place',{method:'POST',
    headers:{'Content-Type':'application/json','x-cashier-key':key},
    body: JSON.stringify({stake_cents, odds})
  });
  const data = await res.json();
  document.getElementById('msg').textContent = JSON.stringify(data);
  await loadSummary();
  await loadTickets();
}

async function loadTickets(){
  const key = document.getElementById('key').value.trim();
  const res = await fetch('/cashier/tickets',{headers:{'x-cashier-key':key}});
  const rows = await res.json();
  const tb = document.querySelector('#t tbody');
  tb.innerHTML = '';
  (rows||[]).forEach(r=>{
    const tr = document.createElement('tr');
    const cls = r.status==='WON'?'won':(r.status==='LOST'?'lost':'cancel');
    tr.innerHTML = \`
      <td>\${r.uid}</td>
      <td>\${fmtKES(r.stake_cents)}</td>
      <td>\${r.odds ? Number(r.odds).toFixed(2) : '—'}</td>
      <td class="\${cls}">\${r.status}</td>
      <td><a href="/tickets/\${r.uid}/print" target="_blank">Print</a></td>\`;
    tb.appendChild(tr);
  });
}

document.getElementById('key').addEventListener('change',()=>{ loadSummary(); loadTickets(); });
</script>
</body>
</html>`);
});

// start
migrate()
  .then(()=> app.listen(3000, ()=> console.log('App on :3000')))
  .catch(err=> { console.error(err); process.exit(1); });
