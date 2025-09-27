require('dotenv').config();
const db = require('../db');

const comps = [
  { code: 'EPL', name: 'English Premier League' },
  { code: 'LALIGA', name: 'LaLiga' },
  { code: 'UCL', name: 'UEFA Champions League' }
];
const EPL = ['Arsenal','Man City','Liverpool','Chelsea','Man United','Tottenham'];
const LALIGA = ['Real Madrid','Barcelona','Atletico Madrid','Sevilla','Real Sociedad','Valencia'];
const UCL = ['Bayern','PSG','Inter','Juventus','Dortmund','Leipzig'];

function odds1x2(h=2,a=2){
  const home = +(1.7 - (h-a)*0.2).toFixed(2);
  const draw = +((1.6+2.6)/2).toFixed(2);
  const away = +(1.7 + (h-a)*0.2).toFixed(2);
  return [Math.max(home,1.35), Math.max(draw,2.8), Math.max(away,1.35)];
}

async function upsertTeams(names, code){
  const { rows:[c] } = await db.query(`SELECT id FROM competitions WHERE code=$1`, [code]);
  for (const n of names){
    await db.query(
      `INSERT INTO teams (name,country,competition_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [n,'',c.id]
    );
  }
  const { rows } = await db.query(`SELECT id,name FROM teams WHERE competition_id=$1 ORDER BY id`, [c.id]);
  return { compId: c.id, teams: rows };
}

(async ()=>{
  await db.query('BEGIN');
  try{
    for (const c of comps){
      await db.query(
        `INSERT INTO competitions (code,name) VALUES ($1,$2)
         ON CONFLICT (code) DO NOTHING`, [c.code,c.name]
      );
    }
    const epl = await upsertTeams(EPL,'EPL');
    const la  = await upsertTeams(LALIGA,'LALIGA');
    const ucl = await upsertTeams(UCL,'UCL');

    async function round({compId, teams}, offsetDays){
      for (let i=0;i<teams.length;i+=2){
        const start = new Date(Date.now()+ (24*(offsetDays+1)+i)*3600*1000);
        const { rows:[f] } = await db.query(
          `INSERT INTO fixtures (competition_id,matchday,start_time,home_team_id,away_team_id)
           VALUES ($1,1,$2,$3,$4) RETURNING id`,
          [compId, start, teams[i].id, teams[i+1].id]
        );
        const { rows:[m] } = await db.query(
          `INSERT INTO markets (kind,label,fixture_id) VALUES ('FOOTBALL_MAIN','1X2',$1) RETURNING id`,
          [f.id]
        );
        const [H,D,A] = odds1x2(2,2);
        await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'Home',$2)`, [m.id,H]);
        await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'Draw',$2)`, [m.id,D]);
        await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'Away',$2)`, [m.id,A]);
      }
    }
    await round(epl,0);
    await round(la,1);
    await round(ucl,2);

    await db.query('COMMIT'); console.log('Football seeded');
  }catch(e){ await db.query('ROLLBACK'); console.error(e); process.exit(1); }
  finally{ db.pool.end(); }
})();
