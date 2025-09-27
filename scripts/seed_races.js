require('dotenv').config();
const db = require('../db');

const TRACKS = { DOG: ['Greyline Park','Riverbend','Sunset Lane'], HORSE: ['Royal Downs','Silver Meadow','High Ridge'] };
const rnd = (a=1.5,b=6)=>+(a+Math.random()*(b-a)).toFixed(2);

(async ()=>{
  await db.query('BEGIN');
  try{
    const now = Date.now();
    for (const rtype of ['DOG','HORSE']){
      for (let t=0;t<TRACKS[rtype].length;t++){
        for (let r=1;r<=3;r++){
          const start = new Date(now + ((t*3)+r)*3600*1000);
          const { rows:[race] } = await db.query(
            `INSERT INTO race_events (rtype,track,race_no,start_time) VALUES ($1,$2,$3,$4) RETURNING id`,
            [rtype, TRACKS[rtype][t], r, start]
          );
          for (let n=1;n<=6;n++){
            await db.query(
              `INSERT INTO race_runners (race_event_id,number,label) VALUES ($1,$2,$3)`,
              [race.id, n, (rtype==='DOG'?'Dog ':'Horse ')+n]
            );
          }
          const { rows:[mWin] } = await db.query(
            `INSERT INTO markets (kind,label,race_event_id) VALUES ('RACE_WIN','Win',$1) RETURNING id`,
            [race.id]
          );
          for (let n=1;n<=6;n++){
            await db.query(
              `INSERT INTO selections (market_id,name,price) VALUES ($1,$2,$3)`,
              [mWin.id, `${rtype==='DOG'?'Dog':'Horse'} #${n}`, rnd()]
            );
          }
          const { rows:[mFc] } = await db.query(
            `INSERT INTO markets (kind,label,race_event_id) VALUES ('RACE_FORECAST','Forecast 1-2',$1) RETURNING id`,
            [race.id]
          );
          for (let a=1;a<=4;a++) for (let b=1;b<=4;b++){
            if (a===b) continue;
            await db.query(
              `INSERT INTO selections (market_id,name,price) VALUES ($1,$2,$3)`,
              [mFc.id, `${a}-${b}`, +(3+(a+b)/4).toFixed(2)]
            );
          }
        }
      }
    }
    await db.query('COMMIT'); console.log('Races seeded');
  }catch(e){ await db.query('ROLLBACK'); console.error(e); process.exit(1); }
  finally{ db.pool.end(); }
})();
