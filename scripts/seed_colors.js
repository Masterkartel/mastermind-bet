// scripts/seed_colors.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgres://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST||'127.0.0.1'}:${process.env.PGPORT||5432}/${process.env.PGDATABASE}`
});

function priceOf(color){ // tweak to taste
  // simple slightly-biased prices
  const base = { RED:1.95, GREEN:1.95, BLUE:1.95, YELLOW:2.30 };
  return base[color] || 2.0;
}
function priceBucket(name){
  // name in ['0','2+','3+','4+','5+','6']
  const p = { '0':8.00, '2+':2.80, '3+':3.60, '4+':5.00, '5+':8.50, '6':14.0 };
  return p[name] || 3.0;
}

(async ()=>{
  const cli = await pool.connect();
  try{
    await cli.query('BEGIN');

    // make 120 draws ahead, 3 minutes apart
    const now = Date.now();
    const startAt = new Date(Math.ceil(now/180000)*180000 + 60000); // next 3-min slot + 60s buffer
    const draws = 120;

    // clean existing *scheduled* draws to avoid pileup (safe for dev)
    await cli.query(`DELETE FROM color_draws WHERE status='scheduled'`);

    for (let i=0;i<draws;i++){
      const t = new Date(startAt.getTime() + i*180000); // every 3 min
      const { rows:[d] } = await cli.query(
        `INSERT INTO color_draws (draw_no, start_time, status)
         VALUES ($1,$2,'scheduled') RETURNING id`, [i+1, t]
      );

      // markets for this draw
      const m1 = await cli.query(
        `INSERT INTO markets (kind,label,color_draw_id) VALUES ('COLOR','WINNING COLOR',$1) RETURNING id`, [d.id]
      );
      const m2 = await cli.query(
        `INSERT INTO markets (kind,label,color_draw_id) VALUES ('COLOR','NUMBER OF COLORS',$1) RETURNING id`, [d.id]
      );

      // selections for WINNING COLOR
      for (const c of ['RED','GREEN','BLUE','YELLOW']){
        await cli.query(
          `INSERT INTO selections (market_id,name,price) VALUES ($1,$2,$3)`,
          [m1.rows[0].id, c, priceOf(c)]
        );
      }

      // selections for NUMBER OF COLORS (layout like your screenshot)
      for (const n of ['0','2+','3+','4+','5+','6']){
        await cli.query(
          `INSERT INTO selections (market_id,name,price) VALUES ($1,$2,$3)`,
          [m2.rows[0].id, n, priceBucket(n)]
        );
      }
    }

    await cli.query('COMMIT');
    console.log(`Seeded ${draws} color draws, every 3 minutes, with both markets.`);
  } catch(e){
    await cli.query('ROLLBACK');
    console.error(e);
    process.exit(1);
  } finally {
    cli.release();
    pool.end();
  }
})();
