require('dotenv').config();
const db = require('../db');
const OD = require('./lib/odds');

const COMPS = [
  { code:'EPL',    name:'English Premier League', teams:['Arsenal','Man City','Liverpool','Chelsea','Man United','Tottenham'] },
  { code:'UCL',    name:'UEFA Champions League',  teams:['Bayern','PSG','Inter','Juventus','Dortmund','Leipzig'] },
  { code:'LALIGA', name:'LaLiga',                  teams:['Real Madrid','Barcelona','Atletico Madrid','Sevilla','Real Sociedad','Valencia'] },
];

async function upsertCompetition(code,name){
  await db.query(`INSERT INTO competitions(code,name) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name`,[code,name]);
  const r = await db.query(`SELECT id FROM competitions WHERE code=$1`,[code]);
  return r.rows[0].id;
}
async function upsertTeam(name, compId){
  await db.query(`INSERT INTO teams(name,country,competition_id) VALUES($1,'',$2) ON CONFLICT DO NOTHING`,[name, compId]);
  const r = await db.query(`SELECT id FROM teams WHERE name=$1 AND competition_id=$2`,[name,compId]);
  return r.rows[0].id;
}
async function makeFixture(compId, homeId, awayId, start){
  const r = await db.query(
    `INSERT INTO fixtures(competition_id,matchday,start_time,home_team_id,away_team_id,status)
     VALUES($1,1,$2,$3,$4,'scheduled') RETURNING id`, [compId,start,homeId,awayId]
  );
  return r.rows[0].id;
}
async function market(fixtureId, label){ // returns market id
  const r = await db.query(`INSERT INTO markets(kind,label,fixture_id) VALUES('FOOTBALL_MAIN',$2,$1) RETURNING id`,[fixtureId,label]);
  return r.rows[0].id;
}
async function sel(marketId, name, price){
  await db.query(`INSERT INTO selections(market_id,name,price) VALUES($1,$2,$3)`,[marketId,name,price]);
}

async function seed(){
  await db.query('BEGIN');
  try{
    const now = Date.now();

    for (let c=0;c<COMPS.length;c++){
      const comp = COMPS[c];
      const compId = await upsertCompetition(comp.code, comp.name);

      // teams + “strength” rating 0..1
      const ids=[], rating=[];
      for (let t=0;t<comp.teams.length;t++){
        ids[t] = await upsertTeam(comp.teams[t], compId);
        rating[t] = (comp.teams.length - t) / comp.teams.length; // simple descending
      }

      // fixtures: pair 0-1, 2-3, 4-5
      for (let i=0;i<ids.length;i+=2){
        const start = new Date(now + (6*c+i+1)*3600*1000);
        const fid = await makeFixture(compId, ids[i], ids[i+1], start);

        const delta = rating[i]-rating[i+1];
        const x12 = OD.threeWayOdds(delta);
        const dc  = OD.doubleChance(x12);
        const gg  = OD.yesNoOdds(1.86);         // GG/NG
        const ou15= OD.ouOdds(1.5);
        const ou25= OD.ouOdds(2.5);

        // MAIN
        let mid = await market(fid,'1X2'); await sel(mid,'Home',x12.H); await sel(mid,'Draw',x12.D); await sel(mid,'Away',x12.A);
        mid = await market(fid,'DOUBLE CHANCE'); await sel(mid,'1X',dc['1X']); await sel(mid,'12',dc['12']); await sel(mid,'X2',dc['X2']);
        mid = await market(fid,'GG/NG'); await sel(mid,'GG',gg.Y); await sel(mid,'NG',gg.N);
        mid = await market(fid,'OV/UN 2.5'); await sel(mid,'OV2.5',ou25.OV); await sel(mid,'UN2.5',ou25.UN);

        // OVER/UNDER (global 1.5)
        mid = await market(fid,'OV/UN 1.5'); await sel(mid,'OV1.5',ou15.OV); await sel(mid,'UN1.5',ou15.UN);

        // HOME OV/UN
        mid = await market(fid,'HOME OV/UN 0.5'); await sel(mid,'H OV0.5', 1.55); await sel(mid,'H UN0.5', 2.30);
        mid = await market(fid,'HOME OV/UN 1.5'); await sel(mid,'H OV1.5', 2.15); await sel(mid,'H UN1.5', 1.70);
        mid = await market(fid,'HOME OV/UN 2.5'); await sel(mid,'H OV2.5', 3.30); await sel(mid,'H UN2.5', 1.35);

        // AWAY OV/UN
        mid = await market(fid,'AWAY OV/UN 0.5'); await sel(mid,'A OV0.5', 1.60); await sel(mid,'A UN0.5', 2.20);
        mid = await market(fid,'AWAY OV/UN 1.5'); await sel(mid,'A OV1.5', 2.20); await sel(mid,'A UN1.5', 1.66);
        mid = await market(fid,'AWAY OV/UN 2.5'); await sel(mid,'A OV2.5', 3.40); await sel(mid,'A UN2.5', 1.34);

        // 1X2 OV/UN 1.5
        mid = await market(fid,'1X2 OV/UN 1.5');
        await sel(mid,'1+OV1.5', 2.35); await sel(mid,'X+OV1.5', 4.20); await sel(mid,'2+OV1.5', 3.40);
        await sel(mid,'1+UN1.5', 3.60); await sel(mid,'X+UN1.5', 4.10); await sel(mid,'2+UN1.5', 5.00);

        // 1X2 OV/UN 2.5
        mid = await market(fid,'1X2 OV/UN 2.5');
        await sel(mid,'1+OV2.5', 2.95); await sel(mid,'X+OV2.5', 4.60); await sel(mid,'2+OV2.5', 4.10);
        await sel(mid,'1+UN2.5', 2.65); await sel(mid,'X+UN2.5', 3.60); await sel(mid,'2+UN2.5', 3.80);
      }
    }

    await db.query('COMMIT');
    console.log('Seeded EPL/UCL/LaLiga with full markets.');
  }catch(e){
    await db.query('ROLLBACK'); console.error(e); process.exit(1);
  }finally{
    db.pool.end();
  }
}

seed();
