const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
module.exports = { query: (t,p)=>pool.query(t,p), pool };
