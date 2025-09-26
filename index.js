// index.js — API + POS + Virtual (serves static HTML files instead of giant strings)
// run: npm i express pg dotenv bwip-js && pm2 start index.js --name mastermind-bet --update-env
require('dotenv').config();
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const bwipjs = require('bwip-js');

const app = express();
app.use(express.json());

// serve static assets from /public
app.use(express.static(path.join(__dirname, 'public')));

// --- DB ----------------------------------------------------------------------
if (!process.env.DATABASE_URL) {
  console.error(new Date().toISOString() + ': No DATABASE_URL in env — DB features will be limited.');
}
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

async function withTxn(fn) {
  if (!pool) throw new Error('DB not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  if (!pool) return;
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
  CREATE TABLE IF NOT EXISTS tickets (
    id BIGSERIAL PRIMARY KEY,
    uid TEXT UNIQUE NOT NULL,
    cashier_id TEXT NOT NULL,
    stake_cents BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    potential_win_cents BIGINT,
    payout_cents BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    odds NUMERIC(7,3),
    product TEXT,
    event_code TEXT,
    market_code TEXT,
    selection_code TEXT,
    pick_label TEXT
  );
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
  console.log(new Date().toISOString() + ': DB migrate: OK');
}
migrate().catch(e=>{
  console.error(new Date().toISOString() + ': DB migrate FAILED', e.message);
});

// --- helpers -----------------------------------------------------------------
const MIN_STAKE = parseInt(process.env.MIN_STAKE_CENTS || '2000', 10); // 20 KES (cents)
const MAX_STAKE = 100000;   // 1,000 KES (cents)
const MAX_PAYOUT = 2000000; // 20,000 KES (cents)
const PRODUCTS = new Set(['FOOTBALL','COLOR','DOGS','HORSES']);

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
  const { rows } = await client.query('UPDATE wallets SET balance_cents = balance_cents ' + (type==='credit'?'+':'-') + ' $1 WHERE id=$2 RETURNING balance_cents',[amount, walletId]);
  await client.query(
    'INSERT INTO wallet_ledger(wallet_id,entry_type,amount_cents,balance_after_cents,ref_type,ref_id,memo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [walletId, type, amount, rows[0].balance_cents, refType, refId, memo||null]
  );
}
function need(role, keyName) {
  return (req,res,next)=>{
    if (req.header(keyName) === process.env[role]) return next();
    return res.status(401).json({error:`${keyName} required`});
  };
}
const needAdmin   = need('ADMIN_KEY','x-admin-key');
const needAgent   = need('AGENT_KEY','x-agent-key');
const needCashier = need('CASHIER_KEY','x-cashier-key');
function makeTicketUid(){ return 'T' + crypto.randomBytes(6).toString('hex').toUpperCase(); }

// --- health ------------------------------------------------------------------
app.get('/health', (_req,res)=> res.json({ok:true}));

// --- POS minimal page (served from /public/pos.html) ------------------------
app.get('/pos', (_req,res)=>{
  res.sendFile(path.join(__dirname,'public','pos.html'));
});

// --- Tickets -----------------------------------------------------------------
app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  if (!stake || stake < MIN_STAKE) return res.status(400).json({error:`min stake ${MIN_STAKE/100} KES`});
  if (stake > MAX_STAKE) return res.status(400).json({error:`max stake ${MAX_STAKE/100} KES`});

  let odds = parseFloat(req.body.odds); if (!Number.isFinite(odds) || odds < 1.01) odds = 2.00;
  let product = (req.body.product||'FOOTBALL').toString().toUpperCase();
  if (!PRODUCTS.has(product)) product = 'FOOTBALL';

  const event_code = req.body.event_code || null;
  const market_code = req.body.market_code || null;
  const selection_code = req.body.selection_code || null;
  const pick_label = req.body.pick_label || null;

  const potential = Math.min(Math.floor(stake * odds), MAX_PAYOUT);

  try {
    const out = await withTxn(async (client)=>{
      const cashier = await getWallet(client,'cashier','cashier1');
      if (cashier.balance_cents < stake) throw new Error('insufficient funds');
      await ledger(client, cashier.id, 'debit', stake, 'stake', 'reserve', 'stake reserved');
      const uid = makeTicketUid();
      await client.query(
        `INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents,odds,product,event_code,market_code,selection_code,pick_label)
         VALUES ($1,'cashier1',$2,'PENDING',$3,$4,$5,$6,$7,$8,$9)`,
        [uid, stake, potential, odds, product, event_code, market_code, selection_code, pick_label]
      );
      return { uid };
    });
    res.json({ok:true, ticket_uid: out.uid, stake_cents: stake, odds, product, potential_win_cents: potential, event_code, market_code, selection_code, pick_label});
  } catch(e){ res.status(400).json({error:e.message}); }
});

app.get('/cashier/tickets', needCashier, async (_req,res)=>{
  if (!pool) return res.json([]);
  const { rows } = await pool.query(
    `SELECT uid, stake_cents, potential_win_cents, status, payout_cents, created_at,
            odds, product, event_code, market_code, selection_code, pick_label
     FROM tickets WHERE cashier_id='cashier1' ORDER BY created_at DESC LIMIT 20`
  );
  res.json(rows);
});

app.get('/tickets/:uid', async (req,res)=>{
  if (!pool) return res.status(404).json({error:'no db'});
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1',[req.params.uid]);
  if (!rows[0]) return res.status(404).json({error:'ticket not found'});
  res.json(rows[0]);
});

app.get('/tickets/:uid/barcode.png', async (req,res)=>{
  try {
    const png = await bwipjs.toBuffer({ bcid:'code128', text:req.params.uid, scale:3, height:10, includetext:true, textxalign:'center' });
    res.type('png').send(png);
  } catch { res.status(400).json({error:'barcode failed'}); }
});

app.get('/tickets/:uid/print', async (req,res)=>{
  if (!pool) return res.status(404).send('No DB');
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1',[req.params.uid]);
  if (!rows[0]) return res.status(404).send('Ticket not found');
  const t = rows[0];
  const color = t.status==='WON' ? '#16a34a' : t.status==='LOST' ? '#dc2626' : '#6b7280';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${t.uid}</title>
  <style>body{font-family:system-ui,Arial;padding:16px}.card{width:380px;border:1px solid #e5e7eb;border-radius:12px;padding:16px;position:relative;overflow:hidden}
  .row{display:flex;justify-content:space-between;margin:6px 0}.bar{text-align:center;margin:12px auto}
  .wm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:52px;opacity:.12;color:${color};transform:rotate(-18deg)}
  .badge{display:inline-block;padding:4px 10px;border-radius:9999px;color:#fff;background:${color}}.muted{color:#6b7280}.tiny{font-size:12px}</style></head>
  <body><div class="card"><div class="wm">${t.status}</div>
  <div class="row"><div><strong>Mastermind Bet</strong></div><div class="badge">${t.status}</div></div>
  <div class="row"><div class="muted">Ticket</div><div>${t.uid}</div></div>
  <div class="row"><div class="muted">Product</div><div>${t.product||'-'}</div></div>
  <div class="row"><div class="muted">Pick</div><div>${t.pick_label||t.selection_code||'-'}</div></div>
  <div class="row"><div class="muted">Odds</div><div>${t.odds?Number(t.odds).toFixed(2):'-'}</div></div>
  <div class="row"><div class="muted">Stake</div><div>KES ${(t.stake_cents/100).toFixed(0)}</div></div>
  <div class="row"><div class="muted">Potential</div><div>KES ${((t.potential_win_cents||0)/100).toFixed(0)}</div></div>
  <div class="row"><div class="muted">Payout</div><div>KES ${((t.payout_cents||0)/100).toFixed(0)}</div></div>
  <div class="bar"><img src="/tickets/${t.uid}/barcode.png"/></div>
  <div class="muted tiny" style="text-align:center">Verify: mastermind-bet.com/tickets/${t.uid}</div></div>
  <script>window.print()</script></body></html>`);
});

// --- Virtual data (simple generator so the page renders) ---------------------
const LEAGUES = [
  { code:'CHAMPS', name:'Champions Cup', teams: ['PSG','MCI','RMA','FCB','MUN','BAR','ROM','JUV','PSV','AEK','NAP','ZEN','BVB','CEL','LIV','CHE'] },
  { code:'EPL',    name:'Premier League', teams: ['MUN','TOT','EVE','CHE','NEW','WOL','LIV','ARS','NOT','SOU','BOU','CRY','LEI','ASV','WHU','BRN','BRI','LEE','FUL','MCI'] },
  { code:'LIGA',   name:'Liga', teams: ['CAD','RVA','VIL','SEV','ATM','GRO','ESP','ELC','MAL','FCB','RMA','GET','ATH','OSA','CEL','BET','VAL','RSO','VAL','ALM'] },
];
function rnd(min,max){ return +(min + Math.random()*(max-min)).toFixed(2); }
function pickOdds(){
  const one = rnd(1.2,6.5), draw=rnd(2.8,3.6), two=rnd(1.2,6.5);
  return {
    '1X2': {'1':one,'X':draw,'2':two},
    'GG/NG': {'GG':rnd(1.5,2.3),'NG':rnd(1.5,2.3)},
    '1X2 OV/UN 2.5': {'OV2.5':rnd(1.7,2.5),'UN2.5':rnd(1.3,2.1)}
  };
}
app.get('/virtual', (_req,res)=> res.sendFile(path.join(__dirname,'public','virtual.html')));
app.get('/virtual/state', (_req,res)=>{
  const now = Date.now();
  const leagues = LEAGUES.map((l,i)=>({ code:l.code, round: (i+1), endsAt: now + (i+1)*180000 }));
  res.json({ leagues });
});
app.get('/virtual/league/:code', (req,res)=>{
  const L = LEAGUES.find(x=>x.code===req.params.code) || LEAGUES[0];
  const fixtures = [];
  for (let i=0;i<Math.min(8, Math.floor(L.teams.length/2));i++){
    const home = L.teams[i*2], away = L.teams[i*2+1];
    fixtures.push({ id:i+1, home, away, markets: pickOdds() });
  }
  res.json({ code:L.code, fixtures });
});

// --- start -------------------------------------------------------------------
const port = parseInt(process.env.PORT||'3000',10);
app.listen(port, ()=> console.log('App on :' + port));
