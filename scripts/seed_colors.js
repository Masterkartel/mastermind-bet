require('dotenv').config();
const db = require('../db');

async function run(){
  await db.query('BEGIN');
  try{
    // next draw in 3 minutes
    const now = new Date();
    const start = new Date(now.getTime() + 3*60*1000);
    const d = await db.query(
      `INSERT INTO color_draws(draw_no,start_time,status) VALUES(
        COALESCE((SELECT MAX(draw_no)+1 FROM color_draws),1), $1, 'scheduled'
      ) RETURNING id, draw_no, start_time`, [start]
    );
    const drawId = d.rows[0].id;

    // market + selections
    const m = await db.query(
      `INSERT INTO markets(kind,label,color_draw_id) VALUES('COLOR','COLOR',$1) RETURNING id`, [drawId]
    );
    const mid = m.rows[0].id;
    await db.query(`INSERT INTO selections(market_id,name,price) VALUES
      ($1,'RED',1.95),($1,'GREEN',1.95),($1,'BLUE',3.20),($1,'YELLOW',5.50)`, [mid]);

    await db.query('COMMIT');
    console.log('Seeded next color draw at', start.toISOString());
  }catch(e){
    await db.query('ROLLBACK'); console.error(e); process.exit(1);
  }finally{
    db.pool.end();
  }
}
run();
