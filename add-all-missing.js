const { Client } = require('pg');

const DB_URL = 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway';

const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function addAllMissing() {
  await client.connect();
  const columns = [
    'description TEXT', 'address TEXT', 'city VARCHAR(100)', 'state VARCHAR(100)',
    'phone VARCHAR(50)', 'email VARCHAR(255)', 'website TEXT', 'whatsapp VARCHAR(50)',
    'maps TEXT', 'instagram TEXT', 'facebook TEXT', 'hours JSONB', 'amenities JSONB',
    'images JSONB', 'approved BOOLEAN DEFAULT false', 'verified BOOLEAN DEFAULT false',
    'featured BOOLEAN DEFAULT false', 'user_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
    'created_at TIMESTAMP DEFAULT NOW()', 'updated_at TIMESTAMP DEFAULT NOW()'
  ];
  for (const col of columns) {
    try {
      await client.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ${col}`);
      console.log(`✅ Added ${col.split(' ')[0]}`);
    } catch (err) {
      console.log(`⚠️ Skip ${col.split(' ')[0]}: ${err.message}`);
    }
  }
  await client.end();
  console.log('Done');
}

addAllMissing();