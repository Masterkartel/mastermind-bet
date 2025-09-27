// db/index.js
require('dotenv').config();
const { Pool } = require('pg');

function cfg() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL, ssl: false };
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'mastermind_bet',
    user: process.env.PGUSER || 'mastermind',
    password: String(process.env.PGPASSWORD || ''),
    ssl: false,
  };
}
const pool = new Pool(cfg());
module.exports = { query: (q,p)=>pool.query(q,p), pool };
