// migrations/003-profile-avatars.js
const { Client } = require('pg');

// Database URL from railway
const DATABASE_URL = 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway';

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrateProfileAvatars() {
  try {
    await client.connect();
    console.log('✅ Connected to database');
    console.log('📋 Setting up Profile Avatar System...\n');

    // ======================================================
    // 1. CHECK/CREATE USERS TABLE WITH AVATAR COLUMNS
    // ======================================================
    console.log('📋 Checking users table for avatar columns...');
    
    // Add avatar_url column if missing
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'avatar_url'
        ) THEN
          ALTER TABLE users ADD COLUMN avatar_url TEXT;
        END IF;
      END $$;
    `);
    
    // Add avatar_style column if missing
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'avatar_style'
        ) THEN
          ALTER TABLE users ADD COLUMN avatar_style VARCHAR(50) DEFAULT 'default';
        END IF;
      END $$;
    `);
    
    console.log('✅ Users table ready');

    // ======================================================
    // 2. CREATE USER_AVATARS TABLE (owned avatars)
    // ======================================================
    console.log('📋 Creating user_avatars table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_avatars (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        avatar_id VARCHAR(50) NOT NULL,
        unlocked_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT false,
        UNIQUE(user_id, avatar_id)
      );
    `);
    console.log('✅ user_avatars table created');

    // ======================================================
    // 3. CREATE AVATAR_UPLOADS TABLE (uploaded avatars)
    // ======================================================
    console.log('📋 Creating avatar_uploads table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS avatar_uploads (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        mime_type VARCHAR(100),
        is_active BOOLEAN DEFAULT false,
        uploaded_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ avatar_uploads table created');

    // ======================================================
    // 4. CREATE INDEXES FOR PERFORMANCE
    // ======================================================
    console.log('📋 Creating indexes...');
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_avatars_user_id ON user_avatars(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_avatars_is_active ON user_avatars(is_active);
      CREATE INDEX IF NOT EXISTS idx_avatar_uploads_user_id ON avatar_uploads(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_avatar_url ON users(avatar_url);
    `);
    console.log('✅ Indexes created');

    // ======================================================
    // 5. INSERT DEFAULT AVATARS (optional)
    // ======================================================
    console.log('📋 Inserting default gallery avatars...');
    
    // Check if we already have avatars in a gallery table
    const galleryExists = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'avatar_gallery'
      );
    `);
    
    // If no gallery table, we'll just use the user_avatars table directly
    console.log('ℹ️ Using simplified avatar system');

    // ======================================================
    // 6. SAMPLE AVATAR DATA FOR TESTING
    // ======================================================
    // Check if we already have data
    const countResult = await client.query('SELECT COUNT(*) FROM user_avatars');
    
    if (parseInt(countResult.rows[0].count) === 0) {
      console.log('📋 Inserting sample avatar data for existing users...');
      
      // Get all users
      const users = await client.query('SELECT id FROM users LIMIT 10');
      
      // Sample avatar IDs
      const sampleAvatars = [
        'm_iron1', 'm_iron2', 'm_iron3', 'm_brnz1', 'm_brnz2',
        'f_iron1', 'f_iron2', 'f_iron3', 'f_brnz1', 'f_brnz2'
      ];
      
      let inserted = 0;
      for (const user of users.rows) {
        // Assign 3 random avatars per user
        const shuffled = sampleAvatars.sort(() => 0.5 - Math.random());
        const selected = shuffled.slice(0, 3);
        
        for (const avatarId of selected) {
          try {
            await client.query(`
              INSERT INTO user_avatars (user_id, avatar_id, unlocked_at, is_active)
              VALUES ($1, $2, NOW(), $3)
              ON CONFLICT (user_id, avatar_id) DO NOTHING
            `, [user.id, avatarId, avatarId === 'm_iron1' || avatarId === 'f_iron1']);
            inserted++;
          } catch (err) {
            // Skip if conflict
          }
        }
      }
      console.log(`✅ Inserted ${inserted} sample avatar records`);
    } else {
      console.log(`ℹ️ Found ${countResult.rows[0].count} existing avatar records`);
    }

    // ======================================================
    // 7. CREATE AVATAR_IMAGES TABLE (for CDN/local storage)
    // ======================================================
    console.log('📋 Creating avatar_images table for storing image metadata...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS avatar_images (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        is_uploaded BOOLEAN DEFAULT true,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ avatar_images table created');

    // ======================================================
    // 8. VERIFY ALL TABLES
    // ======================================================
    console.log('\n📋 Verifying all avatar tables...');
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'user_avatars', 'avatar_uploads', 'avatar_images')
      ORDER BY table_name;
    `);
    
    console.log('✅ Avatar tables:');
    tables.rows.forEach(row => {
      console.log(`  📊 ${row.table_name}`);
    });

    console.log('\n🎉 Profile Avatar migration completed successfully!');
    console.log('📌 Tables created:');
    console.log('  - user_avatars     (unlocked gallery avatars)');
    console.log('  - avatar_uploads   (uploaded avatar files)');
    console.log('  - avatar_images    (image URLs/metadata)');
    console.log('📌 Users table updated with:');
    console.log('  - avatar_url       (current avatar URL)');
    console.log('  - avatar_style     (avatar style preference)');

  } catch (err) {
    console.error('❌ Error during migration:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run the migration
migrateProfileAvatars();