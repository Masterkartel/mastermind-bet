// index.js — Mastermind Bet: API (wallets/tickets) + POS + Virtual Sports UI
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

// safe bwip-js (barcode) import
let bwipjs = null;
try { bwipjs = require('bwip-js'); }
catch { console.warn('bwip-js not installed; barcode placeholder will be used.'); }

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Postgres pool (works with DO Managed PG sslmode=require) ---
const useSSL = process.env.PGSSL === 'require' || /\bsslmode=require\b/i.test(process.env.DATABASE_URL||'');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : undefined });

// Limits
const MIN_STAKE = parseInt(process.env.MIN_STAKE_CENTS || '2000', 10); // 20 KES
const MAX_STAKE = 100000;   // 1,000 KES
const MAX_PAYOUT = 2000000; // 20,000 KES
const PRODUCTS = new Set(['FOOTBALL', 'COLOR', 'DOGS', 'HORSES']);

// ====== CLUB LISTS (3-letter codes → logos under /public/logos/<league>/<code>.png) ======
const CLUBS = {
  CHAMPIONS: [
    ['BRU','Club Brugge'], ['PSG','Paris Saint-Germain'], ['MAD','Atlético Madrid'], ['GAL','Galatasaray'],
    ['OLY','Olympiacos'], ['BAY','Bayern Munich'], ['TOT','Tottenham Hotspur'], ['RSB','Red Star Belgrade']
  ],
  EPL: [
    ['MUN','Manchester United'], ['TOT','Tottenham Hotspur'], ['EVE','Everton'], ['CHE','Chelsea'],
    ['NEW','Newcastle United'], ['WOL','Wolves'], ['LIV','Liverpool'], ['ARS','Arsenal'],
    ['NOT','Nottingham Forest'], ['SOU','Southampton'], ['BOU','Bournemouth'], ['CRY','Crystal Palace'],
    ['LEI','Leicester City'], ['ASV','Aston Villa'], ['WHU','West Ham United'], ['BRN','Brentford'],
    ['BRI','Brighton'], ['LED','Leeds United'], ['FUL','Fulham'], ['MCI','Manchester City']
  ],
  LIGA: [
    ['CAD','Cádiz'], ['RVA','Rayo Vallecano'], ['VIL','Villarreal'], ['SEV','Sevilla'],
    ['ATM','Atlético Madrid'], ['GRO','Girona'], ['ESP','Espanyol'], ['ELC','Elche'],
    ['MAL','Mallorca'], ['FCB','Barcelona'], ['RMA','Real Madrid'], ['GET','Getafe'],
    ['ATH','Athletic Club'], ['OSA','Osasuna'], ['CEL','Celta Vigo'], ['BET','Real Betis'],
    ['VAL','Valencia'], ['RSO','Real Sociedad'], ['ALM','Almería']
  ],
  CHAMPS_CUP: [
    ['PSV','PSV Eindhoven'], ['AEK','AEK Athens'], ['MCI','Manchester City'], ['BEN','Benfica'],
    ['RMA','Real Madrid'], ['FCB','Barcelona'], ['MUN','Manchester United'], ['BAR','Barcelona'],
    ['MAR','Marseille'], ['BAS','FC Basel'], ['NAP','Napoli'], ['ZEN','Zenit'],
    ['ROM','AS Roma'], ['JUV','Juventus'], ['PSG','Paris Saint-Germain'], ['ATM','Atlético Madrid'],
    ['LIV','Liverpool'], ['CHE','Chelsea'], ['BVB','Borussia Dortmund'], ['CEL','Celtic']
  ],
};

// ====== HELPERS ======
async function withTxn(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
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
    ref_type TEXT, ref_id TEXT, memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS transfers (
    id BIGSERIAL PRIMARY KEY,
    from_wallet BIGINT REFERENCES wallets(id),
    to_wallet   BIGINT REFERENCES wallets(id),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    requested_by TEXT, approved_by TEXT, memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id BIGSERIAL PRIMARY KEY,
    uid TEXT UNIQUE NOT NULL,
    cashier_id TEXT NOT NULL,
    stake_cents BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    potential_win_cents BIGINT, payout_cents BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), settled_at TIMESTAMPTZ,
    odds NUMERIC(7,3), product TEXT, event_code TEXT, market_code TEXT, selection_code TEXT, pick_label TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_cashier_created ON tickets(cashier_id, created_at DESC);
  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'house', NULL, 'KES', 0 WHERE NOT EXISTS(SELECT 1 FROM wallets WHERE owner_type='house' AND owner_id IS NULL);
  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'agent', 'agent1', 'KES', 0 WHERE NOT EXISTS(SELECT 1 FROM wallets WHERE owner_type='agent' AND owner_id='agent1');
  INSERT INTO wallets(owner_type, owner_id, currency, balance_cents)
  SELECT 'cashier', 'cashier1', 'KES', 0 WHERE NOT EXISTS(SELECT 1 FROM wallets WHERE owner_type='cashier' AND owner_id='cashier1');
  `;
  await pool.query(sql);
}
async function getWallet(client, ownerType, ownerId=null) {
  const { rows } = await client.query(
    'SELECT * FROM wallets WHERE owner_type=$1 AND ((owner_id IS NULL AND $2::text IS NULL) OR owner_id=$2) FOR UPDATE',
    [ownerType, ownerId]
  );
  if (!rows[0]) {
    const ins = await client.query('INSERT INTO wallets(owner_type, owner_id) VALUES ($1,$2) RETURNING *',[ownerType, ownerId]);
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
function needAdmin(req, res, next){ if (req.header('x-admin-key') === process.env.ADMIN_KEY) return next(); return res.status(401).json({error:'admin key required'}); }
function needAgent(req, res, next){ if (req.header('x-agent-key') === process.env.AGENT_KEY) return next(); return res.status(401).json({error:'agent key required'}); }
function needCashier(req, res, next){ if (req.header('x-cashier-key') === process.env.CASHIER_KEY) return next(); return res.status(401).json({error:'cashier key required'}); }
function makeTicketUid(){ return 'T' + crypto.randomBytes(6).toString('hex').toUpperCase(); }

// ====== BASIC ENDPOINTS ======
app.get('/health', (_req,res)=>res.json({ok:true}));
app.get('/balances', needAdmin, async (_req,res)=>{ const {rows}=await pool.query('SELECT owner_type,owner_id,balance_cents FROM wallets ORDER BY owner_type,owner_id'); res.json(rows); });
app.get('/admin/ledger', needAdmin, async (_req,res)=>{ const {rows}=await pool.query('SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT 50'); res.json(rows); });

// place bet (single)
app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  if (!stake || stake < MIN_STAKE) return res.status(400).json({error:`min stake ${MIN_STAKE} cents (KES ${MIN_STAKE/100})`});
  if (stake > MAX_STAKE) return res.status(400).json({error:`max stake ${MAX_STAKE/100} KES`});

  let odds = parseFloat(req.body.odds); if (!Number.isFinite(odds) || odds < 1.01) odds = 2.00;
  let product = (req.body.product||'FOOTBALL').toString().toUpperCase(); if (!PRODUCTS.has(product)) product='FOOTBALL';
  const event_code = req.body.event_code || null;
  const market_code = req.body.market_code || null;
  const selection_code = req.body.selection_code || null;
  const pick_label = req.body.pick_label || null;

  const potential = Math.min(Math.floor(stake * odds), MAX_PAYOUT);

  await withTxn(async (client)=>{
    const cashier = await getWallet(client,'cashier','cashier1');
    const w = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[cashier.id]);
    if (w.rows[0].balance_cents < stake) throw new Error('insufficient funds');

    await client.query('UPDATE wallets SET balance_cents=balance_cents-$1 WHERE id=$2',[stake, cashier.id]);
    const ticketUid = makeTicketUid();
    await ledger(client,cashier.id,'debit',stake,'stake',ticketUid,'stake reserved');

    await client.query(
      `INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents,odds,product,event_code,market_code,selection_code,pick_label)
       VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,$9,$10)`,
      [ticketUid,'cashier1',stake,potential,odds,product,event_code,market_code,selection_code,pick_label]
    );

    res.json({ok:true,ticket_uid:ticketUid,stake_cents:stake,odds,product,potential_win_cents:potential,event_code,market_code,selection_code,pick_label});
  }).catch(e=>res.status(400).json({error:e.message}));
});

// settle
app.post('/admin/settle-ticket', needAdmin, async (req,res)=>{
  const { uid, outcome } = req.body;
  if (!uid || !['WON','LOST','CANCELLED'].includes(outcome)) return res.status(400).json({error:'uid + outcome required (WON|LOST|CANCELLED)'});
  await withTxn(async (client)=>{
    const {rows} = await client.query('SELECT * FROM tickets WHERE uid=$1 FOR UPDATE',[uid]);
    if (!rows[0]) throw new Error('ticket not found');
    const t = rows[0]; if (t.status !== 'PENDING') throw new Error('already settled');
    const cashier = await getWallet(client,'cashier',t.cashier_id);
    let payout = 0;
    if (outcome==='WON'){
      const eff = t.potential_win_cents || Math.min(Math.floor(t.stake_cents * (t.odds || 2)), MAX_PAYOUT);
      payout = Math.min(eff, MAX_PAYOUT);
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'payout',uid,'ticket won');
    } else if (outcome==='CANCELLED'){
      payout = t.stake_cents;
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'refund',uid,'ticket cancelled');
    }
    await client.query('UPDATE tickets SET status=$1, payout_cents=$2, settled_at=now() WHERE id=$3',[outcome,payout,t.id]);
  }).then(()=>res.json({ok:true,uid,outcome})).catch(e=>res.status(400).json({error:e.message}));
});

app.get('/tickets/:uid', async (req,res)=>{ const {uid}=req.params; const {rows}=await pool.query('SELECT * FROM tickets WHERE uid=$1',[uid]); if(!rows[0]) return res.status(404).json({error:'ticket not found'}); res.json(rows[0]); });

app.get('/cashier/tickets', needCashier, async (_req,res)=>{
  const {rows}=await pool.query(
    `SELECT uid, stake_cents, potential_win_cents, status, payout_cents, created_at,
            odds, product, event_code, market_code, selection_code, pick_label
     FROM tickets WHERE cashier_id=$1 ORDER BY created_at DESC LIMIT 20`, ['cashier1']);
  res.json(rows);
});

// BARCODE (fallback if bwip missing)
app.get('/tickets/:uid/barcode.png', async (req,res)=>{
  const { uid } = req.params;
  if (!bwipjs){
    res.set('Content-Type','image/svg+xml');
    return res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="380" height="60"><rect width="100%" height="100%" fill="#fff"/><text x="10" y="38" font-size="20" fill="#111">${uid}</text></svg>`);
  }
  try{
    const png = await bwipjs.toBuffer({ bcid:'code128', text: uid, scale:3, height:10, includetext:true, textxalign:'center' });
    res.set('Content-Type','image/png'); res.send(png);
  }catch{ res.status(400).json({error:'barcode failed'}); }
});

// PRINT PAGE
app.get('/tickets/:uid/print', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).send('Ticket not found');
  const t = rows[0];
  const color = t.status==='WON'?'#16a34a': t.status==='LOST'?'#dc2626':'#6b7280';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/><title>Ticket ${t.uid}</title>
<style>
body{font-family:system-ui,Arial,sans-serif;padding:16px}.card{width:380px;border:1px solid #e5e7eb;border-radius:12px;padding:16px;position:relative;overflow:hidden}
.row{display:flex;justify-content:space-between;margin:6px 0}.bar{margin:12px auto;text-align:center}
.wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:52px;opacity:0.12;color:${color};transform:rotate(-18deg)}
.badge{display:inline-block;padding:4px 10px;border-radius:9999px;color:white;background:${color}}.muted{color:#6b7280}.tiny{font-size:12px}
</style></head><body>
<div class="card">
  <div class="wm">${t.status}</div>
  <div class="row"><div><strong>Mastermind Bet</strong></div><div class="badge">${t.status}</div></div>
  <div class="row"><div class="muted">Ticket</div><div>${t.uid}</div></div>
  <div class="row"><div class="muted">Cashier</div><div>${t.cashier_id}</div></div>
  <div class="row"><div class="muted">Product</div><div>${t.product||'-'}</div></div>
  <div class="row"><div class="muted">Pick</div><div>${t.pick_label||t.selection_code||'-'}</div></div>
  <div class="row"><div class="muted">Event</div><div class="tiny">${t.event_code||'-'}</div></div>
  <div class="row"><div class="muted">Market</div><div>${t.market_code||'-'}</div></div>
  <div class="row"><div class="muted">Odds</div><div>${t.odds?Number(t.odds).toFixed(2):'-'}</div></div>
  <div class="row"><div class="muted">Stake</div><div>KES ${(t.stake_cents/100).toFixed(0)}</div></div>
  <div class="row"><div class="muted">Potential Win</div><div>KES ${((t.potential_win_cents||0)/100).toFixed(0)}</div></div>
  <div class="row"><div class="muted">Payout</div><div>KES ${((t.payout_cents||0)/100).toFixed(0)}</div></div>
  <div class="bar"><img src="/tickets/${t.uid}/barcode.png" alt="barcode"/></div>
  <div class="muted tiny" style="text-align:center">Verify: mastermind-bet.com/tickets/${t.uid}</div>
</div><script>window.print()</script></body></html>`);
});

// Simple Cashier POS page (dark, responsive). Manual place supports odds + product tab.
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
document.querySelectorAll('#tabs .tab').forEach(function(btn){
  btn.addEventListener('click', function(){
    document.querySelectorAll('#tabs .tab').forEach(function(b){ b.classList.remove('active'); });
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
      stake_cents: stake_cents,
      odds: odds,
      product: currentProduct
      // event_code/market_code/selection_code/pick_label can be sent later
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
  (rows||[]).forEach(function(r){
    const tr = document.createElement('tr');
    tr.innerHTML = ` + String.raw\`
      <td>\${r.uid}</td>
      <td>\${fmtKES(r.stake_cents)}</td>
      <td>\${r.odds ? Number(r.odds).toFixed(2) : '-'}</td>
      <td><span class="badge">\${r.product||'-'}</span></td>
      <td>\${r.pick_label||r.selection_code||'-'}</td>
      <td>\${r.status}</td>
      <td><a href="/tickets/\${r.uid}/print" target="_blank">Print</a></td>\` + `;
    tb.appendChild(tr);
  });
}
</script>
</body>
</html>`);
});

// ======= VIRTUAL SPORTS PAGE (matches your screenshots) =======
app.get('/virtual', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Virtual Sports — Mastermind</title>
<style>
:root{--bg:#0b0f19;--panel:#121826;--panel2:#0f1629;--line:#1d2640;--text:#e6edf3;--muted:#9aa4b2;--brand:#f59e0b;--accent:#ef4444;--ok:#16a34a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:System-ui,Segoe UI,Roboto,Arial,sans-serif}
.wrap{max-width:1360px;margin:0 auto;padding:16px}.row{display:flex;gap:14px}.left{flex:1}.right{width:320px}
.topbar{display:flex;align-items:center;gap:10px;justify-content:space-between}
.tabs{display:flex;gap:8px;flex-wrap:wrap}.tab{padding:8px 12px;border-radius:9999px;background:#10192e;border:1px solid var(--line);cursor:pointer}
.tab.active{background:#1f2937}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px}
.hbar{display:flex;gap:8px;align-items:center;margin:6px 0}
.clock{display:inline-flex;align-items:center;justify-content:center;width:80px;height:80px;border-radius:9999px;background:#0b1226;border:4px solid #1e2a4d;font-weight:900;position:relative}
.clock small{position:absolute;bottom:8px;color:#9aa4b2;font-size:10px}
.live{position:absolute;top:-8px;right:-8px;background:var(--accent);color:#fff;font-weight:800;font-size:10px;padding:4px 6px;border-radius:9999px}
.tbl{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid var(--line);font-size:14px}
th{background:#0f1629;color:#cbd5e1;font-size:12px;text-transform:uppercase;position:sticky;top:0;z-index:1}
.badge{display:inline-flex;align-items:center;gap:6px;background:#0f1629;border:1px solid #223155;padding:4px 8px;border-radius:9999px;font-size:12px}
.pill{display:inline-flex;align-items:center;justify-content:center;min-width:52px;height:36px;border-radius:8px;background:#0f1629;border:1px solid #1d2846}
.pill:hover{outline:2px solid #334b9e;cursor:pointer}
.logo{width:18px;height:18px;border-radius:9999px;background:#0b1226;border:1px solid #223155;display:inline-block;object-fit:cover}
.sidehdr{display:flex;justify-content:space-between;align-items:center}
.ticket-row{display:grid;grid-template-columns:1fr 70px 70px;gap:8px;padding:8px;border-bottom:1px solid var(--line);font-size:12px}
.section-title{display:flex;align-items:center;gap:12px;margin:6px 0}
.section-title .label{padding:4px 8px;border-radius:8px;background:#0f1629;border:1px solid #223155}
.subtabs{display:flex;gap:6px;margin:8px 0}.subtabs .st{padding:6px 10px;border:1px solid #223155;background:#0f1629;border-radius:9999px;cursor:pointer}
.st.active{background:#1f2937}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.chip{padding:6px 10px;border-radius:9999px;background:#0f1629;border:1px solid #223155;font-size:12px}
.btn{background:var(--brand);color:#111;font-weight:800;border:none;border-radius:10px;padding:8px 12px;cursor:pointer}
.note{color:var(--muted);font-size:12px}
.grid-num{display:grid;grid-template-columns:repeat(9,1fr);gap:8px}
.ball{display:flex;align-items:center;justify-content:center;height:40px;border-radius:9999px;background:#111a33;border:1px solid #223155}
.kcolor{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.kbox{background:#0f1629;border:1px solid #223155;border-radius:12px;padding:10px}
.kopt{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.kpill{padding:6px 10px;border:1px solid #223155;background:#0f1629;border-radius:9999px}
.racetable{width:100%}
.raceline{display:flex;gap:10px;align-items:center;border-bottom:1px solid #1d2640;padding:8px 0}
.horse{width:22px;height:22px;background:#1e2a4d;border-radius:4px}
</style></head>
<body>
<div class="wrap">
  <div class="topbar">
    <div class="tabs" id="productTabs"></div>
    <div class="panel">BRONZE JACKPOT <b>1,120 KSh</b></div>
  </div>
  <div class="row">
    <div class="left">
      <div id="productContent"></div>
    </div>
    <div class="right">
      <div class="panel">
        <div class="sidehdr"><h3>FASTBET</h3><span class="b// index.js — wallets, tickets, odds, product tabs, barcode/print, POS, Virtual UI + Club Lists
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
</body>
</html>`);
});

// ---- start server (migrate but don't block listen) ----
async function start() {
  try {
    await migrate();
    console.log('DB migrate: OK');
  } catch (e) {
    console.error('DB migrate FAILED:', e.message);
  }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`App on :${PORT}`));
}
start();
adge">Recent</span></div>
        <div class="ticket-row" style="font-weight:700;color:#cbd5e1"><div>Ticket Nº</div><div>Stake</div><div>Payout</div></div>
        <div id="fastbet"></div>
      </div>
      <div class="panel">
        <div class="sidehdr"><h3>Place Bets</h3><span class="note">demo</span></div>
        <div id="betslip" class="note">Select any odds to add here…</div>
        <div style="margin-top:10px;display:flex;gap:8px"><input id="stake" placeholder="Stake KES" style="flex:1;padding:8px;border-radius:8px;border:1px solid #223155;background:#0f1629;color:#fff"/><button class="btn" onclick="placeSlip()">PLACE</button></div>
      </div>
    </div>
  </div>
</div>
<script>
// ---- DATA ----
const CLUBS = ${JSON.stringify(CLUBS)};
const FOOTBALL_GROUPS = ['CHAMPIONS','EPL','LIGA','CHAMPS_CUP'];
const PRODUCTS = ['FOOTBALL','COLOR','DOGS','HORSES'];

// fixtures generator per group (10 fixtures = as in screenshots)
function fixturesFor(group){
  const teams = CLUBS[group] || [];
  const pick = (n)=>teams[n % teams.length][0];
  const out = [];
  for(let i=0;i<10;i++) out.push([pick(i*2), pick(i*2+1)]);
  return out;
}

// odds helpers
function ro(min,max){ return (Math.random()*(max-min)+min).toFixed(2); }
function three(){ return [ro(1.4,6), ro(2,4), ro(1.4,6)]; }
function two(){ return [ro(1.2,3), ro(1.2,3)]; }

// clock state
const clocks = {}; // key → {ms,el,live}
function startClock(key, el, durationMs){
  clocks[key] = { ms: durationMs, el, live:false };
}
function tickClocks(){
  for(const k in clocks){
    const c = clocks[k]; c.ms -= 1000; if (c.ms < -20000) c.ms = 180000; // reset after 20s LIVE
    const t = c.ms;
    const m = Math.max(0, Math.floor((t>0?t:0)/60000));
    const s = Math.max(0, Math.floor(((t>0?t:0)%60000)/1000));
    c.el.querySelector('.mm').textContent = (m<10?'0':'')+m+':' + (s<10?'0':'')+s;
    const live = t<=0;
    if (live !== c.live){
      c.live = live;
      const badge = c.el.querySelector('.live');
      if (live){ badge.style.display='block'; }
      else { badge.style.display='none'; }
    }
  }
}
setInterval(tickClocks, 1000);

// logo helper with fallback
function logoImg(league, code){
  const src = '/logos/'+league.toLowerCase()+'/'+code.toLowerCase()+'.png';
  return '<img class="logo" src="'+src+'" onerror="this.onerror=null;this.style.display=\\'none\\'">';
}

// betslip
const slip = [];
function addOdd(label, odds){
  slip.push({label, odds:parseFloat(odds)});
  document.getElementById('betslip').innerHTML = slip.map((x,i)=>'<div>'+x.label+' — <b>'+x.odds.toFixed(2)+'</b> <a href="#" onclick="rmSlip('+i+');return false;" style="color:#ef4444">x</a></div>').join('');
}
function rmSlip(i){ slip.splice(i,1); document.getElementById('betslip').innerHTML = slip.length? slip.map((x,i)=>'<div>'+x.label+' — <b>'+x.odds.toFixed(2)+'</b> <a href="#" onclick="rmSlip('+i+');return false;" style="color:#ef4444">x</a></div>').join(''):'Select any odds to add here…'; }
function placeSlip(){
  if (!slip.length) return alert('No selections');
  const stake = parseFloat(document.getElementById('stake').value||'0');
  if (!stake || stake<20) return alert('Enter stake (min 20)');
  const totalOdds = slip.reduce((a,b)=>a*b.odds,1);
  alert('Bet placed (demo)\\nSelections: '+slip.length+'\\nTotal odds: '+totalOdds.toFixed(2)+'\\nStake: KES '+stake.toFixed(0));
  slip.length=0; document.getElementById('betslip').innerHTML='Select any odds to add here…';
}

// renderers
function renderFootballGroup(group){
  const fixtures = fixturesFor(group);
  const gEl = document.createElement('div');
  gEl.className='panel';
  gEl.innerHTML = '<div class="section-title"><div class="label">'+group.replace('_',' ')+'</div>'+
    '<div class="clock"><span class="mm">03:00</span><small>19:18</small><span class="live" style="display:none">LIVE</span></div></div>'+
    '<table class="tbl"><thead><tr><th>#</th><th>Match</th><th>MAIN</th><th>OVER/UNDER</th><th>1X2 OV/UN 1.5</th><th>1X2 OV/UN 2.5</th><th>GG</th><th>NG</th><th>OV 2.5</th><th>UN 2.5</th></tr></thead><tbody></tbody></table>';
  const tb = gEl.querySelector('tbody');

  fixtures.forEach((pair,i)=>{
    const [h,a] = pair;
    const main = three(), ou = two(), x15 = three(), x25 = three(), gg = ro(1.5,2.4), ng = ro(1.4,2.1), ov = ro(1.4,2.5), un = ro(1.3,2.0);
    const row = document.createElement('tr');
    row.innerHTML =
     '<td>'+(i+1)+'</td>'+
     '<td><span class="badge">'+logoImg(group,h)+' '+h+'</span> vs <span class="badge">'+logoImg(group,a)+' '+a+'</span></td>'+
     '<td>'+main.map(o=>'<span class="pill" onclick="addOdd(\\''+h+' vs '+a+' MAIN\\','+o+')">'+o+'</span>').join(' ')+'</td>'+
     '<td>'+ou.map(o=>'<span class="pill" onclick="addOdd(\\''+h+' vs '+a+' O/U\\','+o+')">'+o+'</span>').join(' ')+'</td>'+
     '<td>'+x15.map(o=>'<span class="pill" onclick="addOdd(\\''+h+' vs '+a+' 1X2 1.5\\','+o+')">'+o+'</span>').join(' ')+'</td>'+
     '<td>'+x25.map(o=>'<span class="pill" onclick="addOdd(\\''+h+' vs '+a+' 1X2 2.5\\','+o+')">'+o+'</span>').join(' ')+'</td>'+
     '<td><span class="pill" onclick="addOdd(\\''+h+' vs '+a+' GG\\','+gg+')">'+gg+'</span></td>'+
     '<td><span class="pill" onclick="addOdd(\\''+h+' vs '+a+' NG\\','+ng+')">'+ng+'</span></td>'+
     '<td><span class="pill" onclick="addOdd(\\''+h+' vs '+a+' OV 2.5\\','+ov+')">'+ov+'</span></td>'+
     '<td><span class="pill" onclick="addOdd(\\''+h+' vs '+a+' UN 2.5\\','+un+')">'+un+'</span></td>';
    tb.appendChild(row);
  });

  // start its clock at random offset so screens look staggered
  const clk = gEl.querySelector('.clock'); startClock('FB_'+group, clk, 180000 - Math.floor(Math.random()*80000));
  return gEl;
}

function renderFootball(){
  const holder = document.createElement('div');
  // subtabs like your top red tabs
  const s = document.createElement('div'); s.className='subtabs';
  FOOTBALL_GROUPS.forEach((g,idx)=>{
    const b = document.createElement('button'); b.className='st'+(idx===0?' active':''); b.textContent=g.replace('_',' ');
    b.onclick = ()=>{ [...s.children].forEach(x=>x.classList.remove('active')); b.classList.add('active'); body.innerHTML=''; body.appendChild(renderFootballGroup(g)); };
    s.appendChild(b);
  });
  const body = document.createElement('div'); body.appendChild(renderFootballGroup(FOOTBALL_GROUPS[0]));
  holder.appendChild(s); holder.appendChild(body);
  return holder;
}

function renderColor(){
  const box = document.createElement('div'); box.className='panel';
  box.innerHTML = '<div class="section-title"><div class="label">COLOR</div>'+
    '<div class="clock"><span class="mm">03:00</span><small>19:18</small><span class="live" style="display:none">LIVE</span></div></div>'+
    '<div class="kbox"><div class="note">RANDOM • pick numbers (1–49) or colors</div>'+
    '<div class="grid-num" id="nums"></div></div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">'+
      '<div class="kbox"><div class="note">WINNING COLOR</div><div class="kopt">'+
        '<span class="kpill">Red</span><span class="kpill">Yellow</span><span class="kpill">Blue</span><span class="kpill">Black</span>'+
      '</div></div>'+
      '<div class="kbox"><div class="note">NUMBER OF COLORS</div><div class="kopt">'+
        '<span class="kpill">0</span><span class="kpill">2+</span><span class="kpill">3+</span><span class="kpill">4+</span><span class="kpill">5+</span><span class="kpill">6</span>'+
      '</div></div></div>';
  const nums = box.querySelector('#nums');
  for(let i=1;i<=49;i++){ const b=document.createElement('div'); b.className='ball'; b.textContent=i; nums.appendChild(b); }
  const clk = box.querySelector('.clock'); startClock('COLOR', clk, 180000 - Math.floor(Math.random()*60000));
  return box;
}

function renderRace(title){
  const box = document.createElement('div'); box.className='panel';
  box.innerHTML = '<div class="section-title"><div class="label">'+title.toUpperCase()+'</div>'+
    '<div class="clock"><span class="mm">03:00</span><small>19:18</small><span class="live" style="display:none">LIVE</span></div></div>'+
    '<div class="note">WIN / PLACE / SHOW</div>'+
    '<div id="race"></div>'+
    '<div class="note" style="margin-top:8px">FORECAST / TRICAST</div>'+
    '<div id="fc"></div>';
  const r = box.querySelector('#race'); const f = box.querySelector('#fc');
  // 6 runners like screenshot
  const runners = [1,2,3,4,5,6].map(n=>({n, win:ro(1.2,12), place:ro(1.1,4), show:ro(1.05,2.6)}));
  runners.forEach(x=>{
    const line = document.createElement('div'); line.className='raceline';
    line.innerHTML = '<div class="horse"></div><div>#'+x.n+'</div>'+
      '<div style="margin-left:auto;display:flex;gap:8px">'+
      '<span class="pill" onclick="addOdd(\\'WIN '+x.n+'\\','+x.win+')">W '+x.win+'</span>'+
      '<span class="pill" onclick="addOdd(\\'PLC '+x.n+'\\','+x.place+')">P '+x.place+'</span>'+
      '<span class="pill" onclick="addOdd(\\'SHW '+x.n+'\\','+x.show+')">S '+x.show+'</span></div>';
    r.appendChild(line);
  });
  // sample forecast/tricast entries
  const combos = [['1>2','10.0'],['1>3','5.08'],['3>1','4.86'],['4>5','5.60'],['5>6','4.59'],['6>7','12.7']];
  f.innerHTML = combos.map(c=>'<span class="pill" onclick="addOdd(\\'F/C '+c[0]+'\\','+c[1]+')">'+c[0]+' '+c[1]+'</span>').join(' ');
  const clk = box.querySelector('.clock'); startClock(title, clk, 180000 - Math.floor(Math.random()*70000));
  return box;
}

function renderProduct(product){
  const container = document.createElement('div');
  if (product==='FOOTBALL') container.appendChild(renderFootball());
  if (product==='COLOR') container.appendChild(renderColor());
  if (product==='DOGS') container.appendChild(renderRace('DOGS'));
  if (product==='HORSES') container.appendChild(renderRace('HORSES'));
  return container;
}

function mountUI(){
  const tabs = document.getElementById('productTabs');
  const content = document.getElementById('productContent');
  PRODUCTS.forEach((p,i)=>{
    const b = document.createElement('button'); b.className='tab'+(i===0?' active':''); b.textContent=p;
    b.onclick = ()=>{ [...tabs.children].forEach(x=>x.classList.remove('active')); b.classList.add('active'); content.innerHTML=''; content.appendChild(renderProduct(p)); };
    tabs.appendChild(b);
  });
  content.appendChild(renderProduct('FOOTBALL'));
  // sidebar mock tickets
  document.getElementById('fastbet').innerHTML = ['211691562843,20 KSh,0 KSh','211930677135,20 KSh,74.46 KSh','214239016892,20 KSh,0 KSh','213176356142,40 KSh,143.88 KSh']
    .map(x=>{ const a=x.split(','); return '<div class="ticket-row"><div class="muted">'+a[0]+'</div><div>'+a[1]+'</div><div>'+a[2]+'</div></div>'; }).join('');
}
mountUI();
</script>
</body></html>`);
});

// ====== CLUBS JSON/CSV endpoints (for your logo workflow) ======
app.get('/clubs.json', (_req,res)=>res.json({leagues:Object.keys(CLUBS), clubs:CLUBS}));
app.get('/clubs.csv', (req,res)=>{
  const league=(req.query.league||'EPL').toUpperCase(); const list=CLUBS[league]||[];
  const rows=[['league','code','name','logo_file']].concat(list.map(([c,n])=>[league,c,n,c.toLowerCase()+'.png']));
  const csv=rows.map(r=>r.map(x=>'"'+String(x).replace(/"/g,'\\"')+'"').join(',')).join('\\n');
  res.type('csv').set('Content-Disposition','attachment; filename="'+league.toLowerCase()+'_clubs.csv"').send(csv);
});

// ====== START ======
(async function start(){
  try{ await migrate(); console.log('DB migrate: OK'); }catch(e){ console.error('DB migrate FAILED:', e.message); }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, ()=>console.log('App on :'+PORT));
})();
