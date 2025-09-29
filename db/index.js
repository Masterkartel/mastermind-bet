// index.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || 'mastermind_bet',
        user: process.env.PGUSER || 'mastermind',
        password: process.env.PGPASSWORD || 'StrongPass123',
      }
);

module.exports = {
  query(text, params) {
    return pool.query(text, params);
  },
  pool,
};
