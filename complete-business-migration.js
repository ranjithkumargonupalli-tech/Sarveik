// complete-business-fix.js
const { Client } = require('pg');

// Your PostgreSQL connection URL
const PUBLIC_DB_URL = 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway';

const client = new Client({
  connectionString: PUBLIC_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function completeBusinessFix() {
  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL database');
    console.log('🚀 Starting complete business tables migration...\n');

    // ==================== 1. CREATE BUSINESSES TABLE IF NOT EXISTS ====================
    console.log('📦 Creating/updating businesses table...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS businesses (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(100) NOT NULL,
        category VARCHAR(100) NOT NULL,
        description TEXT,
        short_description VARCHAR(255),
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        zip_code VARCHAR(20),
        country VARCHAR(100) DEFAULT 'India',
        phone VARCHAR(50),
        alternate_phone VARCHAR(50),
        email VARCHAR(255),
        website TEXT,
        whatsapp VARCHAR(50),
        google_maps_url TEXT,
        instagram VARCHAR(255),
        facebook VARCHAR(255),
        twitter VARCHAR(255),
        hours JSONB,
        amenities JSONB,
        images JSONB,
        gallery JSONB,
        logo_url TEXT,
        banner_url TEXT,
        approved BOOLEAN DEFAULT false,
        verified BOOLEAN DEFAULT false,
        featured BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        is_claimed BOOLEAN DEFAULT false,
        user_id INTEGER,
        views INTEGER DEFAULT 0,
        avg_rating DECIMAL(3, 2) DEFAULT 0,
        total_reviews INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('   ✅ businesses table ready');

    // ==================== 2. ADD MISSING COLUMNS ====================
    console.log('\n🔧 Adding missing columns...');
    
    const columnsToAdd = [
      { name: 'short_description', type: 'VARCHAR(255)' },
      { name: 'zip_code', type: 'VARCHAR(20)' },
      { name: 'country', type: 'VARCHAR(100) DEFAULT \'India\'' },
      { name: 'alternate_phone', type: 'VARCHAR(50)' },
      { name: 'google_maps_url', type: 'TEXT' },
      { name: 'twitter', type: 'VARCHAR(255)' },
      { name: 'gallery', type: 'JSONB' },
      { name: 'logo_url', type: 'TEXT' },
      { name: 'banner_url', type: 'TEXT' },
      { name: 'is_active', type: 'BOOLEAN DEFAULT true' },
      { name: 'is_claimed', type: 'BOOLEAN DEFAULT false' }
    ];
    
    for (const col of columnsToAdd) {
      try {
        await client.query(`
          ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};
        `);
        console.log(`   ✅ Added column: ${col.name}`);
      } catch (err) {
        console.log(`   ⚠️ Could not add ${col.name}: ${err.message}`);
      }
    }

    // ==================== 3. CREATE INDEXES ====================
    console.log('\n🔍 Creating indexes...');
    
    await client.query(`
      DO $$ 
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='approved') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_approved ON businesses(approved);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='verified') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_verified ON businesses(verified);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='featured') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_featured ON businesses(featured);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='city') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='category') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='type') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_type ON businesses(type);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='user_id') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='created_at') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_created_at ON businesses(created_at DESC);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='avg_rating') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_rating ON businesses(avg_rating DESC);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='businesses' AND column_name='views') THEN
          CREATE INDEX IF NOT EXISTS idx_businesses_views ON businesses(views DESC);
        END IF;
      END $$;
    `);
    console.log('   ✅ All indexes created');

    // ==================== 4. CREATE BUSINESS REVIEWS TABLE ====================
    console.log('\n📝 Creating business_reviews table...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_reviews (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL,
        user_id INTEGER,
        user_name VARCHAR(100),
        user_email VARCHAR(255),
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        title VARCHAR(255),
        comment TEXT,
        is_verified_purchase BOOLEAN DEFAULT false,
        is_featured BOOLEAN DEFAULT false,
        is_approved BOOLEAN DEFAULT true,
        helpful_count INTEGER DEFAULT 0,
        not_helpful_count INTEGER DEFAULT 0,
        photos JSONB DEFAULT '[]',
        reply TEXT,
        replied_by INTEGER,
        replied_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('   ✅ business_reviews table ready');
    
    // Reviews indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reviews_business_id ON business_reviews(business_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON business_reviews(user_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_rating ON business_reviews(rating);
      CREATE INDEX IF NOT EXISTS idx_reviews_created ON business_reviews(created_at DESC);
    `);
    console.log('   ✅ Reviews indexes created');

    // ==================== 5. CREATE BUSINESS FAVORITES TABLE ====================
    console.log('\n❤️ Creating business_favorites table...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_favorites (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(business_id, user_id)
      );
    `);
    console.log('   ✅ business_favorites table ready');
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_business ON business_favorites(business_id);
      CREATE INDEX IF NOT EXISTS idx_favorites_user ON business_favorites(user_id);
    `);
    console.log('   ✅ Favorites indexes created');

    // ==================== 6. CREATE BUSINESS REPORTS TABLE ====================
    console.log('\n🚩 Creating business_reports table...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_reports (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL,
        user_id INTEGER,
        reporter_name VARCHAR(100),
        reporter_email VARCHAR(255),
        reason VARCHAR(100) NOT NULL,
        details TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        resolved_by INTEGER,
        resolved_at TIMESTAMP,
        resolution_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('   ✅ business_reports table ready');
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_business ON business_reports(business_id);
      CREATE INDEX IF NOT EXISTS idx_reports_status ON business_reports(status);
    `);
    console.log('   ✅ Reports indexes created');

    // ==================== 7. CREATE BUSINESS CLAIMS TABLE ====================
    console.log('\n🔑 Creating business_claims table...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_claims (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        verification_document TEXT,
        verification_code VARCHAR(10),
        claimed_at TIMESTAMP,
        approved_by INTEGER,
        approved_at TIMESTAMP,
        rejection_reason TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(business_id, user_id)
      );
    `);
    console.log('   ✅ business_claims table ready');

    // ==================== 8. CREATE CREDITS TRANSACTIONS TABLE ====================
    console.log('\n💰 Creating credits_transactions table...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS credits_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        business_id INTEGER,
        amount INTEGER NOT NULL,
        type VARCHAR(50) NOT NULL,
        reason TEXT,
        reference_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('   ✅ credits_transactions table ready');
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_credits_user ON credits_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_credits_created ON credits_transactions(created_at DESC);
    `);
    console.log('   ✅ Credits indexes created');

    // ==================== 9. CREATE BUSINESS ACTIVITY LOG TABLE ====================
    console.log('\n📋 Creating business_activity_log table...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_activity_log (
        id SERIAL PRIMARY KEY,
        business_id INTEGER,
        user_id INTEGER,
        action VARCHAR(100) NOT NULL,
        details JSONB,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('   ✅ business_activity_log table ready');

    // ==================== 10. CREATE BUSINESS NOTIFICATIONS TABLE ====================
    console.log('\n🔔 Creating business_notifications table...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        business_id INTEGER,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT false,
        action_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('   ✅ business_notifications table ready');

    // ==================== 11. CHECK EXISTING DATA ====================
    console.log('\n📊 Checking existing data...');
    
    const businessCount = await client.query('SELECT COUNT(*) FROM businesses');
    console.log(`   📈 Existing businesses: ${businessCount.rows[0].count}`);
    
    // ==================== 12. INSERT SAMPLE DATA IF EMPTY ====================
    if (parseInt(businessCount.rows[0].count) === 0) {
      console.log('\n📝 Inserting sample business data...');
      
      await client.query(`
        INSERT INTO businesses (
          name, type, category, description, address, city, state, 
          phone, email, website, approved, verified, featured, 
          hours, amenities, avg_rating, total_reviews, views
        ) VALUES 
        (
          'City Supermart', 'mart', 'Retail',
          'One-stop grocery and household shopping destination with a wide range of fresh produce, branded products, and daily essentials.',
          '45, Anna Salai, T. Nagar', 'Chennai', 'Tamil Nadu',
          '+91 9876543210', 'info@citysupermart.com', 'https://example.com',
          true, true, true,
          '{"monday":"9:00-21:00","tuesday":"9:00-21:00","wednesday":"9:00-21:00","thursday":"9:00-21:00","friday":"9:00-22:00","saturday":"8:00-22:00","sunday":"10:00-20:00"}',
          '["parking", "wifi", "card", "upi"]',
          4.5, 128, 15420
        ),
        (
          'TechNova Solutions', 'tech', 'Technology',
          'Leading IT services company specializing in web development, cloud solutions, and digital transformation.',
          '12, Rajiv Gandhi IT Park, Sholinganallur', 'Chennai', 'Tamil Nadu',
          '+91 8765432109', 'hello@technova.io', 'https://example.com',
          true, true, false,
          '{"monday":"9:00-18:00","tuesday":"9:00-18:00","wednesday":"9:00-18:00","thursday":"9:00-18:00","friday":"9:00-17:00","saturday":"Closed","sunday":"Closed"}',
          '["wifi", "parking", "ac", "accessible"]',
          4.8, 89, 8750
        ),
        (
          'Spice Garden Restaurant', 'restaurant', 'Food & Dining',
          'Authentic South Indian cuisine with a modern twist. Serving traditional dosas, biryanis, and seafood specialties.',
          '88, Mount Road, Nungambakkam', 'Chennai', 'Tamil Nadu',
          '+91 7654321098', 'reservations@spicegarden.in', '',
          true, false, false,
          '{"monday":"11:00-23:00","tuesday":"11:00-23:00","wednesday":"11:00-23:00","thursday":"11:00-23:00","friday":"11:00-23:30","saturday":"10:00-23:30","sunday":"10:00-22:00"}',
          '["ac", "card", "upi", "reservation", "takeaway", "delivery", "outdoor", "kids"]',
          4.3, 234, 28760
        ),
        (
          'Wellness Pharmacy', 'pharmacy', 'Health & Wellness',
          'Your trusted neighborhood pharmacy offering prescription medicines, over-the-counter drugs, health supplements, and professional consultation.',
          '3, Gandhi Road, Adyar', 'Chennai', 'Tamil Nadu',
          '+91 6543210987', 'wellness@pharmacy.com', '',
          true, true, false,
          '{"monday":"7:00-22:00","tuesday":"7:00-22:00","wednesday":"7:00-22:00","thursday":"7:00-22:00","friday":"7:00-22:00","saturday":"7:00-22:00","sunday":"8:00-21:00"}',
          '["card", "upi", "delivery", "accessible"]',
          4.6, 67, 12340
        );
      `);
      console.log('   ✅ Sample data inserted (4 businesses)');
    }

    // ==================== 13. VERIFY FINAL STATE ====================
    console.log('\n' + '='.repeat(60));
    console.log('📋 MIGRATION COMPLETE SUMMARY');
    console.log('='.repeat(60));
    
    const finalBusinessCount = await client.query('SELECT COUNT(*) FROM businesses');
    const reviewCount = await client.query('SELECT COUNT(*) FROM business_reviews');
    const favoriteCount = await client.query('SELECT COUNT(*) FROM business_favorites');
    const reportCount = await client.query('SELECT COUNT(*) FROM business_reports');
    
    console.log('\n📊 Final Statistics:');
    console.log(`   🏢 Businesses: ${finalBusinessCount.rows[0].count}`);
    console.log(`   ⭐ Reviews: ${reviewCount.rows[0].count}`);
    console.log(`   ❤️ Favorites: ${favoriteCount.rows[0].count}`);
    console.log(`   🚩 Reports: ${reportCount.rows[0].count}`);
    
    // Check approval status
    const approvedCount = await client.query(`
      SELECT COUNT(*) FROM businesses WHERE approved = true
    `);
    const pendingCount = await client.query(`
      SELECT COUNT(*) FROM businesses WHERE approved = false
    `);
    
    console.log(`\n📋 Business Status:`);
    console.log(`   ✅ Approved: ${approvedCount.rows[0].count}`);
    console.log(`   ⏳ Pending: ${pendingCount.rows[0].count}`);
    
    console.log('\n' + '='.repeat(60));
    console.log('🎉 BUSINESS DIRECTORY MIGRATION COMPLETED SUCCESSFULLY!');
    console.log('='.repeat(60));
    
    console.log('\n📌 Next Steps for Your Admin Panel:');
    console.log('   1. Admin approval will update "approved" column to true');
    console.log('   2. Approved businesses appear in the directory');
    console.log('   3. Users earn credits when businesses are approved');
    console.log('   4. Reviews and ratings are stored in business_reviews');
    console.log('   5. Favorites are stored in business_favorites');
    
  } catch (err) {
    console.error('\n❌ Migration Error:', err.message);
    console.error('Error details:', err.stack);
  } finally {
    await client.end();
    console.log('\n🔌 Database connection closed.');
  }
}

// Run the migration
completeBusinessFix();