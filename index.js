// index.js — wallets, tickets, odds, product tabs, barcode/print, POS, VIRTUAL lobby
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

let bwipjs;
try { bwipjs = require('bwip-js'); } catch { bwipjs = null; }

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3000', 10);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Limits
const MIN_STAKE = parseInt(process.env.MIN_STAKE_CENTS || '2000', 10); // 20 KES (cents)
const MAX_STAKE = 100000;   // 1,000 KES (cents)
const MAX_PAYOUT = 2000000; // 20,000 KES (cents)
const PRODUCTS = new Set(['FOOTBALL', 'COLOR', 'DOGS', 'HORSES']);

function log(){ console.log(new Date().toISOString()+':', ...arguments); }

// =====================================================================
// In-memory “virtual” engine (timers, fixtures, odds)
// =====================================================================
const rnd = (a,b)=> a + Math.random()*(b-a);
const pick = (arr)=> arr[Math.floor(Math.random()*arr.length)];
const shuffle = (arr)=> arr.map(x=>[Math.random(),x]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);

// Football teams (10 per league shown in table like screenshots)
const TEAMS = {
  EPL: ['MUN','TOT','EVE','CHE','NEW','WOL','LIV','ARS','NOT','SOU'],
  LIGA:['VIL','SEV','ATM','GRO','ESP','ELC','MAL','FCB','RMA','GET'],
  UCL: ['PSV','AEK','MCI','BEN','RMA','FCB','MUN','BAR','LIV','CHE']
};

// State objects
const LEAGUES = {};   // code -> {code,name,endsAt,round,fixtures[]}
const PRODUCTS_STATE = { // for Color/Dogs/Horses
  COLOR: { code:'COLOR', endsAt:0, round:0, board:[], markets:[] },
  DOGS:  { code:'DOGS',  endsAt:0, round:0, lanes:[],  markets:[] },
  HORSES:{ code:'HORSES',endsAt:0, round:0, lanes:[],  markets:[] }
};

function gen1x2Odds(){
  // Generate sensible 1X2 odds (favorite 1.3–2.2, etc)
  const fav = rnd(1.25, 2.20);
  const draw= rnd(2.70, 4.20);
  const dog = Math.max(1.01, rnd(2.60, 7.50));
  // Normalize a bit so not insane margin
  return {
    '1': Number(fav.toFixed(2)),
    'X': Number(draw.toFixed(2)),
    '2': Number(dog.toFixed(2))
  };
}
function genOU(){
  return {
    'OV2.5': Number(rnd(1.60, 2.60).toFixed(2)),
    'UN2.5': Number(rnd(1.40, 2.40).toFixed(2))
  };
}
function genGG(){
  return {
    'GG': Number(rnd(1.60, 2.20).toFixed(2)),
    'NG': Number(rnd(1.40, 2.10).toFixed(2))
  };
}
function newFootballRound(code){
  const teams = TEAMS[code]||[];
  const pairs = [];
  const pool = shuffle(teams.slice());
  for (let i=0;i<teams.length;i+=2){
    const home = pool[i], away = pool[i+1];
    if (!home || !away) break;
    const odds1x2 = gen1x2Odds();
    const ou = genOU();
    const gg = genGG();
    pairs.push({
      id: (i/2)+1,
      home, away,
      markets: {
        '1X2': odds1x2,
        '1X2 OV/UN 2.5': Object.assign({}, odds1x2, ou),
        'GG/NG': gg
      }
    });
  }
  const now = Date.now();
  LEAGUES[code] = {
    code,
    name: code==='EPL'?'Premier League': code==='LIGA'?'La Liga':'Champions Cup',
    endsAt: now + 180000,  // 3 minutes
    round: (LEAGUES[code]?.round || 0) + 1,
    fixtures: pairs
  };
}

function newColorRound(){
  const colors = ['RED','YEL','BLU','BLK'];
  const nums = Array.from({length:49}, (_,i)=> i+1);
  PRODUCTS_STATE.COLOR = {
    code:'COLOR',
    round: PRODUCTS_STATE.COLOR.round+1,
    endsAt: Date.now()+180000,
    board: nums,
    markets: [
      { code:'WIN_COLOR', odds: { RED:1.90, YEL:1.90, BLU:1.90, BLK:1.90 } },
      { code:'NUM_COLORS', odds: { 'OV2.5':1.95, 'UN2.5':1.75 } }
    ]
  };
}
function genLaneOdds(n){
  const out = {};
  for(let i=1;i<=n;i++){
    out[String(i)] = Number(rnd(2.00, 12.00).toFixed(2));
  }
  return out;
}
function newDogsRound(){
  PRODUCTS_STATE.DOGS = {
    code:'DOGS',
    round: PRODUCTS_STATE.DOGS.round+1,
    endsAt: Date.now()+180000,
    lanes: [1,2,3,4,5,6],
    markets: [{ code:'WINNER', odds: genLaneOdds(6) }]
  };
}
function newHorsesRound(){
  PRODUCTS_STATE.HORSES = {
    code:'HORSES',
    round: PRODUCTS_STATE.HORSES.round+1,
    endsAt: Date.now()+180000,
    lanes: [1,2,3,4,5,6,7,8],
    markets: [{ code:'WINNER', odds: genLaneOdds(8) }]
  };
}

// init rounds
['EPL','LIGA','UCL'].forEach(newFootballRound);
newColorRound(); newDogsRound(); newHorsesRound();

// tick
setInterval(()=>{
  const now = Date.now();
  Object.keys(LEAGUES).forEach(k=>{
    if (LEAGUES[k].endsAt <= now) newFootballRound(k);
  });
  ['COLOR','DOGS','HORSES'].forEach(p=>{
    if (PRODUCTS_STATE[p].endsAt <= now) {
      if (p==='COLOR') newColorRound();
      if (p==='DOGS') newDogsRound();
      if (p==='HORSES') newHorsesRound();
    }
  });
}, 1000);

// API for virtual lobby
app.get('/virtual/state', (_req,res)=>{
  res.json({
    leagues: Object.values(LEAGUES).map(x=>({code:x.code,name:x.name,endsAt:x.endsAt,round:x.round})),
    products: ['COLOR','DOGS','HORSES'].map(p=>({code:p, endsAt: PRODUCTS_STATE[p].endsAt, round: PRODUCTS_STATE[p].round}))
  });
});
app.get('/virtual/league/:code', (req,res)=>{
  const l = LEAGUES[req.params.code.toUpperCase()];
  if (!l) return res.status(404).json({error:'no league'});
  res.json(l);
});
app.get('/virtual/product/:code', (req,res)=>{
  const p = PRODUCTS_STATE[req.params.code.toUpperCase()];
  if (!p) return res.status(404).json({error:'no product'});
  res.json(p);
});

// =====================================================================
// Core app: wallets, tickets, barcode, POS
// =====================================================================
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
  log('DB migrate: OK');
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

// auth
function needAdmin(req, res, next) {
  if (req.header('x-admin-key') === process.env.ADMIN_KEY) return next();
  return res.status(401).json({error:'admin key required'});
}
function needCashier(req, res, next) {
  if (req.header('x-cashier-key') === process.env.CASHIER_KEY) return next();
  return res.status(401).json({error:'cashier key required'});
}

// utils
function makeTicketUid() { return 'T' + crypto.randomBytes(6).toString('hex').toUpperCase(); }

// endpoints
app.get('/health', (_req, res)=> res.json({ok:true}));

app.get('/balances', needAdmin, async (_req,res) => {
  const { rows } = await pool.query('SELECT owner_type, owner_id, balance_cents FROM wallets ORDER BY owner_type, owner_id');
  res.json(rows);
});

app.get('/admin/ledger', needAdmin, async (_req,res)=>{
  const { rows } = await pool.query('SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  if (!stake || stake < MIN_STAKE) {
    return res.status(400).json({error:'min stake '+(MIN_STAKE/100)+' KES'});
  }
  if (stake > MAX_STAKE) {
    return res.status(400).json({error:'max stake '+(MAX_STAKE/100)+' KES'});
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

    await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2',[stake, cashier.id]);
    const ticketUid = makeTicketUid();
    await ledger(client, cashier.id, 'debit', stake, 'stake', ticketUid, 'stake reserved');

    await client.query(
      'INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents,odds,product,event_code,market_code,selection_code,pick_label) VALUES ($1,$2,$3,\'PENDING\',$4,$5,$6,$7,$8,$9,$10)',
      [ticketUid,'cashier1',stake,potential,odds,product,event_code,market_code,selection_code,pick_label]
    );

    res.json({ok:true,ticket_uid:ticketUid,stake_cents:stake,odds,product,potential_win_cents:potential,event_code,market_code,selection_code,pick_label});
  }).catch(e=> res.status(400).json({error:e.message}));
});

app.post('/admin/settle-ticket', needAdmin, async (req,res)=>{
  const { uid, outcome } = req.body;
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
      payout = t.stake_cents;
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'refund',uid,'ticket cancelled');
    }

    await client.query('UPDATE tickets SET status=$1, payout_cents=$2, settled_at=now() WHERE id=$3',[outcome,payout,t.id]);
  }).then(()=> res.json({ok:true, uid, outcome}))
    .catch(e=> res.status(400).json({error:e.message}));
});

app.get('/tickets/:uid', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).json({ error: 'ticket not found' });
  res.json(rows[0]);
});

app.get('/cashier/tickets', needCashier, async (_req, res) => {
  const cashierId = 'cashier1';
  const { rows } = await pool.query(
    'SELECT uid, stake_cents, potential_win_cents, status, payout_cents, created_at, odds, product, event_code, market_code, selection_code, pick_label FROM tickets WHERE cashier_id=$1 ORDER BY created_at DESC LIMIT 20',
    [cashierId]
  );
  res.json(rows);
});

app.get('/tickets/:uid/barcode.png', async (req, res) => {
  if (!bwipjs) return res.status(503).json({ error: 'barcode unavailable' });
  const { uid } = req.params;
  try {
    const png = await bwipjs.toBuffer({ bcid:'code128', text:uid, scale:3, height:10, includetext:true, textxalign:'center' });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch {
    res.status(400).json({ error: 'barcode failed' });
  }
});

app.get('/tickets/:uid/print', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).send('Ticket not found');
  const t = rows[0];
  const color = t.status==='WON'?'#16a34a': t.status==='LOST'?'#dc2626':'#6b7280';
  res.set('Content-Type', 'text/html');
  res.send('<!doctype html><html><head><meta charset="utf-8"/><title>Ticket '+t.uid+'</title><style>body{font-family:system-ui,Arial;padding:16px}.card{width:380px;border:1px solid #e5e7eb;border-radius:12px;padding:16px;position:relative;overflow:hidden}.row{display:flex;justify-content:space-between;margin:6px 0}.bar{margin:12px auto;text-align:center}.wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:52px;opacity:0.12;color:'+color+';transform:rotate(-18deg)}.badge{display:inline-block;padding:4px 10px;border-radius:9999px;color:white;background:'+color+'}.muted{color:#6b7280}.tiny{font-size:12px}</style></head><body><div class="card"><div class="wm">'+t.status+'</div><div class="row"><div><strong>Mastermind Bet</strong></div><div class="badge">'+t.status+'</div></div><div class="row"><div class="muted">Ticket</div><div>'+t.uid+'</div></div><div class="row"><div class="muted">Cashier</div><div>'+t.cashier_id+'</div></div><div class="row"><div class="muted">Product</div><div>'+(t.product||'-')+'</div></div><div class="row"><div class="muted">Pick</div><div>'+(t.pick_label||t.selection_code||'-')+'</div></div><div class="row"><div class="muted">Event</div><div class="tiny">'+(t.event_code||'-')+'</div></div><div class="row"><div class="muted">Market</div><div>'+(t.market_code||'-')+'</div></div><div class="row"><div class="muted">Odds</div><div>'+(t.odds?Number(t.odds).toFixed(2):'-')+'</div></div><div class="row"><div class="muted">Stake</div><div>KES '+(t.stake_cents/100).toFixed(0)+'</div></div><div class="row"><div class="muted">Potential Win</div><div>KES '+((t.potential_win_cents||0)/100).toFixed(0)+'</div></div><div class="row"><div class="muted">Payout</div><div>KES '+((t.payout_cents||0)/100).toFixed(0)+'</div></div><div class="bar"><img src="/tickets/'+t.uid+'/barcode.png" alt="barcode"/></div><div class="muted tiny" style="text-align:center">Verify: mastermind-bet.com/tickets/'+t.uid+'</div></div><script>window.print()</script></body></html>');
});

// POS remains (for float/stake etc)
app.get('/pos', (_req, res) => {
  res.set('Content-Type','text/html');
  res.send('<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Mastermind Cashier</title><style>:root{--bg:#0b1220;--panel:#0f172a;--muted:#94a3b8;--text:#e2e8f0;--brand:#f59e0b;--accent:#1f2937;--ok:#16a34a;--warn:#f59e0b;--bad:#dc2626}*{box-sizing:border-box}body{font-family:system-ui,Arial;background:var(--bg);color:var(--text);margin:0}.wrap{max-width:1200px;margin:0 auto;padding:16px}.panel{background:var(--panel);border:1px solid #1f2937;border-radius:12px;padding:12px;margin:12px 0}.grid{display:grid;gap:12px}.grid.cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}@media (max-width:900px){.grid.cols-4{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:560px){.grid.cols-4{grid-template-columns:1fr}}input,button,select{padding:10px 12px;border-radius:10px;border:1px solid #243044;background:#0b1528;color:var(--text)}.btn{background:var(--brand);color:#111;border:none;cursor:pointer;font-weight:700}.muted{color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #223048;padding:8px;text-align:left;font-size:14px}.tabs{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}.tab{padding:8px 12px;border-radius:9999px;border:1px solid #334155;background:#0b1528;cursor:pointer}.tab.active{background:#ef4444;border-color:#ef4444}.badge{padding:4px 8px;border-radius:9999px;background:#1f2937}.tiny{font-size:12px}</style></head><body><div class="wrap"><h2>Cashier Dashboard</h2><div class="panel"><input id="key" placeholder="x-cashier-key" style="width:260px"/></div><div class="grid cols-4"><div class="panel"><div class="muted tiny">Float Balance</div><div id="float">KES 0</div></div><div class="panel"><div class="muted tiny">Today Stake</div><div id="tStake">KES 0</div></div><div class="panel"><div class="muted tiny">Today Payouts</div><div id="tPay">KES 0</div></div><div class="panel"><div class="muted tiny">Pending / Won / Lost</div><div id="stats">0 / 0 / 0</div></div></div><div class="panel"><div class="muted tiny">Limits</div><div>Min 20 - Max 1000 • Max Payout 20000</div></div><div class="panel"><div class="tabs" id="tabs"><button class="tab active" data-product="FOOTBALL">Football</button><button class="tab" data-product="COLOR">Color</button><button class="tab" data-product="DOGS">Dogs</button><button class="tab" data-product="HORSES">Horses</button></div><div class="muted tiny" style="margin:6px 0">Manual single (stake + odds). Use tabs to set the product.</div><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="stake" type="number" placeholder="Stake KES (min 20, max 1000)"/><input id="odds" type="number" step="0.01" placeholder="Odds (e.g. 2.10)"/><button class="btn" onclick="placeBet()">Place Manual</button></div></div><div class="panel"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong>Recent Tickets</strong><button class="btn" onclick="loadTickets()">Refresh</button></div><table id="t"><thead><tr><th>UID</th><th>Stake</th><th>Odds</th><th>Product</th><th>Pick</th><th>Status</th><th>Print</th></tr></thead><tbody></tbody></table></div></div><script>var currentProduct="FOOTBALL";Array.prototype.forEach.call(document.querySelectorAll("#tabs .tab"),function(btn){btn.addEventListener("click",function(){Array.prototype.forEach.call(document.querySelectorAll("#tabs .tab"),function(b){b.classList.remove("active")});btn.classList.add("active");currentProduct=btn.dataset.product;});});function fmtKES(c){return "KES "+Math.round((c||0)/100)}async function placeBet(){var key=document.getElementById("key").value.trim();var stakeKES=parseInt(document.getElementById("stake").value||"0",10);var stake_cents=stakeKES*100;var odds=parseFloat(document.getElementById("odds").value||"2.00");var res=await fetch("/bets/place",{method:"POST",headers:{"Content-Type":"application/json","x-cashier-key":key},body:JSON.stringify({stake_cents:stake_cents,odds:odds,product:currentProduct})});var data=await res.json();alert(JSON.stringify(data,null,2));loadTickets()}async function loadTickets(){var key=document.getElementById("key").value.trim();var res=await fetch("/cashier/tickets",{headers:{"x-cashier-key":key}});var rows=await res.json();var tb=document.querySelector("#t tbody");tb.innerHTML="";(rows||[]).forEach(function(r){var tr=document.createElement("tr");tr.innerHTML="<td>"+r.uid+"</td>"+"<td>"+fmtKES(r.stake_cents)+"</td>"+"<td>"+(r.odds?Number(r.odds).toFixed(2):"-")+"</td>"+"<td><span class=\\"badge\\">"+(r.product||"-")+"</span></td>"+"<td>"+(r.pick_label||r.selection_code||"-")+"</td>"+"<td>"+r.status+"</td>"+"<td><a href=\\"/tickets/"+r.uid+"/print\\" target=\\"_blank\\">Print</a></td>";tb.appendChild(tr);});}</script></body></html>');
});

// NEW: Virtual lobby page like screenshots
app.get('/virtual', (_req,res)=>{
  res.set('Content-Type','text/html');
  res.send('<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Virtual Sports</title><style>body{margin:0;background:#0b1220;color:#e2e8f0;font-family:system-ui,Arial}header{display:flex;gap:10px;align-items:center;padding:10px 12px;background:#0f172a;border-bottom:1px solid #1f2937;position:sticky;top:0}.tab{padding:8px 12px;border-radius:9999px;background:#111827;border:1px solid #334155;cursor:pointer}.tab.active{background:#ef4444;border-color:#ef4444}.wrap{display:grid;grid-template-columns:1fr 320px;gap:12px;padding:12px}@media(max-width:1000px){.wrap{grid-template-columns:1fr}}.panel{background:#0f172a;border:1px solid #1f2937;border-radius:12px;padding:10px}.timer{font-weight:700}.league-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.league{padding:6px 10px;border-radius:10px;background:#111827;border:1px solid #334155;cursor:pointer}.league.active{background:#1d4ed8;border-color:#1d4ed8}.tbl{width:100%;border-collapse:collapse}.tbl th,.tbl td{border-bottom:1px solid #223048;padding:6px 8px;font-size:14px}.btn-odd{display:inline-block;min-width:52px;text-align:center;background:#111827;border:1px solid #334155;border-radius:8px;padding:6px 8px;margin:2px;cursor:pointer}.btn-odd:hover{outline:2px solid #f59e0b}.right{position:sticky;top:56px;height:max-content}.key{width:100%;padding:8px 10px;border-radius:8px;border:1px solid #334155;background:#0b1528;color:#e2e8f0}</style></head><body><header><span class="tab active" data-prod="FOOTBALL">Football</span><span class="tab" data-prod="COLOR">Color</span><span class="tab" data-prod="DOGS">Dogs</span><span class="tab" data-prod="HORSES">Horses</span><div style="margin-left:auto;display:flex;gap:8px;align-items:center"><span>Cashier key:</span><input id="key" class="key" placeholder="x-cashier-key" style="max-width:260px"/></div></header><div class="wrap"><div class="panel"><div id="content"></div></div><div class="right"><div class="panel"><div style="display:flex;justify-content:space-between;align-items:center"><strong>Fastbet</strong><button id="refresh" class="tab">Refresh</button></div><div id="tickets" class="tiny"></div></div></div></div><script>var PROD="FOOTBALL";Array.prototype.forEach.call(document.querySelectorAll("header .tab"),function(t){t.addEventListener("click",function(){Array.prototype.forEach.call(document.querySelectorAll("header .tab"),function(x){x.classList.remove("active")});t.classList.add("active");PROD=t.getAttribute("data-prod");render()})});function fmt(t){var s=Math.max(0,Math.floor((t-Date.now())/1000));var m=String(Math.floor(s/60)).padStart(2,"0");var k=String(s%60).padStart(2,"0");return m+":"+k}async function fetchJSON(u){var r=await fetch(u);return r.json()}function cellOdd(o,cb){var a=document.createElement("span");a.className="btn-odd";a.textContent=o.toFixed?o.toFixed(2):o;a.onclick=cb;return a}async function render(){var box=document.getElementById("content");box.innerHTML="";if(PROD==="FOOTBALL"){var st=await fetchJSON("/virtual/state");var leagues=st.leagues||[];var nav=document.createElement("div");nav.className="league-tabs";(leagues).forEach(function(L,i){var b=document.createElement("span");b.className="league"+(i===0?" active":"");b.setAttribute("data-code",L.code);b.textContent=L.code+" • R"+L.round+" • "+fmt(L.endsAt);b.onclick=function(){Array.prototype.forEach.call(nav.querySelectorAll(".league"),function(x){x.classList.remove("active")});b.classList.add("active");loadLeague(L.code)};nav.appendChild(b)});box.appendChild(nav);if(leagues[0]) loadLeague(leagues[0].code);async function loadLeague(code){var data=await fetchJSON("/virtual/league/"+code);var t=document.createElement("table");t.className="tbl";t.innerHTML="<thead><tr><th>#</th><th>Match</th><th>1</th><th>X</th><th>2</th><th>GG</th><th>NG</th><th>OV 2.5</th><th>UN 2.5</th></tr></thead><tbody></tbody>";var tb=t.querySelector("tbody");(data.fixtures||[]).forEach(function(f){var tr=document.createElement("tr");var label=f.home+" vs "+f.away;var m1=f.markets["1X2"], gg=f.markets["GG/NG"], ou=f.markets["1X2 OV/UN 2.5"];tr.innerHTML="<td>"+f.id+"</td><td>"+label+"</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>";tb.appendChild(tr);var key=document.getElementById("key").value.trim();tr.children[2].appendChild(cellOdd(m1["1"], function(){place(label,"1X2","1",m1["1"], key, "FOOTBALL", data, f)}));tr.children[3].appendChild(cellOdd(m1["X"], function(){place(label,"1X2","X",m1["X"], key, "FOOTBALL", data, f)}));tr.children[4].appendChild(cellOdd(m1["2"], function(){place(label,"1X2","2",m1["2"], key, "FOOTBALL", data, f)}));tr.children[5].appendChild(cellOdd(gg["GG"], function(){place(label,"GG/NG","GG",gg["GG"], key, "FOOTBALL", data, f)}));tr.children[6].appendChild(cellOdd(gg["NG"], function(){place(label,"GG/NG","NG",gg["NG"], key, "FOOTBALL", data, f)}));tr.children[7].appendChild(cellOdd(ou["OV2.5"], function(){place(label,"1X2 OV/UN 2.5","OV2.5",ou["OV2.5"], key, "FOOTBALL", data, f)}));tr.children[8].appendChild(cellOdd(ou["UN2.5"], function(){place(label,"1X2 OV/UN 2.5","UN2.5",ou["UN2.5"], key, "FOOTBALL", data, f)}));});box.appendChild(t);} } else { // COLOR / DOGS / HORSES
    var p=await fetchJSON("/virtual/product/"+PROD);var h=document.createElement("div");h.innerHTML="<div style=\\"display:flex;gap:8px;align-items:center\\"><strong>"+PROD+"</strong><span class=\\"tab\\">R"+p.round+"</span><span class=\\"tab\\">"+fmt(p.endsAt)+"</span></div>";box.appendChild(h);var t=document.createElement("table");t.className="tbl";var tb=document.createElement("tbody");t.appendChild(tb);if(PROD==="COLOR"){tb.innerHTML="<tr><th>Market</th><th colspan=\\"6\\">Odds</th></tr>";(p.markets||[]).forEach(function(m){var tr=document.createElement("tr");tr.innerHTML="<td>"+m.code+"</td>";tb.appendChild(tr);Object.keys(m.odds).forEach(function(k){var td=document.createElement("td");td.appendChild(cellOdd(m.odds[k],function(){var key=document.getElementById("key").value.trim();place("Color "+k,m.code,k,m.odds[k],key,"COLOR",p,null)}));tr.appendChild(td);});});} else {tb.innerHTML="<tr><th>Lane</th><th>Winner</th></tr>";(p.markets||[]).forEach(function(m){Object.keys(m.odds).forEach(function(lane){var tr=document.createElement("tr");tr.innerHTML="<td>#"+lane+"</td>";var td=document.createElement("td");td.appendChild(cellOdd(m.odds[lane],function(){var key=document.getElementById("key").value.trim();place(PROD+" lane "+lane,"WINNER",lane,m.odds[lane],key,PROD,p,null)}));tr.appendChild(td);tb.appendChild(tr);});});}box.appendChild(t);} }async function place(label,market,sel,odds,key,product,ctx,fixture){var stakeKES=prompt("Stake KES (min 20, max 1000)","40");if(!stakeKES)return;var stake_cents=parseInt(stakeKES,10)*100;var event_code=(ctx.code||product)+"#R"+(ctx.round||0)+"#"+label;var pick=(label+" • "+market+" • "+sel);try{var r=await fetch("/bets/place",{method:"POST",headers:{"Content-Type":"application/json","x-cashier-key":key},body:JSON.stringify({stake_cents:stake_cents,odds:odds,product:product,event_code:event_code,market_code:market,selection_code:sel,pick_label:pick})});var j=await r.json();alert(JSON.stringify(j,null,2));loadTickets();}catch(e){alert("failed")}}async function loadTickets(){var key=document.getElementById("key").value.trim();var r=await fetch("/cashier/tickets",{headers:{"x-cashier-key":key}});var rows=await r.json();var el=document.getElementById("tickets");var html="";(rows||[]).forEach(function(x){html+="<div style=\\"border-bottom:1px solid #223048;padding:6px 0\\"><div><strong>"+x.uid+"</strong> • "+(x.product||"-")+" • "+(x.status)+"</div><div class=\\"tiny\\">"+(x.pick_label||x.selection_code||"-")+" • KES "+Math.round((x.stake_cents||0)/100)+" @ "+(x.odds?Number(x.odds).toFixed(2):"-")+"</div></div>"});el.innerHTML=html||"<div class=\\"muted\\">No tickets yet</div>"}document.getElementById("refresh").onclick=loadTickets;render();loadTickets();</script></body></html>');
});

// start
migrate()
  .catch(err => log('DB migrate FAILED', err.message))
  .finally(() => {
    app.listen(PORT, ()=> log('App on :'+PORT));
  });
