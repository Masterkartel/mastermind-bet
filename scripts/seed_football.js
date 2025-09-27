// scripts/seed_football.js
require('dotenv').config();
const db = require('../db');

// comps + short team lists (expand later)
const comps = [
  { code: 'EPL', name: 'English Premier League', teams: ['Arsenal','Man City','Liverpool','Chelsea','Man United','Tottenham'] },
  { code: 'LALIGA', name: 'LaLiga', teams: ['Real Madrid','Barcelona','Atletico Madrid','Sevilla','Real Sociedad','Valencia'] },
  { code: 'UCL', name: 'UEFA Champions League', teams: ['Bayern','PSG','Inter','Juventus','Dortmund','Leipzig'] },
];

// simple synthetic odds
function odds1x2(){ return [1.85, 3.40, 3.80]; }          // Home, Draw, Away
function oddsGGNG(){ return [1.75, 2.05]; }                // GG, NG
function oddsOU25(){ return [1.90, 1.90]; }                // Over2.5, Under2.5

async function upsertCompetition(code, name){
  await db.query(
    `INSERT INTO competitions (code,name) VALUES ($1,$2)
     ON CONFLICT (code) DO NOTHING`, [code, name]
  );
  const r = await db.query(`SELECT id FROM competitions WHERE code=$1`, [code]);
  return r.rows[0].id;
}

async function upsertTeam(name, compId){
  await db.query(
    `INSERT INTO teams (name,country,competition_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [name, '', compId]
  );
}

async function makeFixture(compId, homeId, awayId, start){
  const r = await db.query(
    `INSERT INTO fixtures (competition_id, matchday, start_time, home_team_id, away_team_id)
     VALUES ($1, 1, $2, $3, $4) RETURNING id`,
    [compId, start, homeId, awayId]
  );
  return r.rows[0].id;
}

async function addMarket_1x2(fixtureId){
  const m = await db.query(
    `INSERT INTO markets (kind,label,fixture_id) VALUES ('FOOTBALL_MAIN','1X2',$1) RETURNING id`,
    [fixtureId]
  );
  const [H,D,A] = odds1x2();
  await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'Home',$2)`, [m.rows[0].id,H]);
  await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'Draw',$2)`, [m.rows[0].id,D]);
  await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'Away',$2)`, [m.rows[0].id,A]);
}

async function addMarket_GGNG(fixtureId){
  const m = await db.query(
    `INSERT INTO markets (kind,label,fixture_id) VALUES ('FOOTBALL_MAIN','GG/NG',$1) RETURNING id`,
    [fixtureId]
  );
  const [GG,NG] = oddsGGNG();
  await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'GG',$2)`, [m.rows[0].id,GG]);
  await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'NG',$2)`, [m.rows[0].id,NG]);
}

async function addMarket_OU25(fixtureId){
  const m = await db.query(
    `INSERT INTO markets (kind,label,fixture_id) VALUES ('FOOTBALL_MAIN','1X2 OV/UN 2.5',$1) RETURNING id`,
    [fixtureId]
  );
  const [OV,UN] = oddsOU25();
  await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'OV2.5',$2)`, [m.rows[0].id,OV]);
  await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'UN2.5',$2)`, [m.rows[0].id,UN]);
}

(async ()=>{
  await db.query('BEGIN');
  try {
    const now = Date.now();

    for (let c = 0; c < comps.length; c++){
      const comp = comps[c];
      const compId = await upsertCompetition(comp.code, comp.name);

      // teams
      for (let t=0; t<comp.teams.length; t++){
        await upsertTeam(comp.teams[t], compId);
      }
      const tr = await db.query(`SELECT id,name FROM teams WHERE competition_id=$1 ORDER BY id`, [compId]);
      const teams = tr.rows;

      // fixtures: pair 0-1, 2-3, 4-5
      for (let i=0; i<teams.length; i+=2){
        const start = new Date(now + (24*(c+1)+i)*3600*1000);
        const fixtureId = await makeFixture(compId, teams[i].id, teams[i+1].id, start);

        // markets
        await addMarket_1x2(fixtureId);
        await addMarket_GGNG(fixtureId);
        await addMarket_OU25(fixtureId);
      }
    }

    await db.query('COMMIT');
    console.log('Football seeded with 1X2, GG/NG, OU2.5 for EPL, LaLiga, UCL');
  } catch (e) {
    await db.query('ROLLBACK');
    console.error(e);
    process.exit(1);
  } finally {
    db.pool.end();
  }
})();
