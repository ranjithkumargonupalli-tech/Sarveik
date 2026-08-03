// fix-all-new-features.js
// Run this script ONCE to set up all new tables and columns for Sarveik's delivery, COD, affiliate, gamification, etc.

const { Client } = require('pg');

// ——— UPDATE THIS WITH YOUR ACTUAL CONNECTION STRING ———
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway';

const client = new Client({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false }
});

// ================================================================
// 1. DEFINE ALL NEW TABLES (CREATE IF NOT EXISTS)
// ================================================================

const NEW_TABLES = [
  {
    name: 'products',
    schema: `
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE NOT NULL,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        category VARCHAR(100),
        image_url VARCHAR(500),
        stock_quantity INT DEFAULT 0,
        is_available BOOLEAN DEFAULT true,
        delivery_radius INT DEFAULT 10,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP
      );
    `
  },
  {
    name: 'user_addresses',
    schema: `
      CREATE TABLE IF NOT EXISTS user_addresses (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        label VARCHAR(50) DEFAULT 'Home',
        address TEXT NOT NULL,
        latitude DECIMAL(10,8),
        longitude DECIMAL(11,8),
        instructions TEXT,
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'orders',
    schema: `
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE NOT NULL,
        delivery_partner_id INT REFERENCES users(id) NULL,
        total_amount DECIMAL(10,2) NOT NULL,
        delivery_address TEXT NOT NULL,
        delivery_instructions TEXT,
        latitude DECIMAL(10,8),
        longitude DECIMAL(11,8),
        status VARCHAR(50) DEFAULT 'pending',
        placed_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP,
        estimated_delivery_minutes INT,
        actual_delivery_minutes INT,
        scheduled_at TIMESTAMP NULL,
        promo_code VARCHAR(50),
        discount_amount DECIMAL(10,2) DEFAULT 0,
        delivery_fee DECIMAL(10,2) DEFAULT 0,
        paid_with_credits BOOLEAN DEFAULT false,
        paid_amount DECIMAL(10,2) NOT NULL,
        payment_method VARCHAR(20) DEFAULT 'cod',
        confirmation_token VARCHAR(64) UNIQUE,
        confirmed_at TIMESTAMP
      );
    `
  },
  {
    name: 'order_items',
    schema: `
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
        product_id INT REFERENCES products(id) ON DELETE CASCADE NOT NULL,
        quantity INT NOT NULL,
        price_at_time DECIMAL(10,2) NOT NULL
      );
    `
  },
  {
    name: 'delivery_requests',
    schema: `
      CREATE TABLE IF NOT EXISTS delivery_requests (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
        partner_id INT REFERENCES users(id) NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP
      );
    `
  },
  {
    name: 'promo_codes',
    schema: `
      CREATE TABLE IF NOT EXISTS promo_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        description TEXT,
        discount_type VARCHAR(20) DEFAULT 'percentage',
        discount_value DECIMAL(10,2) NOT NULL,
        min_order_value DECIMAL(10,2) DEFAULT 0,
        max_discount DECIMAL(10,2) DEFAULT NULL,
        usage_limit INT DEFAULT 1,
        used_count INT DEFAULT 0,
        valid_from TIMESTAMP DEFAULT NOW(),
        valid_until TIMESTAMP,
        created_by INT REFERENCES users(id),
        is_active BOOLEAN DEFAULT true
      );
    `
  },
  {
    name: 'promo_usage',
    schema: `
      CREATE TABLE IF NOT EXISTS promo_usage (
        id SERIAL PRIMARY KEY,
        promo_code_id INT REFERENCES promo_codes(id),
        user_id INT REFERENCES users(id),
        order_id INT REFERENCES orders(id),
        used_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'order_ratings',
    schema: `
      CREATE TABLE IF NOT EXISTS order_ratings (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
        rating INT CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'partner_reviews',
    schema: `
      CREATE TABLE IF NOT EXISTS partner_reviews (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
        partner_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        rating INT CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'partner_earnings',
    schema: `
      CREATE TABLE IF NOT EXISTS partner_earnings (
        id SERIAL PRIMARY KEY,
        partner_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        paid_at TIMESTAMP
      );
    `
  },
  {
    name: 'disputes',
    schema: `
      CREATE TABLE IF NOT EXISTS disputes (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
        user_id INT REFERENCES users(id),
        partner_id INT REFERENCES users(id),
        reason TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP,
        resolution TEXT
      );
    `
  },
  {
    name: 'sponsored_packages',
    schema: `
      CREATE TABLE IF NOT EXISTS sponsored_packages (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        duration_days INT,
        price DECIMAL(10,2),
        position_priority INT,
        features JSONB
      );
    `
  },
  {
    name: 'sponsored_listings',
    schema: `
      CREATE TABLE IF NOT EXISTS sponsored_listings (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) NOT NULL,
        package_type VARCHAR(50) NOT NULL,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        price_paid DECIMAL(10,2) NOT NULL,
        clicks INT DEFAULT 0,
        views INT DEFAULT 0,
        custom_message TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'affiliate_links',
    schema: `
      CREATE TABLE IF NOT EXISTS affiliate_links (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) NOT NULL,
        product_name VARCHAR(200),
        product_url TEXT NOT NULL,
        commission_rate DECIMAL(5,2) DEFAULT 7.00,
        click_count INT DEFAULT 0,
        sale_count INT DEFAULT 0,
        total_revenue DECIMAL(10,2) DEFAULT 0,
        total_commission DECIMAL(10,2) DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'affiliate_clicks',
    schema: `
      CREATE TABLE IF NOT EXISTS affiliate_clicks (
        id SERIAL PRIMARY KEY,
        affiliate_link_id INT REFERENCES affiliate_links(id),
        user_id INT REFERENCES users(id),
        ip_address INET,
        user_agent TEXT,
        referrer TEXT,
        clicked_at TIMESTAMP DEFAULT NOW(),
        session_id VARCHAR(100)
      );
    `
  },
  {
    name: 'affiliate_conversions',
    schema: `
      CREATE TABLE IF NOT EXISTS affiliate_conversions (
        id SERIAL PRIMARY KEY,
        affiliate_link_id INT REFERENCES affiliate_links(id),
        click_id INT REFERENCES affiliate_clicks(id),
        order_id VARCHAR(100),
        sale_amount DECIMAL(10,2),
        commission_earned DECIMAL(10,2),
        commission_rate DECIMAL(5,2),
        status VARCHAR(20) DEFAULT 'pending',
        business_notes TEXT,
        conversion_date TIMESTAMP DEFAULT NOW(),
        approved_at TIMESTAMP,
        paid_at TIMESTAMP
      );
    `
  },
  {
    name: 'business_affiliate_settings',
    schema: `
      CREATE TABLE IF NOT EXISTS business_affiliate_settings (
        business_id INT REFERENCES businesses(id) PRIMARY KEY,
        auto_approve_conversions BOOLEAN DEFAULT false,
        notification_email BOOLEAN DEFAULT true,
        min_payout_amount DECIMAL(10,2) DEFAULT 1000,
        tracking_days INT DEFAULT 30,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'daily_quests',
    schema: `
      CREATE TABLE IF NOT EXISTS daily_quests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        target_action VARCHAR(50) NOT NULL,
        target_count INT DEFAULT 1,
        xp_reward INT DEFAULT 10,
        credits_reward INT DEFAULT 5,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'user_daily_quests',
    schema: `
      CREATE TABLE IF NOT EXISTS user_daily_quests (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        quest_id INT REFERENCES daily_quests(id) ON DELETE CASCADE,
        date DATE DEFAULT CURRENT_DATE,
        progress INT DEFAULT 0,
        completed BOOLEAN DEFAULT false,
        claimed BOOLEAN DEFAULT false,
        UNIQUE(user_id, quest_id, date)
      );
    `
  },
  {
    name: 'achievements',
    schema: `
      CREATE TABLE IF NOT EXISTS achievements (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        condition_type VARCHAR(50) NOT NULL,
        condition_value INT NOT NULL,
        xp_reward INT DEFAULT 20,
        icon VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'user_achievements',
    schema: `
      CREATE TABLE IF NOT EXISTS user_achievements (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        achievement_id INT REFERENCES achievements(id) ON DELETE CASCADE,
        earned_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, achievement_id)
      );
    `
  },
  {
    name: 'level_rewards',
    schema: `
      CREATE TABLE IF NOT EXISTS level_rewards (
        id SERIAL PRIMARY KEY,
        level INT NOT NULL UNIQUE,
        reward_type VARCHAR(50) NOT NULL,
        reward_value INT NOT NULL
      );
    `
  },
  {
    name: 'user_streak',
    schema: `
      CREATE TABLE IF NOT EXISTS user_streak (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        current_streak INT DEFAULT 0,
        longest_streak INT DEFAULT 0,
        last_login_date DATE,
        multiplier DECIMAL(3,2) DEFAULT 1.0
      );
    `
  },
  {
    name: 'user_avatars',
    schema: `
      CREATE TABLE IF NOT EXISTS user_avatars (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        avatar_id VARCHAR(50) NOT NULL,
        unlocked_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT false,
        UNIQUE(user_id, avatar_id)
      );
    `
  },
  {
    name: 'moderator_status',
    schema: `
      CREATE TABLE IF NOT EXISTS moderator_status (
        user_id INT REFERENCES users(id) PRIMARY KEY,
        current_tickets INT DEFAULT 0,
        is_online BOOLEAN DEFAULT true,
        last_active TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'business_reviews',
    schema: `
      CREATE TABLE IF NOT EXISTS business_reviews (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE NOT NULL,
        user_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        rating INT CHECK (rating BETWEEN 1 AND 5) NOT NULL,
        title TEXT,
        comment TEXT,
        is_approved BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP
      );
    `
  },
  {
    name: 'business_favorites',
    schema: `
      CREATE TABLE IF NOT EXISTS business_favorites (
        id SERIAL PRIMARY KEY,
        business_id INT REFERENCES businesses(id) ON DELETE CASCADE NOT NULL,
        user_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(business_id, user_id)
      );
    `
  },
  {
    name: 'tool_usage',
    schema: `
      CREATE TABLE IF NOT EXISTS tool_usage (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        tool_name VARCHAR(255) NOT NULL,
        tool_category VARCHAR(100),
        used_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'tool_reviews',
    schema: `
      CREATE TABLE IF NOT EXISTS tool_reviews (
        id SERIAL PRIMARY KEY,
        tool_id INT REFERENCES tools(id) ON DELETE CASCADE NOT NULL,
        user_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        rating INT CHECK (rating BETWEEN 1 AND 5) NOT NULL,
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  },
  {
    name: 'category_reviews',
    schema: `
      CREATE TABLE IF NOT EXISTS category_reviews (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        category VARCHAR(100) NOT NULL,
        rating INT CHECK (rating BETWEEN 1 AND 5) NOT NULL,
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `
  }
];

// ================================================================
// 2. COLUMNS TO ADD TO EXISTING TABLES (INCLUDING lat & lng)
// ================================================================

const EXISTING_TABLE_COLUMNS = {
  users: [
    { name: 'last_latitude', type: 'DECIMAL(10,8)' },
    { name: 'last_longitude', type: 'DECIMAL(11,8)' },
    { name: 'is_online', type: 'BOOLEAN DEFAULT false' },
    { name: 'total_deliveries', type: 'INT DEFAULT 0' },
    { name: 'earnings', type: 'DECIMAL(10,2) DEFAULT 0' }
  ],
  businesses: [
    { name: 'delivery_radius', type: 'INT DEFAULT 10' },
    { name: 'is_delivery_enabled', type: 'BOOLEAN DEFAULT true' },
    { name: 'delivery_slots', type: 'JSONB DEFAULT \'{"start": "09:00", "end": "21:00"}\'' },
    // --- NEW: latitude & longitude for location-based queries ---
    { name: 'lat', type: 'DECIMAL(10,8)' },
    { name: 'lng', type: 'DECIMAL(11,8)' },
    // The following columns were already added by the previous script, but we keep them here for safety
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
  ]
};

// ================================================================
// 3. INDEXES TO CREATE (only if column exists)
// ================================================================

const INDEXES = [
  { table: 'orders', columns: ['user_id', 'business_id', 'status', 'placed_at'] },
  { table: 'products', columns: ['business_id', 'category'] },
  { table: 'delivery_requests', columns: ['partner_id', 'status'] },
  { table: 'affiliate_links', columns: ['business_id'] },
  { table: 'affiliate_clicks', columns: ['affiliate_link_id'] },
  { table: 'users', columns: ['last_latitude', 'last_longitude'] },
  { table: 'businesses', columns: ['lat', 'lng'] }, // now they exist
  { table: 'user_daily_quests', columns: ['date'] },
  { table: 'user_achievements', columns: ['user_id'] },
  { table: 'tool_usage', columns: ['used_at', 'tool_name'] }
];

// ================================================================
// 4. SEED DATA (Fixed: no ::jsonb cast)
// ================================================================

const SEED_DATA = [
  // Sponsored packages
  {
    table: 'sponsored_packages',
    columns: ['name', 'duration_days', 'price', 'position_priority', 'features'],
    values: [
      ['Basic Spotlight', 30, 1499, 2, '{"impressions": 5000, "badge": "Sponsored"}'],
      ['Premium Featured', 30, 4999, 1, '{"impressions": 20000, "badge": "⭐ Featured Sponsor", "custom_message": true}'],
      ['Enterprise Dominance', 30, 14999, 0, '{"impressions": 100000, "badge": "👑 Official Partner", "custom_message": true, "homepage_banner": true}']
    ],
    check: 'SELECT 1 FROM sponsored_packages LIMIT 1'
  },
  // Daily quests
  {
    table: 'daily_quests',
    columns: ['name', 'description', 'target_action', 'target_count', 'xp_reward', 'credits_reward'],
    values: [
      ['Daily Login', 'Log in to Sarveik', 'login', 1, 10, 5],
      ['Tool Explorer', 'Use any tool 3 times', 'use_tool', 3, 15, 10],
      ['Social Butterfly', 'Send a friend request', 'friend_request', 1, 20, 5],
      ['Reviewer', 'Write a review for a tool or business', 'review', 1, 10, 5],
      ['Referral Rookie', 'Refer a friend to join', 'referral', 1, 30, 15]
    ],
    check: 'SELECT 1 FROM daily_quests LIMIT 1'
  },
  // Achievements
  {
    table: 'achievements',
    columns: ['name', 'description', 'condition_type', 'condition_value', 'xp_reward', 'icon'],
    values: [
      ['First Tool', 'Use your first tool', 'tool_uses', 1, 10, '🚀'],
      ['Tool Master', 'Use 10 different tools', 'tool_uses', 10, 50, '🧙'],
      ['Social Star', 'Add 5 friends', 'friends', 5, 30, '👥'],
      ['Influencer', 'Refer 3 friends', 'referrals', 3, 40, '📣'],
      ['Contributor', 'Submit a tool that gets approved', 'tool_approved', 1, 25, '🛠️'],
      ['Critic', 'Write 10 reviews', 'reviews', 10, 30, '⭐'],
      ['Dedicated', 'Maintain a 7-day login streak', 'login_streak', 7, 50, '🔥']
    ],
    check: 'SELECT 1 FROM achievements LIMIT 1'
  },
  // Level rewards
  {
    table: 'level_rewards',
    columns: ['level', 'reward_type', 'reward_value'],
    values: [
      [2, 'credits', 10],
      [3, 'credits', 15],
      [5, 'credits', 25],
      [10, 'premium_days', 3],
      [15, 'credits', 50],
      [20, 'premium_days', 7],
      [25, 'custom_badge', 1],
      [30, 'credits', 100],
      [50, 'premium_days', 30]
    ],
    check: 'SELECT 1 FROM level_rewards LIMIT 1'
  }
];

// ================================================================
// 5. MAIN EXECUTION
// ================================================================

async function runMigration() {
  try {
    await client.connect();
    console.log('✅ Connected to database');

    // --- Create all new tables ---
    console.log('\n📦 Creating tables...');
    for (const table of NEW_TABLES) {
      await client.query(table.schema);
      console.log(`  ✅ ${table.name}`);
    }

    // --- Add missing columns to existing tables ---
    console.log('\n📝 Adding columns to existing tables...');
    for (const [table, columns] of Object.entries(EXISTING_TABLE_COLUMNS)) {
      for (const col of columns) {
        try {
          await client.query(`
            ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};
          `);
          console.log(`  ✅ ${table}.${col.name}`);
        } catch (err) {
          console.log(`  ⚠️ Could not add ${table}.${col.name}: ${err.message}`);
        }
      }
    }

    // --- Create indexes ---
    console.log('\n🔍 Creating indexes...');
    for (const idx of INDEXES) {
      for (const col of idx.columns) {
        try {
          // Only create index if the column exists
          const checkCol = await client.query(`
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = $1 AND column_name = $2
          `, [idx.table, col]);
          if (checkCol.rowCount === 0) {
            console.log(`  ⚠️ Skipping index on ${idx.table}(${col}) – column does not exist`);
            continue;
          }
          const indexName = `idx_${idx.table}_${col}`;
          await client.query(`
            CREATE INDEX IF NOT EXISTS ${indexName} ON ${idx.table} (${col});
          `);
          console.log(`  ✅ ${indexName}`);
        } catch (err) {
          console.log(`  ⚠️ Could not create index on ${idx.table}(${col}): ${err.message}`);
        }
      }
    }

    // --- Insert seed data if tables are empty ---
    console.log('\n🌱 Seeding default data...');
    for (const seed of SEED_DATA) {
      // Check if table already has rows
      const checkRes = await client.query(seed.check);
      if (checkRes.rowCount > 0) {
        console.log(`  ⏭️ ${seed.table} already has data – skipping`);
        continue;
      }
      // Build insert query with placeholders
      const placeholders = seed.values.map(row => {
        return `(${row.map((_, i) => `$${i + 1}`).join(', ')})`;
      }).join(', ');
      const flatValues = seed.values.flat();
      const query = `
        INSERT INTO ${seed.table} (${seed.columns.join(', ')})
        VALUES ${placeholders}
      `;
      await client.query(query, flatValues);
      console.log(`  ✅ ${seed.table} seeded with ${seed.values.length} rows`);
    }

    console.log('\n🎉 Migration complete! All new features are ready.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();