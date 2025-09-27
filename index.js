cat > index.js <<'JS'
const express = require('express');
const path = require('path');
const {Pool} = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get('/health', (_,res)=>res.json({ok:true}));

// ------------- Helpers
const KES = v => Math.round(v); // working in cents already
const toCents = kes => Math.round(kes*100);

// ------------- Seed a few teams + sample fixtures + markets if empty
app.post('/admin/seed-sample', async (req,res)=>{
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    // 4 teams EPL
    const {rows: epl} = await client.query(`SELECT id FROM leagues WHERE code='EPL'`);
    const leagueId = epl[0].id;

    const countTeams = await client.query('SELECT count(*) FROM teams WHERE league_id=$1',[leagueId]);
    if (Number(countTeams.rows[0].count) < 4){
      await client.query(
        `INSERT INTO teams(league_id,code3,name,rating) VALUES
         ($1,'ARS','Arsenal',85),($1,'CHE','Chelsea',80),
         ($1,'MCI','Man City',90),($1,'MUN','Man United',82)`,[leagueId]
      );
    }

    // 2 fixtures (OPEN)
    const now = new Date();
    const kickoff1 = new Date(now.getTime()+5*60*1000); // +5 min
    const kickoff2 = new Date(now.getTime()+10*60*1000); // +10 min
    const teams = await client.query('SELECT id,code3,rating FROM teams WHERE league_id=$1 LIMIT 4',[leagueId]);

    const [t1,t2,t3,t4] = teams.rows;
    const insFx = `
      INSERT INTO fixtures(id,league_id,kickoff_at,home_team,away_team,status)
      VALUES (gen_random_uuid(),$1,$2,$3,$4,'OPEN'),
             (gen_random_uuid(),$1,$5,$6,$7,'OPEN')
      RETURNING id
    `;
    const fx = await client.query(insFx,[leagueId,kickoff1,t1.id,t2.id,kickoff2,t3.id,t4.id]);
    const [f1,f2] = fx.rows.map(r=>r.id);

    // Create simple markets (1X2 & OU_2_5) with fixed demo odds
    async function makeMarkets(fid){
      const m1 = await client.query(
        `INSERT INTO markets(id,fixture_id,code) VALUES (gen_random_uuid(),$1,'1X2') RETURNING id`,[fid]);
      const mid1 = m1.rows[0].id;
      await client.query(
        `INSERT INTO selections(id,market_id,code,price) VALUES
         (gen_random_uuid(),$1,'1',1.90),(gen_random_uuid(),$1,'X',3.40),(gen_random_uuid(),$1,'2',3.60)`,[mid1]
      );
      const m2 = await client.query(
        `INSERT INTO markets(id,fixture_id,code) VALUES (gen_random_uuid(),$1,'OU_2_5') RETURNING id`,[fid]);
      const mid2 = m2.rows[0].id;
      await client.query(
        `INSERT INTO selections(id,market_id,code,price) VALUES
         (gen_random_uuid(),$1,'OV',1.95),(gen_random_uuid(),$1,'UN',1.85)`,[mid2]
      );
    }
    await makeMarkets(f1); await makeMarkets(f2);

    await client.query('COMMIT');
    res.json({ok:true, fixtures:[f1,f2]});
  }catch(e){
    await pool.query('ROLLBACK');
    res.status(500).json({ok:false,error:e.message});
  }finally{
    client.release();
  }
});

// ------------- API for cashier UI
app.get('/api/fixtures', async (req,res)=>{
  const { league='EPL' } = req.query;
  const rows = await pool.query(`
    SELECT f.id, f.kickoff_at,
           th.code3 AS home_code, ta.code3 AS away_code
    FROM fixtures f
    JOIN leagues l ON l.id=f.league_id AND l.code=$1
    JOIN teams th ON th.id=f.home_team
    JOIN teams ta ON ta.id=f.away_team
    WHERE f.status='OPEN'
    ORDER BY f.kickoff_at ASC`,[league]);
  res.json(rows.rows);
});

app.get('/api/fixtures/:id/markets', async (req,res)=>{
  const {id} = req.params;
  const rows = await pool.query(`
    SELECT m.id as market_id, m.code as market,
           json_agg(json_build_object('selection_id',s.id,'code',s.code,'price',s.price) ORDER BY s.code) as selections
    FROM markets m
    JOIN selections s ON s.market_id=m.id
    WHERE m.fixture_id=$1 AND m.status='OPEN'
    GROUP BY m.id, m.code
    ORDER BY m.code`,[id]);
  res.json(rows.rows);
});

// Create ticket (enforce stake/payout rules)
app.post('/api/tickets', async (req,res)=>{
  try{
    const { shop_id=null, cashier_id=null, stake_kes, lines } = req.body;
    const stake_cents = Math.round(Number(stake_kes)*100);

    const min = Number(process.env.STAKE_MIN_KES)*100;   // 2000
    const max = Number(process.env.STAKE_MAX_KES)*100;   // 100000
    const payoutMax = Number(process.env.PAYOUT_MAX_KES)*100; // 2,000,000

    if (!Number.isFinite(stake_cents) || stake_cents < min || stake_cents > max){
      return res.status(400).json({ok:false, error:`Stake must be between ${min/100}-${max/100} KES`});
    }
    if (!Array.isArray(lines) || lines.length === 0){
      return res.status(400).json({ok:false, error:'No selections'});
    }

    // Fetch prices for all selections
    const ids = lines.map(l=>l.selection_id);
    const q = `
      SELECT s.id, s.price, m.id as market_id
      FROM selections s JOIN markets m ON m.id=s.market_id
      WHERE s.id = ANY($1::uuid[]) AND m.status='OPEN'`;
    const {rows} = await pool.query(q,[ids]);

    if (rows.length !== ids.length) return res.status(400).json({ok:false,error:'Invalid selections'});

    // Compute accumulator price
    let acc = 1.0;
    for (const r of rows){ acc *= Number(r.price); }

    let potential_cents = Math.floor(stake_cents * acc);
    if (potential_cents > payoutMax) potential_cents = payoutMax; // hard cap

    // Insert ticket
    const code = 'MM-' + Date.now().toString(36).toUpperCase();
    const ticket = await pool.query(`
      INSERT INTO tickets(code,shop_id,cashier_id,stake_cents,potential_win_cents,status)
      VALUES ($1,$2,$3,$4,$5,'PENDING')
      RETURNING id, code, potential_win_cents`,[code, shop_id, cashier_id, stake_cents, potential_cents]);

    const ticketId = ticket.rows[0].id;

    // Insert lines
    for (const r of rows){
      await pool.query(`INSERT INTO ticket_lines(ticket_id,market_id,selection_id,price)
                        VALUES ($1,$2,$3,$4)`,[ticketId, r.market_id, r.id, r.price]);
    }

    // (Wallet debit will come after we wire float; for now we just return)
    res.json({ok:true, code, potential_kes: (potential_cents/100).toFixed(2)});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get('/api/tickets/:code', async (req,res)=>{
  const {code}=req.params;
  const t = await pool.query(`SELECT id,code,stake_cents,potential_win_cents,status,created_at FROM tickets WHERE code=$1`,[code]);
  if (!t.rowCount) return res.status(404).json({ok:false,error:'Not found'});
  const ticket = t.rows[0];
  const lines = await pool.query(`
     SELECT tl.price, m.code as market, s.code as pick
     FROM ticket_lines tl
     JOIN selections s ON s.id=tl.selection_id
     JOIN markets m    ON m.id=tl.market_id
     WHERE tl.ticket_id=$1`,[ticket.id]);
  ticket.lines = lines.rows;
  res.json(ticket);
});

// Serve cashier dashboard at /
app.get('/', (_,res)=>res.sendFile(path.join(__dirname,'public','pos.html')));

app.listen(process.env.PORT || 3000, ()=> {
  console.log('Server on :', process.env.PORT || 3000);
});
JS
