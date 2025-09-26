// index.js — simple float engine + tickets + ledger endpoints
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MIN_STAKE = parseInt(process.env.MIN_STAKE_CENTS || '2000', 10);

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

async function transfer(client, fromW, toW, amount, refType, refId, memo, requestedBy, approvedBy) {
  if (amount <= 0) throw new Error('amount must be > 0');
  const from = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE', [fromW.id]);
  const to   = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE', [toW.id]);
  if (from.rows.length === 0 || to.rows.length === 0) throw new Error('wallet missing');
  if (from.rows[0].balance_cents < amount) throw new Error('insufficient funds');

  await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2', [amount, fromW.id]);
  await ledger(client, fromW.id, 'debit', amount, refType, refId, memo);

  await client.query('UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id=$2', [amount, toW.id]);
  await ledger(client, toW.id, 'credit', amount, refType, refId, memo);

  await client.query(
    'INSERT INTO transfers(from_wallet,to_wallet,amount_cents,requested_by,approved_by,memo) VALUES ($1,$2,$3,$4,$5,$6)',
    [fromW.id, toW.id, amount, requestedBy||null, approvedBy||null, memo||null]
  );
}

// --- auth ---
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

app.get('/balances', needAdmin, async (_req,res) => {
  const { rows } = await pool.query('SELECT owner_type, owner_id, balance_cents FROM wallets ORDER BY owner_type, owner_id');
  res.json(rows);
});

// LEDGER views
app.get('/admin/ledger', needAdmin, async (_req,res)=>{
  const { rows } = await pool.query(
    'SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT 50'
  );
  res.json(rows);
});
app.get('/agent/ledger', needAgent, async (_req,res)=>{
  const { rows } = await pool.query(
    `SELECT wl.* 
     FROM wallet_ledger wl
     JOIN wallets w ON wl.wallet_id=w.id
     WHERE w.owner_type IN ('agent','cashier')
     ORDER BY wl.created_at DESC LIMIT 50`
  );
  res.json(rows);
});
app.get('/cashier/ledger', needCashier, async (_req,res)=>{
  const { rows } = await pool.query(
    `SELECT wl.* 
     FROM wallet_ledger wl
     JOIN wallets w ON wl.wallet_id=w.id
     WHERE w.owner_type='cashier'
     ORDER BY wl.created_at DESC LIMIT 50`
  );
  res.json(rows);
});

// ADMIN: mint to house
app.post('/admin/mint', needAdmin, async (req,res)=>{
  const amount = parseInt(req.body.amount_cents,10);
  if (!amount || amount<=0) return res.status(400).json({error:'amount_cents > 0'});
  await withTxn(async (client)=>{
    const house = await getWallet(client,'house',null);
    await client.query('UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id=$2',[amount, house.id]);
    await ledger(client, house.id,'credit', amount, 'admin_mint', null, req.body.memo||'');
  });
  res.json({ok:true});
});

// ADMIN: house -> agent
app.post('/admin/house-to-agent', needAdmin, async (req,res)=>{
  const amount = parseInt(req.body.amount_cents,10);
  const agentId = req.body.agent_id || 'agent1';
  if (!amount || amount<=0) return res.status(400).json({error:'amount_cents > 0'});
  await withTxn(async (client)=>{
    const house = await getWallet(client,'house',null);
    const agent = await getWallet(client,'agent',agentId);
    await transfer(client, house, agent, amount, 'transfer', 'house_to_agent', req.body.memo||'', 'admin','admin');
  });
  res.json({ok:true});
});

// AGENT: agent -> cashier
app.post('/agent/to-cashier', needAgent, async (req,res)=>{
  const amount = parseInt(req.body.amount_cents,10);
  const agentId = 'agent1';
  const cashierId = req.body.cashier_id || 'cashier1';
  if (!amount || amount<=0) return res.status(400).json({error:'amount_cents > 0'});
  await withTxn(async (client)=>{
    const agent = await getWallet(client,'agent',agentId);
    const cashier = await getWallet(client,'cashier',cashierId);
    await transfer(client, agent, cashier, amount, 'transfer', 'agent_to_cashier', req.body.memo||'', 'agent','agent');
  });
  res.json({ok:true});
});

// CASHIER: place bet
app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  if (!stake || stake < MIN_STAKE) return res.status(400).json({error:`min stake ${MIN_STAKE} cents (KES ${MIN_STAKE/100})`});
  await withTxn(async (client)=>{
    const cashier = await getWallet(client,'cashier','cashier1');
    const w = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[cashier.id]);
    if (w.rows[0].balance_cents < stake) throw new Error('insufficient funds');
    await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2',[stake, cashier.id]);
    const ticketUid = makeTicketUid();
    await ledger(client, cashier.id, 'debit', stake, 'stake', ticketUid, 'stake reserved');
    await client.query(
      'INSERT INTO tickets(uid,cashier_id,stake_cents,status) VALUES ($1,$2,$3,$4)',
      [ticketUid, 'cashier1', stake, 'PENDING']
    );
    res.json({ok:true, ticket_uid: ticketUid, stake_cents: stake});
  }).catch(e=> res.status(400).json({error:e.message}));
});

// start
migrate()
  .then(()=> app.listen(3000, ()=> console.log('App on :3000')))
  .catch(err=> { console.error(err); process.exit(1); });
