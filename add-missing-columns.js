const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway',
  ssl: { rejectUnauthorized: false }
});

async function addColumns() {
  try {
    await client.connect();
    await client.query(`
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);
    console.log('✅ created_at and updated_at columns added');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await client.end();
  }
}

addColumns();