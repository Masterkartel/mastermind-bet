require('dotenv').config();
const db = require('../db');
const OD = require('./lib/odds');

async function race(type, track, raceNo, start){
  const r = await db.query(
    `INSERT INTO race_events(rtype,track,race_no,start_time,status) VALUES($1,$2,$3,$4,'scheduled') RETURNING id`,
    [type,track,raceNo,start]
  );
  return r.rows[0].id;
}
async function mkt(label, raceId){
  const r = await db.query(`INSERT INTO markets(kind,label,race_event_id) VALUES('RACE',$2,$1) RETURNING id`,[raceId,label]);
  return r.rows[0].id;
}
async function sel(mid, name, price){
  await db.query(`INSERT INTO selections(market_id,name,price) VALUES($1,$2,$3)`,[mid,name,price]);
}

async function seedType(type, tracks){
  const now = Date.now();
  for (let t=0;t<tracks.length;t++){
    for (let n=1;n<=4;n++){ // 4 upcoming races per track
      const start = new Date(now + (t*4+n)*90*1000); // every 90s stagger
      const rid = await race(type, tracks[t], n, start);

      // 6 runners
      const win = OD.winBook(6); // [2.4..]
      // MAIN (Win)
      let mid = await mkt('MAIN', rid);
      for (let i=0;i<6;i++) await sel(mid, String(i+1), win[i]);

      // FORECAST (ordered 1st>2nd) — top combos only to limit volume
      mid = await mkt('FORECAST', rid);
      for (let i=0;i<6;i++){
        for (let j=0;j<6;j++){
          if (i===j) continue;
          if (i<3 && j<3) await sel(mid, (i+1)+">"+(j+1), OD.forecastPrice(win[i], win[j]));
        }
      }

      // QUINELLA (any order first two)
      mid = await mkt('QUINELLA', rid);
      for (let i=0;i<6;i++){
        for (let j=i+1;j<6;j++){
          await sel(mid, (i+1)+"&"+(j+1), OD.quinellaPrice(win[i], win[j]));
        }
      }

      // TRICAST (1st>2nd>3rd) — a subset for practicality
      mid = await mkt('TRICAST', rid);
      for (let a=0;a<3;a++) for (let b=0;b<3;b++) for (let c=0;c<3;c++){
        if (a===b || a===c || b===c) continue;
        await sel(mid, (a+1)+">"+(b+1)+">"+(c+1), OD.tricastPrice(win[a], win[b], win[c]));
      }
    }
  }
}

(async ()=>{
  await db.query('BEGIN');
  try{
    await seedType('DOG', ['Doncaster','Hove']);
    await seedType('HORSE', ['Ascot','Epsom']);
    await db.query('COMMIT');
    console.log('Seeded dogs & horses with MAIN/FORECAST/QUINELLA/TRICAST');
  }catch(e){
    await db.query('ROLLBACK'); console.error(e); process.exit(1);
  }finally{
    db.pool.end();
  }
})();
