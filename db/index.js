// db/index.js
require('dotenv').config();
const { Pool } = require('pg');

function makeConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ssl: false };
  }
  // fallback to discrete vars if DATABASE_URL is missing
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'mastermind_bet',
    user: process.env.PGUSER || 'mastermind',
    password: (process.env.PGPASSWORD || ''), // must be a string
    ssl: false,
  };
}

const pool = new Pool(makeConfig());

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
