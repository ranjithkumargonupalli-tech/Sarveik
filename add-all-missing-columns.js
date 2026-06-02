const { Client } = require('pg');

const DB_URL = 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway';

const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function addAllMissingColumns() {
  try {
    await client.connect();
    console.log('✅ Connected to database');
    console.log('🚀 Adding missing columns to businesses table...\n');

    // ==================== ALL MISSING COLUMNS ====================
    const columns = [
      // Basic Information
      'short_description VARCHAR(255)',
      'sub_category VARCHAR(100)',
      
      // Location details
      'zip_code VARCHAR(20)',
      'country VARCHAR(100) DEFAULT \'India\'',
      'latitude DECIMAL(10, 8)',
      'longitude DECIMAL(11, 8)',
      'alternate_phone VARCHAR(50)',
      
      // Social Media
      'twitter VARCHAR(255)',
      'linkedin VARCHAR(255)',
      'youtube VARCHAR(255)',
      
      // Media
      'logo_url TEXT',
      'banner_url TEXT',
      'gallery JSONB DEFAULT \'[]\'',
      'video_url TEXT',
      
      // Status flags
      'is_active BOOLEAN DEFAULT true',
      'is_claimed BOOLEAN DEFAULT false',
      'is_emergency BOOLEAN DEFAULT false',
      'premium BOOLEAN DEFAULT false',
      
      // Statistics
      'views INTEGER DEFAULT 0',
      'unique_views INTEGER DEFAULT 0',
      'shares INTEGER DEFAULT 0',
      'clicks INTEGER DEFAULT 0',
      'avg_rating DECIMAL(3, 2) DEFAULT 0',
      'total_reviews INTEGER DEFAULT 0',
      
      // Payment & Features
      'payment_methods JSONB DEFAULT \'["cash", "card", "upi"]\'',
      'features JSONB DEFAULT \'[]\'',
      
      // Relationships (nullable foreign keys)
      'claimed_by INTEGER',
      'verified_by INTEGER',
      'approved_by INTEGER',
      
      // Timestamps
      'approved_at TIMESTAMP',
      'verified_at TIMESTAMP',
      'last_activity TIMESTAMP DEFAULT NOW()',
      
      // SEO & Metadata
      'meta_title VARCHAR(255)',
      'meta_description TEXT',
      'meta_keywords TEXT',
      'seo_score INTEGER DEFAULT 0',
      'custom_fields JSONB DEFAULT \'{}\''
    ];

    let addedCount = 0;
    let skippedCount = 0;

    for (const col of columns) {
      try {
        const columnName = col.split(' ')[0];
        await client.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ${col}`);
        console.log(`   ✅ Added column: ${columnName}`);
        addedCount++;
      } catch (err) {
        console.log(`   ⚠️ Could not add ${col.split(' ')[0]}: ${err.message}`);
        skippedCount++;
      }
    }

    console.log(`\n📊 Summary: ${addedCount} columns added, ${skippedCount} skipped`);

    // ==================== ADD INDEXES ====================
    console.log('\n🔍 Creating indexes for better performance...\n');

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_businesses_approved ON businesses(approved)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_verified ON businesses(verified)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_featured ON businesses(featured)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_type ON businesses(type)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_created_at ON businesses(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_avg_rating ON businesses(avg_rating DESC)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_views ON businesses(views DESC)',
      'CREATE INDEX IF NOT EXISTS idx_businesses_is_active ON businesses(is_active) WHERE is_active = true',
      'CREATE INDEX IF NOT EXISTS idx_businesses_approved_active ON businesses(approved) WHERE approved = true',
      'CREATE INDEX IF NOT EXISTS idx_businesses_city_category ON businesses(city, category)'
    ];

    for (const idx of indexes) {
      try {
        await client.query(idx);
        const idxName = idx.split(' ON ')[0].replace('CREATE INDEX IF NOT EXISTS ', '');
        console.log(`   ✅ Index created: ${idxName}`);
      } catch (err) {
        console.log(`   ⚠️ Could not create index: ${err.message}`);
      }
    }

    // ==================== VERIFY FINAL STATE ====================
    console.log('\n📋 Verifying businesses table structure...\n');

    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'businesses'
      ORDER BY ordinal_position
    `);

    console.log('✅ Current columns in businesses table:');
    result.rows.forEach(row => {
      console.log(`   - ${row.column_name} (${row.data_type})`);
    });

    // ==================== CHECK TABLE SIZE ====================
    const countResult = await client.query('SELECT COUNT(*) FROM businesses');
    console.log(`\n📊 Total businesses in database: ${countResult.rows[0].count}`);

    console.log('\n' + '='.repeat(60));
    console.log('🎉 MIGRATION COMPLETED SUCCESSFULLY!');
    console.log('='.repeat(60));
    console.log('\n📌 Your businesses table is now ready for all operations!');

  } catch (err) {
    console.error('\n❌ Migration error:', err.message);
    console.error('Error details:', err.stack);
  } finally {
    await client.end();
    console.log('\n🔌 Database connection closed.');
  }
}

// Run the migration
addAllMissingColumns();