// index.js — float engine + tickets + ledger + settle + limits
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MIN_STAKE = parseInt(process.env.MIN_STAKE_CENTS || '2000', 10);   // 20 KES (cents)
const MAX_STAKE = 100000;   // 1000 KES (cents)
const MAX_PAYOUT = 2000000; // 20,000 KES (cents)

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

// LEDGER (you can add agent/cashier-specific filters later)
app.get('/admin/ledger', needAdmin, async (_req,res)=>{
  const { rows } = await pool.query('SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

// CASHIER: place bet with min/max stake + set potential_win (capped)
app.post('/bets/place', needCashier, async (req,res)=>{
  const stake = parseInt(req.body.stake_cents,10);
  if (!stake || stake < MIN_STAKE) {
    return res.status(400).json({error:`min stake ${MIN_STAKE} cents (KES ${MIN_STAKE/100})`});
  }
  if (stake > MAX_STAKE) {
    return res.status(400).json({error:`max stake ${MAX_STAKE/100} KES`});
  }

  await withTxn(async (client)=>{
    const cashier = await getWallet(client,'cashier','cashier1');
    const w = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE',[cashier.id]);
    if (w.rows[0].balance_cents < stake) throw new Error('insufficient funds');

    // reserve stake
    await client.query('UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id=$2',[stake, cashier.id]);
    const ticketUid = makeTicketUid();
    await ledger(client, cashier.id, 'debit', stake, 'stake', ticketUid, 'stake reserved');

    // potential win: simple 2x for now, capped by MAX_PAYOUT
    const potential = Math.min(stake * 2, MAX_PAYOUT);

    await client.query(
      'INSERT INTO tickets(uid,cashier_id,stake_cents,status,potential_win_cents) VALUES ($1,$2,$3,$4,$5)',
      [ticketUid, 'cashier1', stake, 'PENDING', potential]
    );

    res.json({ok:true, ticket_uid: ticketUid, stake_cents: stake, potential_win_cents: potential});
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
      payout = Math.min(t.potential_win_cents || (t.stake_cents * 2), MAX_PAYOUT);
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'payout',uid,'ticket won');
    } else if (outcome === 'CANCELLED') {
      payout = t.stake_cents; // refund stake
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$1 WHERE id=$2',[payout,cashier.id]);
      await ledger(client,cashier.id,'credit',payout,'refund',uid,'ticket cancelled');
    }
    // LOST → payout stays 0 (stake already reserved/debited)

    await client.query(
      'UPDATE tickets SET status=$1, payout_cents=$2, settled_at=now() WHERE id=$3',
      [outcome, payout, t.id]
    );
  }).then(()=> res.json({ok:true, uid, outcome}))
    .catch(e=> res.status(400).json({error:e.message}));
});

// TICKETS: get one (frontend can render barcode + watermark color by status)
app.get('/tickets/:uid', async (req, res) => {
  const { uid } = req.params;
  const { rows } = await pool.query('SELECT * FROM tickets WHERE uid=$1', [uid]);
  if (!rows[0]) return res.status(404).json({ error: 'ticket not found' });
  res.json(rows[0]);
});

// CASHIER: list last 20 tickets
app.get('/cashier/tickets', needCashier, async (_req, res) => {
  const cashierId = 'cashier1';
  const { rows } = await pool.query(
    'SELECT uid, stake_cents, potential_win_cents, status, payout_cents, created_at FROM tickets WHERE cashier_id=$1 ORDER BY created_at DESC LIMIT 20',
    [cashierId]
  );
  res.json(rows);
});

// start
migrate()
  .then(()=> app.listen(3000, ()=> console.log('App on :3000')))
  .catch(err=> { console.error(err); process.exit(1); });
