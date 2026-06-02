// fix-businesses-table.js
const { Client } = require('pg');

// Use your Public URL (replace with actual)
const PUBLIC_DB_URL = 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway'; // UPDATE THIS

const client = new Client({
  connectionString: PUBLIC_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function ensureBusinessTable() {
  try {
    await client.connect();
    console.log('Connected to database');

    // Define all columns the businesses table should have
    const columnsToAdd = [
      { name: 'verified', type: 'BOOLEAN DEFAULT false' },
      { name: 'featured', type: 'BOOLEAN DEFAULT false' },
      { name: 'user_id', type: 'INTEGER REFERENCES users(id) ON DELETE SET NULL' },
      { name: 'approved', type: 'BOOLEAN DEFAULT false' },
      { name: 'description', type: 'TEXT' },
      { name: 'address', type: 'TEXT' },
      { name: 'city', type: 'VARCHAR(100)' },
      { name: 'state', type: 'VARCHAR(100)' },
      { name: 'phone', type: 'VARCHAR(50)' },
      { name: 'email', type: 'VARCHAR(255)' },
      { name: 'website', type: 'TEXT' },
      { name: 'whatsapp', type: 'VARCHAR(50)' },
      { name: 'maps', type: 'TEXT' },
      { name: 'instagram', type: 'TEXT' },
      { name: 'facebook', type: 'TEXT' },
      { name: 'hours', type: 'JSONB' },
      { name: 'amenities', type: 'JSONB' },
      { name: 'images', type: 'JSONB' },
      { name: 'updated_at', type: 'TIMESTAMP DEFAULT NOW()' }
    ];

    // Check if table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'businesses'
      );
    `);
    const tableExists = tableCheck.rows[0].exists;

    if (!tableExists) {
      console.log('Creating businesses table from scratch...');
      await client.query(`
        CREATE TABLE businesses (
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
      console.log('✅ Table created');
    } else {
      console.log('Table exists. Adding missing columns...');
      for (const col of columnsToAdd) {
        try {
          await client.query(`
            ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};
          `);
          console.log(`  ✅ Column ${col.name} ensured`);
        } catch (err) {
          console.log(`  ⚠️ Could not add ${col.name}: ${err.message}`);
        }
      }
    }

    // Now create indexes (safe, will skip if column missing, but all should be there now)
    await client.query(`
      DO $$ 
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='approved') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_approved ON businesses(approved);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='city') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='category') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category);
        END IF;
      END $$;
    `);
    console.log('✅ Indexes ensured');

    console.log('🎉 Business table is fully ready!');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await client.end();
  }
}

ensureBusinessTable();