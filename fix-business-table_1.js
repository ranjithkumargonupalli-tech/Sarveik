const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway',
  ssl: { rejectUnauthorized: false }
});

async function addMissingColumns() {
  try {
    await client.connect();
    console.log('✅ Connected to database');

    // Add all required columns for the businesses table (if they don't exist)
    await client.query(`
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS name VARCHAR(255);
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS type VARCHAR(100);
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS category VARCHAR(100);
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS city VARCHAR(100);
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS state VARCHAR(100);
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS email VARCHAR(255);
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(50);
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS maps TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS instagram TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS facebook TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS hours JSONB;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS amenities JSONB;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS images JSONB;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT false;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT false;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);
    console.log('✅ All columns added successfully');

    // Create indexes for better performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_businesses_approved ON businesses(approved);
      CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
      CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category);
      CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id);
    `);
    console.log('✅ Indexes created');

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await client.end();
    console.log('🔌 Database connection closed');
  }
}

addMissingColumns();