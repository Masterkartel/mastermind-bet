const { Pool } = require('pg');
const opts = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: false }
  : {
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'mastermind_bet',
      user: process.env.PGUSER || 'mastermind',
      password: String(process.env.PGPASSWORD || ''),
      ssl: false,
    };
const pool = new Pool(opts);
module.exports = { query: (t,p)=>pool.query(t,p), pool };
