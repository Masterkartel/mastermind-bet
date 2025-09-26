// index.js — wallets, tickets, odds, product tabs, barcode/print, POS, Virtual UI + Club Lists
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const bwipjs = require('bwip-js');
const path = require('path'); // ⟵ added

const app = express();
app.use(express.json());
// Serve /public for logos and any static assets
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Limits
const MIN_STAKE = parseInt(process.env.MIN_STAKE_CENTS || '2000', 10); // 20 KES (cents)
const MAX_STAKE = 100000;   // 1,000 KES (cents)
const MAX_PAYOUT = 2000000; // 20,000 KES (cents)
const PRODUCTS = new Set(['FOOTBALL', 'COLOR', 'DOGS', 'HORSES']);

// ------- Club lists for UI/CSV (from your screenshots) -------
const CLUBS = {
  EPL: [
    ['MUN','Manchester United'], ['TOT','Tottenham Hotspur'], ['EVE','Everton'], ['CHE','Chelsea'],
    ['NEW','Newcastle United'], ['WOL','Wolverhampton Wanderers'], ['LIV','Liverpool'], ['ARS','Arsenal'],
    ['NOT','Nottingham Forest'], ['SOU','Southampton'], ['BOU','Bournemouth'], ['CRY','Crystal Palace'],
    ['LEI','Leicester City'], ['ASV','Aston Villa'], ['WHU','West Ham United'], ['BRN','Brentford'],
    ['BRI','Brighton & Hove Albion'], ['LED','Leeds United'], ['FUL','Fulham'], ['MCI','Manchester City']
  ],
  LIGA: [
    ['CAD','Cádiz'], ['RVA','Rayo Vallecano'], ['VIL','Villarreal'], ['SEV','Sevilla'], ['ATM','Atlético Madrid'],
    ['GRO','Girona'], ['ESP','Espanyol'], ['ELC','Elche'], ['MAL','Mallorca'], ['FCB','Barcelona'],
    ['RMA','Real Madrid'], ['GET','Getafe'], ['ATH','Athletic Club'], ['OSA','Osasuna'],
    ['CEL','Celta Vigo'], ['BET','Real Betis'], ['VAL','Valencia'], ['RSO','Real Sociedad'], ['ALM','Almería']
  ],
  CHAMPIONS: [
    ['BRU','Club Brugge'], ['PSG','Paris Saint-Germain'], ['MAD','Atlético Madrid'], ['GAL','Galatasaray'],
    ['OLY','Olympiacos'], ['BAY','Bayern Munich'], ['TOT','Tottenham Hotspur'], ['RSB','Red Star Belgrade']
  ],
  CHAMPS_CUP: [
    ['PSV','PSV Eindhoven'], ['AEK','AEK Athens'], ['MCI','Manchester City'], ['BEN','Benfica'],
    ['RMA','Real Madrid'], ['FCB','Barcelona'], ['MUN','Manchester United'], ['BAR','Barcelona'],
    ['MAR','Marseille'], ['BAS','FC Basel'], ['NAP','Napoli'], ['ZEN','Zenit'],
    ['ROM','AS Roma'], ['JUV','Juventus'], ['PSG','Paris Saint-Germain'], ['ATM','Atlético Madrid'],
    ['LIV','Liverpool'], ['CHE','Chelsea'], ['BVB','Borussia Dortmund'], ['CEL','Celtic']
  ],
  COLOR: []
};

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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
  );

  -- New columns for single-pick MVP (added safely if missing)
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS odds NUMERIC(7,3);
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS product TEXT;
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_code TEXT;
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS market_code TEXT;
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS selection_code TEXT;
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pick_label TEXT;

  CREATE INDEX IF NOT EXISTS idx_tickets_cashier_created ON tickets(cashier_id, created_at DESC);

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

// CASHIER: place bet (now accepts odds + product + optional pick info)
app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  if (!stake || stake < MIN_STAKE) {
    return res.status(400).json({error:`min stake ${MIN_STAKE} cents (KES ${MIN_STAKE/100})`});
  }
  if (stake > MAX_STAKE) {
    return res.status(400).json({error:`max stake ${MAX_STAKE/100} KES`});
  }

  let odds = parseFloat(req.body.odds);
  if (!Number.isFinite(odds) || odds < 1.01) odds = 2.00;

  let product = (req.body.product || 'FOOTBALL').toString().toUpperCase();
  if (!PRODUCTS.has(product)) product = 'FOOTBALL';

  const event_code = req.body.event_code || null;
  const market_code = req.body.market_code || null;
  const selection_code = req.body.selection_code || null;
  const pick_label = req.body.pick_label || null;

  const potential = Math.min(Math.floor(stake * odds), MAX_PAYOUT);

  await withTxn(async (client)=>{
    const cashier = await getWallet(client,'cashier','cashier1');
    const w = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[cashier.id]);
    if (w.rows[0].balance_cents < stake) throw new Error('insufficient funds');

    // reserve stake
    await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2',[stake, cashier.id]);
    const ticketUid = makeTicketUid();
    await ledger(client, cashier.id, 'debit', stake, 'stake', ticketUid, 'stake reserved');

    await client.query(
      `INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents,
                           odds,product,event_code,market_code,selection_code,pick_label)
       VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,$9,$10)`,
      [ticketUid,'cashier1',stake,potential,odds,product,event_code,market_code,selection_code,pick_label]
    );

    res.json({
      ok:true,
      ticket_uid: ticketUid,
      stake_cents: stake,
      odds,
      product,
      potential_win_cents: potential,
      event_code, market_code, selection_code, pick_label
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
      const effectivePotential = t.potential_win_cents || Math.min(Math.floor(t.stake_cents * (t.odds || 2)), MAX_PAYOUT);
      payout = Math.min(effectivePotential, MAX_PAYOUT);
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

// CASHIER: list last 20 tickets (now shows odds + pick + product)
app.get('/cashier/tickets', needCashier, async (_req, res) => {
  const cashierId = 'cashier1';
  const { rows } = await pool.query(
    `SELECT uid, stake_cents, potential_win_cents, status, payout_cents, created_at,
            odds, product, event_code, market_code, selection_code, pick_label
     FROM tickets
     WHERE cashier_id=$1
     ORDER BY created_at DESC LIMIT 20`,
    [cashierId]
  );
  res.json(rows);
});

// BARCODE PNG for a ticket UID
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

// Printable Ticket page
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
  .card{width:380px;border:1px solid #e5e7eb;border-radius:12px;padding:16px;position:relative;overflow:hidden}
  .row{display:flex;justify-content:space-between;margin:6px 0}
  .bar{margin:12px auto;text-align:center}
  .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      font-weight:800;font-size:52px;opacity:0.12;color:${color};transform:rotate(-18deg)}
  .badge{display:inline-block;padding:4px 10px;border-radius:9999px;color:white;background:${color}}
  .muted{color:#6b7280}
  .tiny{font-size:12px}
</style>
</head>
<body>
  <div class="card">
    <div class="wm">${t.status}</div>
    <div class="row"><div><strong>Mastermind Bet</strong></div><div class="badge">${t.status}</div></div>
    <div class="row"><div class="muted">Ticket</div><div>${t.uid}</div></div>
    <div class="row"><div class="muted">Cashier</div><div>${t.cashier_id}</div></div>
    <div class="row"><div class="muted">Product</div><div>${t.product||'-'}</div></div>
    <div class="row"><div class="muted">Pick</div><div>${t.pick_label||t.selection_code||'-'}</div></div>
    <div class="row"><div class="muted">Event</div><div class="tiny">${t.event_code||'-'}</div></div>
    <div class="row"><div class="muted">Market</div><div>${t.market_code||'-'}</div></div>
    <div class="row"><div class="muted">Odds</div><div>${t.odds ? Number(t.odds).toFixed(2) : '-'}</div></div>
    <div class="row"><div class="muted">Stake</div><div>KES ${(t.stake_cents/100).toFixed(0)}</div></div>
    <div class="row"><div class="muted">Potential Win</div><div>KES ${((t.potential_win_cents||0)/100).toFixed(0)}</div></div>
    <div class="row"><div class="muted">Payout</div><div>KES ${((t.payout_cents||0)/100).toFixed(0)}</div></div>
    <div class="bar"><img src="/tickets/${t.uid}/barcode.png" alt="barcode"/></div>
    <div class="muted tiny" style="text-align:center">Verify: mastermind-bet.com/tickets/${t.uid}</div>
  </div>
  <script>window.print()</script>
</body>
</html>`);
});

// Simple Cashier POS page
app.get('/pos', (_req, res) => {
  res.set('Content-Type','text/html');
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Mastermind Cashier</title>
<style>
  :root{
    --bg:#0b1220; --panel:#0f172a; --muted:#94a3b8; --text:#e2e8f0; --brand:#f59e0b; --accent:#1f2937;
    --ok:#16a34a; --warn:#f59e0b; --bad:#dc2626;
  }
  *{box-sizing:border-box}
  body{font-family:system-ui,Arial;background:var(--bg);color:var(--text);margin:0}
  .wrap{max-width:1200px;margin:0 auto;padding:16px}
  .panel{background:var(--panel);border:1px solid #1f2937;border-radius:12px;padding:12px;margin:12px 0}
  .grid{display:grid;gap:12px}
  .grid.cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}
  @media (max-width:900px){.grid.cols-4{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:560px){.grid.cols-4{grid-template-columns:1fr}}
  input,button,select{padding:10px 12px;border-radius:10px;border:1px solid #243044;background:#0b1528;color:var(--text)}
  .btn{background:var(--brand);color:#111;border:none;cursor:pointer;font-weight:700}
  .muted{color:var(--muted)}
  table{width:100%;border-collapse:collapse}
  th,td{border-bottom:1px solid #223048;padding:8px;text-align:left;font-size:14px}
  .tabs{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  .tab{padding:8px 12px;border-radius:9999px;border:1px solid #334155;background:#0b1528;cursor:pointer}
  .tab.active{background:#ef4444;border-color:#ef4444}
  .badge{padding:4px 8px;border-radius:9999px;background:#1f2937}
  .tiny{font-size:12px}
</style>
</head>
<body>
  <div class="wrap">
    <h2>Cashier Dashboard</h2>
    <div class="panel">
      <input id="key" placeholder="x-cashier-key" style="width:260px"/>
    </div>

    <div class="grid cols-4">
      <div class="panel"><div class="muted tiny">Float Balance</div><div id="float">KES 0</div></div>
      <div class="panel"><div class="muted tiny">Today Stake</div><div id="tStake">KES 0</div></div>
      <div class="panel"><div class="muted tiny">Today Payouts</div><div id="tPay">KES 0</div></div>
      <div class="panel"><div class="muted tiny">Pending / Won / Lost</div><div id="stats">0 / 0 / 0</div></div>
    </div>

    <div class="panel">
      <div class="muted tiny">Limits</div>
      <div>Min 20 - Max 1000 • Max Payout 20000</div>
    </div>

    <div class="panel">
      <div class="tabs" id="tabs">
        <button class="tab active" data-product="FOOTBALL">Football</button>
        <button class="tab" data-product="COLOR">Color</button>
        <button class="tab" data-product="DOGS">Dogs</button>
        <button class="tab" data-product="HORSES">Horses</button>
      </div>

      <div class="muted tiny" style="margin:6px 0">Manual single (stake + odds). Use tabs to set the product.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="stake" type="number" placeholder="Stake KES (min 20, max 1000)" />
        <input id="odds" type="number" step="0.01" placeholder="Odds (e.g. 2.10)" />
        <button class="btn" onclick="placeBet()">Place Manual</button>
      </div>
    </div>

    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>Recent Tickets</strong>
        <button class="btn" onclick="loadTickets()">Refresh</button>
      </div>
      <table id="t">
        <thead>
          <tr>
            <th>UID</th><th>Stake</th><th>Odds</th><th>Product</th><th>Pick</th><th>Status</th><th>Print</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

<script>
let currentProduct = 'FOOTBALL';
document.querySelectorAll('#tabs .tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('#tabs .tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentProduct = btn.dataset.product;
  });
});

function fmtKES(c){ return 'KES ' + Math.round((c||0)/100); }

async function placeBet(){
  const key = document.getElementById('key').value.trim();
  const stakeKES = parseInt(document.getElementById('stake').value||'0',10);
  const stake_cents = stakeKES*100;
  const odds = parseFloat(document.getElementById('odds').value||'2.00');

  const res = await fetch('/bets/place',{method:'POST',
    headers:{'Content-Type':'application/json','x-cashier-key':key},
    body: JSON.stringify({
      stake_cents,
      odds,
      product: currentProduct
      // You can also send event_code/market_code/selection_code/pick_label later
    })
  });
  const data = await res.json();
  alert(JSON.stringify(data, null, 2));
  loadTickets();
}

async function loadTickets(){
  const key = document.getElementById('key').value.trim();
  const res = await fetch('/cashier/tickets',{headers:{'x-cashier-key':key}});
  const rows = await res.json();
  const tb = document.querySelector('#t tbody');
  tb.innerHTML = '';
  (rows||[]).forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>'+r.uid+'</td>'+
      '<td>'+fmtKES(r.stake_cents)+'</td>'+
      '<td>'+(r.odds ? Number(r.odds).toFixed(2) : '-')+'</td>'+
      '<td><span class="badge">'+(r.product||'-')+'</span></td>'+
      '<td>'+(r.pick_label||r.selection_code||'-')+'</td>'+
      '<td>'+r.status+'</td>'+
      '<td><a href="/tickets/'+r.uid+'/print" target="_blank">Print</a></td>';
    tb.appendChild(tr);
  });
}
</script>
</body>
</html>`);
});

// ---------- CLUB LISTS API + CSV ----------
app.get('/clubs.json', (_req, res) => {
  res.json({ leagues: Object.keys(CLUBS), clubs: CLUBS });
});

app.get('/clubs.csv', (req, res) => {
  const league = (req.query.league || 'EPL').toUpperCase();
  const list = CLUBS[league] || [];
  const rows = [['league','code','name','suggested_logo_filename']]
    .concat(list.map(([c,n]) => [league, c, n, (c.toLowerCase()+'.png')]));
  const csv = rows.map(r => r.map(x => '"' + String(x).replace(/"/g,'\\"') + '"').join(',')).join('\n');
  res.set('Content-Type','text/csv');
  res.set('Content-Disposition', 'attachment; filename="'+league.toLowerCase()+'_clubs.csv"');
  res.send(csv);
});

// ---------- Frontend: Virtual odds-like page ----------
app.get('/virtual', (_req, res) => {
  res.set('Content-Type','text/html');
  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Mastermind — Virtual Sports</title>
<style>
:root{--bg:#0b0f19;--panel:#121826;--panel2:#0e1526;--muted:#9aa4b2;--text:#e6edf3;--line:#1d2640;--brand:#f59e0b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif}
.wrap{max-width:1360px;margin:0 auto;padding:16px}.row{display:flex;gap:16px}.left{flex:1}.right{width:310px}
.topbar{display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:12px}
.tabs{display:flex;gap:8px;flex-wrap:wrap}.tab{padding:8px 12px;border-radius:9999px;background:#10192e;border:1px solid var(--line);cursor:pointer}
.tab.active{background:#1f2937}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px}
table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid var(--line);font-size:14px}
th{font-weight:700;text-transform:uppercase;color:#c8d1dd;font-size:12px;background:#0f1629;position:sticky;top:0}
.league{display:flex;align-items:center;gap:10px;font-weight:700}.badge{background:#0f1629;border:1px solid #223155;padding:4px 8px;border-radius:9999px;font-size:12px}
.pill{display:inline-flex;align-items:center;justify-content:center;min-width:46px;height:36px;border-radius:8px;background:#0f1629;border:1px solid #1d2846}
.col-odds{display:grid;grid-template-columns:repeat(10,1fr);gap:8px}.muted{color:var(--muted)}
.sidehdr{display:flex;justify-content:space-between;align-items:center}.ticket-row{display:grid;grid-template-columns:1fr 68px 68px;gap:8px;padding:8px;border-bottom:1px solid var(--line);font-size:12px}
details{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:10px;margin-top:12px}
summary{cursor:pointer;font-weight:700}.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.chip{padding:6px 10px;border-radius:9999px;background:#0f1629;border:1px solid #223155;font-size:12px}
.btn{background:var(--brand);color:#111;font-weight:800;border:none;border-radius:10px;padding:8px 12px;cursor:pointer}.sel{background:#0f1629;border:1px solid #223155;color:var(--text);border-radius:10px;padding:8px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="tabs" id="leagueTabs"></div>
      <div style="display:flex;gap:12px"><div class="panel">BRONZE JACKPOT <b>1,120 KSh</b></div></div>
    </div>
    <div class="row">
      <div class="left">
        <div class="panel">
          <table><thead>
            <tr><th>#</th><th>Match</th><th>MAIN</th><th>OVER/UNDER</th><th>1X2 OV/UN 1.5</th><th>1X2 OV/UN 2.5</th><th>GG</th><th>NG</th><th>OV 2.5</th><th>UN 2.5</th></tr>
          </thead><tbody id="fixtureBody"></tbody></table>
        </div>
        <details><summary>Club lists — download CSV for logos</summary>
          <div style="display:flex;gap:8px;margin:8px 0"><select class="sel" id="leagueSelect"></select><a id="csvBtn" class="btn">Download CSV</a></div>
          <div class="chips" id="clubChips"></div>
        </details>
      </div>
      <div class="right">
        <div class="panel">
          <div class="sidehdr"><h3>FASTBET</h3><span class="badge">Recent</span></div>
          <div class="ticket-row" style="font-weight:700;color:#cbd5e1"><div>Ticket Nº</div><div>Stake</div><div>Payout</div></div>
          <div id="fastbet"></div>
        </div>
      </div>
    </div>
  </div>
<script>
const FIXTURES = {
  EPL: [['MUN','TOT'],['EVE','CHE'],['NEW','WOL'],['LIV','ARS'],['NOT','SOU'],['BOU','CRY'],['LEI','ASV'],['WHU','BRN'],['BRI','LED'],['FUL','MCI']],
  LIGA: [['CAD','RVA'],['VIL','SEV'],['ATM','GRO'],['ESP','ELC'],['MAL','FCB'],['RMA','GET'],['ATH','OSA'],['CEL','BET'],['VAL','RSO'],['VAL','ALM']],
  CHAMPIONS: [['BRU','PSG'],['MAD','GAL'],['OLY','BAY'],['TOT','RSB']],
  CHAMPS_CUP: [['PSV','AEK'],['MCI','BEN'],['RMA','FCB'],['MUN','BAR'],['MAR','BAS'],['NAP','ZEN'],['ROM','JUV'],['PSG','ATM'],['LIV','CHE'],['BVB','CEL']],
  COLOR: []
};
let CLUBS = {}; let currentLeague = 'EPL';
const tabsEl = document.getElementById('leagueTabs');
const fixBody = document.getElementById('fixtureBody');
const chips = document.getElementById('clubChips');
const leagueSelect = document.getElementById('leagueSelect');
const csvBtn = document.getElementById('csvBtn');

function randomOdd(min, max){ return (Math.random()*(max-min)+min).toFixed(2); }
function colOdds3(){ return '<div class="pill">'+randomOdd(1.4,6)+'</div><div class="pill">'+randomOdd(2,4)+'</div><div class="pill">'+randomOdd(1.4,6)+'</div>'; }
function colOdds2(){ return '<div class="pill">'+randomOdd(1.2,3)+'</div><div class="pill">'+randomOdd(1.2,3)+'</div>'; }
function renderFixtures(){
  fixBody.innerHTML = '';
  if(currentLeague==='COLOR'){ fixBody.innerHTML = '<tr><td>—</td><td class="league">COLOR GAME</td><td colspan="8" class="muted">Use the Color screen for matched numbers / winning color, etc.</td></tr>'; return; }
  (FIXTURES[currentLeague]||[]).forEach((p,i)=>{
    const h=p[0], a=p[1];
    fixBody.insertAdjacentHTML('beforeend',
      '<tr><td>'+(i+1)+'</td>'+
      '<td class="league"><span class="badge">'+h+'</span> vs <span class="badge">'+a+'</span></td>'+
      '<td class="col-odds">'+colOdds3()+'</td>'+
      '<td class="col-odds">'+colOdds2()+'</td>'+
      '<td class="col-odds">'+colOdds3()+'</td>'+
      '<td class="col-odds">'+colOdds3()+'</td>'+
      '<td><div class="pill">'+randomOdd(1.5,2.4)+'</div></td>'+
      '<td><div class="pill">'+randomOdd(1.4,2.1)+'</div></td>'+
      '<td><div class="pill">'+randomOdd(1.4,2.5)+'</div></td>'+
      '<td><div class="pill">'+randomOdd(1.3,2)+'</div></td></tr>');
  });
}
function renderTabs(leagues){
  tabsEl.innerHTML = '';
  leagues.forEach(function(k){
    var b=document.createElement('button'); b.className='tab'+(k===currentLeague?' active':''); b.textContent=k.replace('_',' ');
    b.onclick=function(){ currentLeague=k; renderTabs(leagues); mountClubs(); renderFixtures(); };
    tabsEl.appendChild(b);
  });
}
function mountClubs(){
  var list = CLUBS[currentLeague]||[];
  leagueSelect.innerHTML = Object.keys(CLUBS).map(function(k){return '<option '+(k===currentLeague?'selected':'')+'>'+k+'</option>';}).join('');
  chips.innerHTML = list.length? list.map(function(x){return '<span class="chip">'+x[0]+' — '+x[1]+'</span>';}).join('') : '<span class="muted">No clubs in this category.</span>';
  csvBtn.href = '/clubs.csv?league='+encodeURIComponent(currentLeague);
}
async function boot(){
  const r = await fetch('/clubs.json'); const j = await r.json(); CLUBS = j.clubs;
  renderTabs(Object.keys(CLUBS)); renderFixtures(); mountClubs();
  leagueSelect.onchange = function(){ currentLeague = leagueSelect.value; renderTabs(Object.keys(CLUBS)); renderFixtures(); mountClubs(); };
  document.getElementById('fastbet').innerHTML = ['211691562843,20 KSh,0 KSh','211930677135,20 KSh,74.46 KSh','214239016892,20 KSh,0 KSh','213176356142,40 KSh,143.88 KSh']
    .map(function(x){ var a=x.split(','); return '<div class="ticket-row"><div class="muted">'+a[0]+'</div><div>'+a[1]+'</div><div>'+a[2]+'</div></div>'; }).join('');
}
boot();
</script>
</body></html>`);
});

// start
migrate()
  .then(()=> app.listen(3000, ()=> console.log('App on :3000')))
  .catch(err=> { console.error(err); process.exit(1); });
