require('dotenv').config();
const db = require('../db');

const colorFor = n => ['RED','GREEN','BLUE','YELLOW'][(n-1)%4];

(async ()=>{
  await db.query('BEGIN');
  try{
    for (let n=1;n<=49;n++){
      await db.query(
        `INSERT INTO color_map (number,color) VALUES ($1,$2)
         ON CONFLICT (number) DO UPDATE SET color=EXCLUDED.color`,
        [n, colorFor(n)]
      );
    }
    const now = Date.now();
    for (let i=1;i<=5;i++){
      const start = new Date(now + i*30*60*1000);
      const { rows:[d] } = await db.query(
        `INSERT INTO color_draws (draw_no,start_time) VALUES ($1,$2) RETURNING id`,
        [i, start]
      );
      const { rows:[m] } = await db.query(
        `INSERT INTO markets (kind,label,color_draw_id) VALUES ('COLOR_PICK','Pick Color',$1) RETURNING id`,
        [d.id]
      );
      for (const c of ['RED','GREEN','BLUE','YELLOW']){
        await db.query(`INSERT INTO selections (market_id,name,price) VALUES ($1,$2,$3)`,
          [m.id, c, 3.6]);
      }
    }
    await db.query('COMMIT'); console.log('Colors seeded');
  }catch(e){ await db.query('ROLLBACK'); console.error(e); process.exit(1); }
  finally{ db.pool.end(); }
})();
