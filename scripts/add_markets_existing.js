require('dotenv').config();
const db = require('../db');

async function ensureMarket(label, fixtureId){
  const ex = await db.query(
    `SELECT m.id FROM markets m WHERE m.fixture_id=$1 AND m.label=$2`,
    [fixtureId, label]
  );
  if (ex.rows.length) return null;
  const r = await db.query(
    `INSERT INTO markets (kind,label,fixture_id) VALUES ('FOOTBALL_MAIN',$2,$1) RETURNING id`,
    [fixtureId, label]
  );
  return r.rows[0].id;
}

(async ()=>{
  await db.query('BEGIN');
  try{
    const fx = await db.query(`SELECT id FROM fixtures ORDER BY id`);
    for (let i=0;i<fx.rows.length;i++){
      const fixtureId = fx.rows[i].id;

      // GG/NG
      const m1 = await ensureMarket('GG/NG', fixtureId);
      if (m1){
        await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'GG',1.75)`, [m1]);
        await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'NG',2.05)`, [m1]);
      }

      // 1X2 OV/UN 2.5
      const m2 = await ensureMarket('1X2 OV/UN 2.5', fixtureId);
      if (m2){
        await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'OV2.5',1.90)`, [m2]);
        await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,'UN2.5',1.90)`, [m2]);
      }
    }
    await db.query('COMMIT');
    console.log('Added GG/NG and OU2.5 to existing fixtures.');
  }catch(e){
    await db.query('ROLLBACK'); console.error(e); process.exit(1);
  }finally{
    db.pool.end();
  }
})();
