// add-business-table.js - Only adds the businesses table and missing columns
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function migrateBusinessTable() {
  const client = await pool.connect();
  try {
    console.log('🔍 Checking for businesses table...');

    // 1. Create businesses table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(100) NOT NULL,
        category VARCHAR(100) NOT NULL,
        description TEXT,
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        phone VARCHAR(50),
        email VARCHAR(255),
        website TEXT,
        whatsapp VARCHAR(50),
        maps TEXT,
        instagram TEXT,
        facebook TEXT,
        hours JSONB,
        amenities JSONB,
        images JSONB,
        approved BOOLEAN DEFAULT false,
        verified BOOLEAN DEFAULT false,
        featured BOOLEAN DEFAULT false,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ businesses table ready');

    // 2. Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_businesses_approved ON businesses(approved);
      CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
      CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category);
    `);
    console.log('✅ indexes created');

    // 3. Add missing columns to support_tickets (if they don't exist)
    console.log('🔍 Checking support_tickets table...');
    await client.query(`
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general';
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS internal_notes JSONB;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMP;
    `);
    console.log('✅ support_tickets columns added (if missing)');

    // 4. Create moderator_status table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS moderator_status (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        current_tickets INTEGER DEFAULT 0,
        is_online BOOLEAN DEFAULT true,
        last_active TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ moderator_status table ready');

    console.log('🎉 Migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateBusinessTable();