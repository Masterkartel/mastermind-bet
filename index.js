// index.js — Mastermind Bet (wallets + tickets + barcode/print + virtuals: football, color, dogs, horses)
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const bwipjs = require('bwip-js');

const app = express();
app.use(express.json());
app.use(express.static('public')); // for /logos, /icons, etc

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MIN_STAKE = parseInt(process.env.MIN_STAKE_CENTS || '2000', 10);   // 20 KES
const MAX_STAKE = 100000;   // 1000 KES
const MAX_PAYOUT = 2000000; // 20,000 KES

// ---------- helpers ----------
async function withTxn(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
function now() { return new Date(); }
function makeUid(prefix='T') { return prefix + crypto.randomBytes(6).toString('hex').toUpperCase(); }
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }

// ---------- bootstrap / migrations ----------
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

  CREATE TABLE IF NOT EXISTS tickets (
    id BIGSERIAL PRIMARY KEY,
    uid TEXT UNIQUE NOT NULL,
    cashier_id TEXT NOT NULL,
    stake_cents BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    potential_win_cents BIGINT,
    payout_cents BIGINT,
    odds NUMERIC(6,2),
    product_code TEXT,          -- FOOTBALL | COLOR | DOGS | HORSES
    event_id BIGINT,            -- virtual event id
    market_code TEXT,           -- e.g. 1X2, GGNG, OU25, COLOR, RACE_WIN
    selection_code TEXT,        -- e.g. 1, X, 2 / GG / OV / RED / #1
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
  );

  -- virtual engine
  CREATE TABLE IF NOT EXISTS virtual_events (
    id BIGSERIAL PRIMARY KEY,
    product_code TEXT NOT NULL,     -- FOOTBALL | COLOR | DOGS | HORSES
    league_code TEXT,               -- e.g. EPL/WEEK34 for football (display only)
    home_team_code TEXT,
    away_team_code TEXT,
    start_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN'  -- OPEN -> CLOSED -> RESULTED
  );

  CREATE TABLE IF NOT EXISTS virtual_markets (
    id BIGSERIAL PRIMARY KEY,
    event_id BIGINT NOT NULL REFERENCES virtual_events(id) ON DELETE CASCADE,
    market_code TEXT NOT NULL,        -- 1X2, GGNG, OU25, COLOR, RACE_WIN
    selection_code TEXT NOT NULL,     -- 1/X/2, GG/NG, OV/UN, RED/BLACK/GREEN, #1..#8
    odds NUMERIC(6,2) NOT NULL
  );

  CREATE TABLE IF NOT EXISTS virtual_results (
    event_id BIGINT PRIMARY KEY REFERENCES virtual_events(id) ON DELETE CASCADE,
    result_json JSONB NOT NULL,      -- { "1X2":"1", "GGNG":"GG", "OU25":"OV" } or { "COLOR":"RED" } or { "RACE_WIN":"#5" }
    settled_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- ensure house + a default agent/cashier exist (legacy)
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

// ---------- auth (header keys for now) ----------
function needAdmin(req, res, next) {
  if (req.header('x-admin-key') === process.env.ADMIN_KEY) return next();
  return res.status(401).json({error:'admin key required'});
}
function needAgent(req, res, next) {
  if (req.header('x-agent-key') === process.env.AGENT_KEY) return next();
  return res.status(401).json({error:'agent key required'});
}
function needCashier(req, res, next) {
  // legacy single-key cashier
  if (req.header('x-cashier-key') === process.env.CASHIER_KEY) { req.cashier_code = 'cashier1'; return next(); }
  return res.status(401).json({error:'cashier key required'});
}

// ---------- utils ----------
function crestSvg(code){
  // fallback colored badge if no real logo file
  const colors = ['#2563eb','#10b981','#f59e0b','#ef4444','#7c3aed','#f97316'];
  const c = colors[Math.abs(code?.split('').reduce((a,ch)=>a+ch.charCodeAt(0),0)) % colors.length];
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect rx="4" width="20" height="20" fill="${c}"/><text x="10" y="13" font-size="10" text-anchor="middle" fill="white" font-family="Arial, sans-serif">${(code||'??').slice(0,2)}</text></svg>`;
}

// ---------- endpoints (core) ----------
app.get('/health', (_req,res)=> res.json({ok:true}));

app.get('/balances', needAdmin, async (_req,res) => {
  const { rows } = await pool.query('SELECT owner_type, owner_id, balance_cents FROM wallets ORDER BY owner_type, owner_id');
  res.json(rows);
});

app.get('/admin/ledger', needAdmin, async (_req,res)=>{
  const { rows } = await pool.query('SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

// place bet (with odds + market info)
app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  const odds = parseFloat(req.body.odds);
  const { product_code, event_id, market_code, selection_code } = req.body;

  if (!stake || stake < MIN_STAKE) return res.status(400).json({error:`min stake ${MIN_STAKE/100} KES`});
  if (stake > MAX_STAKE) return res.status(400).json({error:`max stake ${MAX_STAKE/100} KES`});
  if (!odds || odds < 1.01) return res.status(400).json({error:'valid odds required'});
  if (!product_code || !market_code || !selection_code) return res.status(400).json({error:'product_code, market_code, selection_code required'});

  await withTxn(async (client)=>{
    const cashier = await getWallet(client,'cashier',req.cashier_code);
    const w = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[cashier.id]);
    if (w.rows[0].balance_cents < stake) throw new Error('insufficient funds');

    await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2',[stake, cashier.id]);

    const ticketUid = makeUid('T');
    await ledger(client, cashier.id, 'debit', stake, 'stake', ticketUid, 'stake reserved');

    const potential = Math.min(Math.floor(stake * odds), MAX_PAYOUT);

    // attach event if provided
    let evId = event_id || null;
    if (!evId) {
      const ev = await client.query(
        `INSERT INTO virtual_events(product_code, league_code, start_at, status) VALUES ($1,$2,now() + interval '30 seconds','OPEN') RETURNING id`,
        [product_code, product_code==='COLOR'?'COLOR':'SIM']
      );
      evId = ev.rows[0].id;
    }

    await client.query(
      `INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents,odds,product_code,event_id,market_code,selection_code)
       VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,$9)`,
      [ticketUid, req.cashier_code, stake, potential, odds, product_code, evId, market_code, selection_code]
    );

    res.json({ok:true, ticket_uid: ticketUid, stake_cents: stake, odds, potential_win_cents: potential});
  }).catch(e=> res.status(400).json({error:e.message}));
});

// settle ticket (manual)
app.post('/admin/settle-ticket', needAdmin, async (req,res)=>{
  const { uid, outcome } = req.body; // WON | LOST | CANCELLED
  if (!uid || !['WON','LOST','CANCELLED'].includes(outcome)) return res.status(400).json({error:'uid + outcome required (WON|LOST|CANCELLED)'});

  await withTxn(async (client)=>{
    const { rows } = await client.query('SELECT * FROM tickets WHERE uid=$1 FOR UPDATE',[uid]);
    if (!rows[0]) throw new Error('ticket not found');
    const t = rows[0];
    if (t.status !== 'PENDING') throw new Error('already settled');

    const cashier = await getWallet(client,'cashier',t.cashier_id);
    let payout = 0;

    if (outcome === 'WON') {
      const defaultPotential = Math.min(t.stake_cents * (t.odds || 2), MAX_PAYOUT);
      payout = Math.min(t.potential_win_cents || defaultPotential, MAX_PAYOUT);
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'payout',uid,'ticket won');
    } else if (outcome === 'CANCELLED') {
      payout = t.stake_cents;
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'refund',uid,'ticket cancelled');
    }

    await client.query('UPDATE tickets SET status=$1, payout_cents=$2, settled_at=now() WHERE id=$3',[outcome, payout, t.id]);
  }).then(()=> res.json({ok:true, uid, outcome}))
    .catch(e=> res.status(400).json({error:e.message}));
});

// get ticket
app.get('/tickets/:uid', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).json({ error: 'ticket not found' });
  res.json(rows[0]);
});

// cashier last 20
app.get('/cashier/tickets', needCashier, async (_req, res) => {
  const cashierId = 'cashier1';
  const { rows } = await pool.query(
    `SELECT uid, stake_cents, odds, product_code, market_code, selection_code,
            potential_win_cents, status, payout_cents, created_at
     FROM tickets WHERE cashier_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [cashierId]
  );
  res.json(rows);
});

// barcode
app.get('/tickets/:uid/barcode.png', async (req, res) => {
  const { uid } = req.params;
  try {
    const png = await bwipjs.toBuffer({ bcid:'code128', text:uid, scale:3, height:10, includetext:true, textxalign:'center' });
    res.set('Content-Type','image/png'); res.send(png);
  } catch { res.status(400).json({ error: 'barcode failed' }); }
});

// printable ticket
app.get('/tickets/:uid/print', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).send('Ticket not found');
  const t = rows[0];
  const color =
    t.status === 'WON' ? '#16a34a' :
    t.status === 'LOST' ? '#dc2626' :
    '#6b7280';
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
</style></head><body>
<div class="card">
  <div class="wm">${t.status}</div>
  <div class="row"><div><strong>Mastermind Bet</strong></div><div class="badge">${t.status}</div></div>
  <div class="row"><div class="muted">Ticket</div><div>${t.uid}</div></div>
  <div class="row"><div class="muted">Cashier</div><div>${t.cashier_id}</div></div>
  <div class="row"><div class="muted">Product</div><div>${t.product_code||'-'}</div></div>
  <div class="row"><div class="muted">Market</div><div>${t.market_code||'-'}</div></div>
  <div class="row"><div class="muted">Pick</div><div>${t.selection_code||'-'}</div></div>
  <div class="row"><div class="muted">Odds</div><div>${t.odds?.toFixed? t.odds.toFixed(2): t.odds||'-'}</div></div>
  <div class="row"><div class="muted">Stake</div><div>KES ${(t.stake_cents/100).toFixed(0)}</div></div>
  <div class="row"><div class="muted">Potential Win</div><div>KES ${((t.potential_win_cents||0)/100).toFixed(0)}</div></div>
  <div class="row"><div class="muted">Payout</div><div>KES ${((t.payout_cents||0)/100).toFixed(0)}</div></div>
  <div class="bar"><img src="/tickets/${t.uid}/barcode.png" alt="barcode"/></div>
  <div class="muted" style="text-align:center;font-size:12px">Verify: mastermind-bet.com/tickets/${t.uid}</div>
</div>
<script>window.print()</script>
</body></html>`);
});

// ---------- VIRTUAL ENGINE (seed + list + result) ----------
const CLUBS = ['ARS','CHE','LIV','MCI','MUN','TOT','EVE','WHU','NEW','AVL','BHA','LEE','LEI','WOL','CRY','SOU','BUR','FUL','BRE','BOU'];

function gen1x2Odds() {
  // simple overround ~107-110%
  const baseH = 1.5 + Math.random()*2.2; // 1.5 - 3.7
  const baseA = 1.5 + Math.random()*2.2;
  const baseD = 2.8 + Math.random()*1.6;
  const scale = 1.06 + Math.random()*0.05;
  return {
    '1': clamp((baseH*scale).toFixed(2), 1.15, 9.99),
    'X': clamp((baseD*scale).toFixed(2), 1.15, 9.99),
    '2': clamp((baseA*scale).toFixed(2), 1.15, 9.99)
  };
}
function genGGNG(){ return { GG: (1.90+Math.random()*0.6).toFixed(2), NG: (1.30+Math.random()*0.5).toFixed(2) }; }
function genOU25(){ return { OV: (1.70+Math.random()*0.9).toFixed(2), UN: (1.25+Math.random()*0.5).toFixed(2) }; }
function genOU15(){ return { OV: (1.30+Math.random()*0.3).toFixed(2), UN: (2.00+Math.random()*0.7).toFixed(2) }; }
function genOU05(){ return { OV: (1.15+Math.random()*0.3).toFixed(2), UN: (2.20+Math.random()*1.3).toFixed(2) }; }

async function createFootballEvent(league='EPL', startsInSec=60) {
  const home = pick(CLUBS), away = pick(CLUBS.filter(c=>c!==home));
  const startAt = new Date(Date.now()+startsInSec*1000);
  const ev = await pool.query(
    `INSERT INTO virtual_events(product_code,league_code,home_team_code,away_team_code,start_at,status)
     VALUES ('FOOTBALL',$1,$2,$3,$4,'OPEN') RETURNING id`,
    [`${league}:WEEK`, home, away, startAt]
  );
  const id = ev.rows[0].id;
  const m1 = gen1x2Odds(); const gg = genGGNG(); const ou25 = genOU25(); const ou15=genOU15(); const ou05=genOU05();
  const ins = [];
  for (const [k,v] of Object.entries(m1)) ins.push([id,'1X2',k,v]);
  for (const [k,v] of Object.entries(gg)) ins.push([id,'GGNG',k,v]);
  for (const [k,v] of Object.entries(ou25)) ins.push([id,'OU25',k,v]);
  for (const [k,v] of Object.entries(ou15)) ins.push([id,'OU15',k,v]);
  for (const [k,v] of Object.entries(ou05)) ins.push([id,'OU05',k,v]);
  const textValues = ins.map((_,i)=>`($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4})`).join(',');
  const flat = ins.flat();
  await pool.query(`INSERT INTO virtual_markets(event_id,market_code,selection_code,odds) VALUES ${textValues}`, flat);
  return id;
}

async function createColorEvent(startsInSec=25) {
  const startAt = new Date(Date.now()+startsInSec*1000);
  const ev = await pool.query(
    `INSERT INTO virtual_events(product_code,league_code,start_at,status)
     VALUES ('COLOR','COLOR', $1,'OPEN') RETURNING id`, [startAt]
  );
  const id = ev.rows[0].id;
  const rows = [
    [id,'COLOR','RED',  (1.95).toFixed(2)],
    [id,'COLOR','BLACK',(1.95).toFixed(2)],
    [id,'COLOR','GREEN',(12.00).toFixed(2)]
  ];
  const textValues = rows.map((_,i)=>`($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4})`).join(',');
  await pool.query(`INSERT INTO virtual_markets(event_id,market_code,selection_code,odds) VALUES ${textValues}`, rows.flat());
  return id;
}

async function createRaceEvent(product='DOGS', startsInSec=40) {
  const startAt = new Date(Date.now()+startsInSec*1000);
  const ev = await pool.query(
    `INSERT INTO virtual_events(product_code,league_code,start_at,status)
     VALUES ($1,$2,$3,'OPEN') RETURNING id`, [product, product, startAt]
  );
  const id = ev.rows[0].id;
  const runners = Array.from({length:8}, (_,i)=> `#${i+1}`);
  const rows = runners.map((r)=>{
    // field odds roughly 1.7 .. 10.0
    const o = (1.6 + Math.random()*8.4);
    return [id,'RACE_WIN',r,o.toFixed(2)];
  });
  const textValues = rows.map((_,i)=>`($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4})`).join(',');
  await pool.query(`INSERT INTO virtual_markets(event_id,market_code,selection_code,odds) VALUES ${textValues}`, rows.flat());
  return id;
}

// seed cadence
async function seedTick() {
  // football: ensure ~10 OPEN events in next 2 minutes
  const f = await pool.query(`SELECT count(*)::int c FROM virtual_events WHERE product_code='FOOTBALL' AND status='OPEN' AND start_at > now()`);
  for (let i=f.rows[0].c; i<10; i++) await createFootballEvent('EPL', 20 + i*10);

  // color: ensure 4 opens
  const c = await pool.query(`SELECT count(*)::int c FROM virtual_events WHERE product_code='COLOR' AND status='OPEN' AND start_at > now()`);
  for (let i=c.rows[0].c; i<4; i++) await createColorEvent(12 + i*6);

  // dogs + horses: 3 each
  const d = await pool.query(`SELECT count(*)::int c FROM virtual_events WHERE product_code='DOGS' AND status='OPEN' AND start_at > now()`);
  for (let i=d.rows[0].c; i<3; i++) await createRaceEvent('DOGS', 25 + i*10);
  const h = await pool.query(`SELECT count(*)::int c FROM virtual_events WHERE product_code='HORSES' AND status='OPEN' AND start_at > now()`);
  for (let i=h.rows[0].c; i<3; i++) await createRaceEvent('HORSES', 30 + i*10);
}

// roll statuses & result events
async function settleTick() {
  // CLOSE events 5s before start
  await pool.query(`UPDATE virtual_events SET status='CLOSED' WHERE status='OPEN' AND start_at < now() + INTERVAL '5 seconds'`);

  // RESULT events that passed start_at
  const { rows } = await pool.query(`SELECT * FROM virtual_events WHERE status='CLOSED' AND start_at <= now()`);
  for (const ev of rows) {
    let result = {};
    if (ev.product_code === 'FOOTBALL') {
      // random but coherent: goals 0..5 each
      const hg = Math.floor(Math.random()*6), ag = Math.floor(Math.random()*6);
      const oneXtwo = hg>ag ? '1' : (hg<ag ? '2' : 'X');
      result = {
        '1X2': oneXtwo,
        'GGNG': (hg>0 && ag>0)?'GG':'NG',
        'OU25': (hg+ag>2)?'OV':'UN',
        'OU15': (hg+ag>1)?'OV':'UN',
        'OU05': (hg+ag>0)?'OV':'UN'
      };
    } else if (ev.product_code === 'COLOR') {
      result = { 'COLOR': pick(['RED','BLACK','GREEN','RED','BLACK']) }; // bias to red/black
    } else {
      // race
      const win = '#'+(1+Math.floor(Math.random()*8));
      result = { 'RACE_WIN': win };
    }
    await withTxn(async (client)=>{
      await client.query('INSERT INTO virtual_results(event_id,result_json) VALUES ($1,$2)', [ev.id, result]);
      await client.query('UPDATE virtual_events SET status=\'RESULTED\' WHERE id=$1', [ev.id]);

      // settle tickets tied to this event
      const tix = await client.query(`SELECT * FROM tickets WHERE status='PENDING' AND event_id=$1`, [ev.id]);
      for (const t of tix.rows) {
        const winSel = result[t.market_code];
        const won = (winSel && winSel === t.selection_code);
        const cashier = await getWallet(client,'cashier',t.cashier_id);
        let payout = 0;
        let outcome = 'LOST';
        if (won) {
          payout = Math.min(t.potential_win_cents || Math.floor(t.stake_cents * (t.odds||2)), MAX_PAYOUT);
          await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
          await ledger(client,cashier.id,'credit',payout,'payout',t.uid,'ticket won (auto)');
          outcome = 'WON';
        }
        await client.query(
          'UPDATE tickets SET status=$1, payout_cents=$2, settled_at=now() WHERE id=$3',
          [outcome, payout, t.id]
        );
      }
    });
  }
}

// APIs for POS
app.get('/virtual/products', (_req,res)=> {
  res.json([
    { code:'FOOTBALL', name:'Football' },
    { code:'COLOR',    name:'Color' },
    { code:'DOGS',     name:'Dogs' },
    { code:'HORSES',   name:'Horses' },
  ]);
});

app.get('/virtual/events', async (req,res)=>{
  const { product } = req.query;
  const rows = (await pool.query(
    `SELECT * FROM virtual_events
     WHERE ($1::text IS NULL OR product_code=$1) AND status IN ('OPEN','CLOSED')
     ORDER BY start_at ASC LIMIT 30`, [product||null]
  )).rows;
  res.json(rows);
});

app.get('/virtual/markets', async (req,res)=>{
  const { event_id } = req.query;
  const rows = (await pool.query(`SELECT * FROM virtual_markets WHERE event_id=$1 ORDER BY id ASC`, [event_id])).rows;
  res.json(rows);
});

// DEBUG: one-shot seed
app.post('/admin/debug/seed', needAdmin, async (_req,res)=>{
  await seedTick();
  res.json({ok:true});
});

// ---------- Cashier POS (4 products) ----------
app.get('/pos', (_req, res) => {
  res.set('Content-Type','text/html');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Mastermind Cashier</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
:root{--bg:#0b1220;--card:#0f172a;--muted:#9aa4b2;--text:#e5e7eb;--brand:#f59e0b;--ok:#16a34a;--bad:#dc2626;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Arial,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:16px}
h2{margin:8px 0 12px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.card{background:var(--card);border:1px solid #1f2937;border-radius:12px;padding:12px}
.badge{display:inline-block;background:#1f2937;border:1px solid #2a3645;border-radius:999px;padding:6px 10px;color:#cbd5e1}
.input{background:#0b1220;border:1px solid #233043;border-radius:10px;color:#e5e7eb;padding:10px}
.btn{background:var(--brand);border:none;border-radius:10px;color:#111;padding:10px 14px;font-weight:700;cursor:pointer}
.row{display:flex;gap:8px;align-items:center;margin:8px 0}
.kpi{display:flex;flex-direction:column;font-weight:700}
.kpi small{font-weight:500;color:var(--muted)}
.tabbar{display:flex;gap:8px;margin:10px 0}
.tab{padding:10px 14px;border-radius:10px;background:#0e1526;border:1px solid #1c2433;color:#e5e7eb;cursor:pointer}
.tab.active{background:#3b82f6;color:#fff;border-color:#2563eb}
.pills{display:flex;gap:6px;overflow:auto;padding-bottom:6px}
.pill{display:flex;gap:6px;align-items:center;background:#101827;border:1px solid #1f2937;color:#cbd5e1;border-radius:999px;padding:6px 10px;white-space:nowrap;cursor:pointer}
.pill img{width:18px;height:18px;border-radius:4px}
.table{width:100%;border-collapse:collapse}
.table th,.table td{padding:8px;border-bottom:1px solid #1f2937;text-align:center}
.table th{color:#cbd5e1;font-weight:600}
.od{background:#0f172a;border:1px solid #243246;border-radius:8px;padding:6px 8px;cursor:pointer}
.footer{position:sticky;bottom:0;background:rgba(10,17,32,0.9);backdrop-filter:blur(4px);border-top:1px solid #1f2937;padding:10px;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <h2>Cashier Dashboard</h2>
  <div class="row"><input id="key" class="input" placeholder="x-cashier-key" style="min-width:320px"/></div>

  <div class="grid">
    <div class="card"><div class="kpi"><small>Float Balance</small><div id="kpi-float">KES 0</div></div></div>
    <div class="card"><div class="kpi"><small>Today Stake</small><div id="kpi-stake">KES 0</div></div></div>
    <div class="card"><div class="kpi"><small>Today Payouts</small><div id="kpi-payout">KES 0</div></div></div>
    <div class="card"><div class="kpi"><small>Pending / Won / Lost</small><div id="kpi-pl">0 / 0 / 0</div></div></div>
  </div>

  <div class="card" style="margin-top:12px">
    <div class="badge">Limits</div>
    <div>Min 20 - Max 1000 - Max Payout 20000</div>
  </div>

  <div class="card" style="margin-top:12px">
    <div class="tabbar">
      <div class="tab active" data-p="FOOTBALL">Football</div>
      <div class="tab" data-p="COLOR">Color</div>
      <div class="tab" data-p="DOGS">Dogs</div>
      <div class="tab" data-p="HORSES">Horses</div>
    </div>

    <div id="football">
      <div id="evpills" class="pills"></div>
      <table class="table" id="ftbl">
        <thead><tr>
          <th>#</th><th style="text-align:left">HOME</th><th style="text-align:left">AWAY</th>
          <th>1</th><th>X</th><th>2</th><th>GG</th><th>NG</th><th>OV2.5</th><th>UN2.5</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>

    <div id="color" style="display:none">
      <div class="row" style="gap:16px">
        <button class="btn" style="background:#ef4444;color:#fff" onclick="placeColor('RED')">RED 1.95</button>
        <button class="btn" style="background:#0ea5e9;color:#fff" onclick="placeColor('BLACK')">BLACK 1.95</button>
        <button class="btn" style="background:#16a34a;color:#fff" onclick="placeColor('GREEN')">GREEN 12.00</button>
      </div>
      <div class="muted">New color round every ~30s</div>
    </div>

    <div id="races" style="display:none">
      <div id="racepills" class="pills"></div>
      <table class="table" id="rtbl">
        <thead><tr><th>#</th><th style="text-align:left">Runner</th><th>WIN</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <div class="card" style="margin-top:12px">
    <h3 style="margin:0 0 8px">Recent Tickets</h3>
    <button class="btn" onclick="loadTickets()">Refresh</button>
    <table class="table" id="t">
      <thead><tr><th>UID</th><th>Stake</th><th>Odds</th><th>Product</th><th>Pick</th><th>Status</th><th>Print</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="footer">
    <div class="row">
      <input id="manualStake" class="input" placeholder="Stake KES (min 20, max 1000)" style="width:220px">
      <input id="manualOdds" class="input" placeholder="Odds (e.g. 2.10)" style="width:160px">
      <button class="btn" onclick="placeManual()">Place Manual</button>
    </div>
  </div>
</div>

<script>
const fmt = k => 'KES ' + (Math.round(k/100)).toString();

let cashierKey = '';
function getKey(){ if(!cashierKey){ cashierKey = document.getElementById('key').value.trim(); } return cashierKey; }

document.querySelectorAll('.tab').forEach(el=>{
  el.onclick = ()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    el.classList.add('active');
    const p = el.dataset.p;
    document.getElementById('football').style.display = (p==='FOOTBALL')?'block':'none';
    document.getElementById('color').style.display    = (p==='COLOR')?'block':'none';
    document.getElementById('races').style.display    = (p==='DOGS'||p==='HORSES')?'block':'none';
    if (p==='FOOTBALL') loadFootball();
    if (p==='COLOR')    {/* nothing to load; single current event */}
    if (p==='DOGS' || p==='HORSES') loadRaces(p);
  };
});

async function placeManual(){
  const stakeKES = parseInt(document.getElementById('manualStake').value||'0',10);
  const odds = parseFloat(document.getElementById('manualOdds').value||'0');
  const stake = stakeKES*100;
  const res = await fetch('/bets/place',{method:'POST',
    headers:{'Content-Type':'application/json','x-cashier-key':getKey()},
    body: JSON.stringify({stake_cents:stake, odds, product_code:'FOOTBALL', market_code:'1X2', selection_code:'1'})
  });
  alert(await res.text()); loadTickets();
}

// FOOTBALL
let currentEvent = null;
async function loadFootball(){
  const evs = await (await fetch('/virtual/events?product=FOOTBALL')).json();
  const pills = document.getElementById('evpills'); pills.innerHTML='';
  evs.forEach((e,i)=>{
    const b = document.createElement('div');
    b.className='pill';
    b.innerHTML = (e.home_team_code||'H') + ' vs ' + (e.away_team_code||'A') + ' • ' + new Date(e.start_at).toLocaleTimeString();
    b.onclick=()=> showFootball(e);
    pills.appendChild(b);
    if(i===0) currentEvent=e;
  });
  if (evs[0]) showFootball(evs[0]);
}
async function showFootball(e){
  currentEvent = e;
  const m = await (await fetch('/virtual/markets?event_id='+e.id)).json();
  const odds = (code,sel)=> {
    const row = m.find(r=> r.market_code===code && r.selection_code===sel);
    return row? Number(row.odds).toFixed(2) : '-';
  };
  const tb = document.querySelector('#ftbl tbody'); tb.innerHTML='';
  const tr = document.createElement('tr');
  tr.innerHTML = \`
  <td>1</td>
  <td style="text-align:left">\${e.home_team_code}</td>
  <td style="text-align:left">\${e.away_team_code}</td>
  <td class="od" onclick="pickBet(\${e.id},'FOOTBALL','1X2','1',\${odds('1X2','1')})">\${odds('1X2','1')}</td>
  <td class="od" onclick="pickBet(\${e.id},'FOOTBALL','1X2','X',\${odds('1X2','X')})">\${odds('1X2','X')}</td>
  <td class="od" onclick="pickBet(\${e.id},'FOOTBALL','1X2','2',\${odds('1X2','2')})">\${odds('1X2','2')}</td>
  <td class="od" onclick="pickBet(\${e.id},'FOOTBALL','GGNG','GG',\${odds('GGNG','GG')})">\${odds('GGNG','GG')}</td>
  <td class="od" onclick="pickBet(\${e.id},'FOOTBALL','GGNG','NG',\${odds('GGNG','NG')})">\${odds('GGNG','NG')}</td>
  <td class="od" onclick="pickBet(\${e.id},'FOOTBALL','OU25','OV',\${odds('OU25','OV')})">\${odds('OU25','OV')}</td>
  <td class="od" onclick="pickBet(\${e.id},'FOOTBALL','OU25','UN',\${odds('OU25','UN')})">\${odds('OU25','UN')}</td>\`;
  tb.appendChild(tr);
}

// COLOR
async function placeColor(sel){
  // use the soonest OPEN color event
  const evs = await (await fetch('/virtual/events?product=COLOR')).json();
  const e = evs[0]; if(!e){ alert('no round'); return; }
  const odds = sel==='GREEN'?12.00:1.95;
  const stakeKES = parseInt(prompt('Stake KES? (min 20, max 1000)')||'0',10);
  if(!stakeKES) return;
  const res = await fetch('/bets/place',{method:'POST',
    headers:{'Content-Type':'application/json','x-cashier-key':getKey()},
    body: JSON.stringify({stake_cents:stakeKES*100, odds, product_code:'COLOR', event_id:e.id, market_code:'COLOR', selection_code:sel})
  });
  alert(await res.text()); loadTickets();
}

// RACES
async function loadRaces(product){
  const evs = await (await fetch('/virtual/events?product='+product)).json();
  const pills = document.getElementById('racepills'); pills.innerHTML='';
  evs.forEach((e,i)=>{
    const b = document.createElement('div'); b.className='pill'; b.textContent = product + ' • ' + new Date(e.start_at).toLocaleTimeString();
    b.onclick=()=> showRace(e,product); pills.appendChild(b); if(i===0) showRace(e,product);
  });
}
async function showRace(e,product){
  const data = await (await fetch('/virtual/markets?event_id='+e.id)).json();
  const tb = document.querySelector('#rtbl tbody'); tb.innerHTML='';
  data.filter(x=>x.market_code==='RACE_WIN').forEach((r,i)=>{
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${i+1}</td>
      <td style="text-align:left">\${r.selection_code}</td>
      <td class="od" onclick="pickBet(\${e.id},'\${product}','RACE_WIN','\${r.selection_code}',\${Number(r.odds).toFixed(2)})">\${Number(r.odds).toFixed(2)}</td>\`;
    tb.appendChild(tr);
  });
}

async function pickBet(event_id, product_code, market_code, selection_code, odds){
  const stakeKES = parseInt(prompt('Stake KES? (min 20, max 1000)')||'0',10);
  if(!stakeKES) return;
  const res = await fetch('/bets/place',{method:'POST',
    headers:{'Content-Type':'application/json','x-cashier-key':getKey()},
    body: JSON.stringify({stake_cents: stakeKES*100, odds, product_code, event_id, market_code, selection_code})
  });
  alert(await res.text()); loadTickets();
}

// list tickets
async function loadTickets(){
  const rows = await (await fetch('/cashier/tickets',{headers:{'x-cashier-key':getKey()}})).json();
  const tb = document.querySelector('#t tbody'); tb.innerHTML='';
  (rows||[]).forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${r.uid}</td>
      <td>KES \${(r.stake_cents/100).toFixed(0)}</td>
      <td>\${(r.odds||0).toFixed? r.odds.toFixed(2): r.odds||'-'}</td>
      <td>\${r.product_code||'-'}</td>
      <td>\${r.market_code||'-'}/\${r.selection_code||'-'}</td>
      <td>\${r.status}</td>
      <td><a href="/tickets/\${r.uid}/print" target="_blank">Print</a></td>\`;
    tb.appendChild(tr);
  });
}
loadFootball(); // default
setInterval(()=>{ loadFootball(); }, 15000);
</script>
</body></html>`);
});

// optional root redirect
app.get('/', (_req,res)=> res.redirect('/pos'));

// ---------- background loops ----------
setInterval(seedTick, 5000);     // keep events coming
setInterval(settleTick, 3000);   // close/result/settle

// ---------- start ----------
migrate()
 .then(()=> app.listen(3000, ()=> console.log('App on :3000')))
 .catch(err=> { console.error(err); process.exit(1); });
