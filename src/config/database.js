const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

// Convenience query wrapper
const db = {
  query: (text, params) => pool.query(text, params),

  // Get single row
  getOne: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows[0] || null;
  },

  // Get all rows
  getAll: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows;
  },

  // Run insert/update/delete — returns rowCount
  run: async (text, params) => {
    const res = await pool.query(text, params);
    return res;
  },

  // Transaction helper
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = db;
