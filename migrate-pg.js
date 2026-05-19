// migrate-pg.js - PostgreSQL schema creation and default data
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const createTables = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255),
        google_id VARCHAR(255) UNIQUE,
        role VARCHAR(50) DEFAULT 'user',
        is_banned BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        display_name VARCHAR(100),
        bio TEXT,
        phone VARCHAR(20),
        avatar_url VARCHAR(255),
        github VARCHAR(100),
        twitter VARCHAR(100),
        linkedin VARCHAR(100),
        email_verified BOOLEAN DEFAULT TRUE,
        two_factor_enabled BOOLEAN DEFAULT FALSE,
        status VARCHAR(50) DEFAULT 'online',
        login_attempts INT DEFAULT 0,
        lock_until TIMESTAMP,
        referrer_id INT REFERENCES users(id) ON DELETE SET NULL,
        level INT DEFAULT 1,
        xp INT DEFAULT 0,
        total_xp_earned INT DEFAULT 0,
        premium_until TIMESTAMP,
        analytics_until TIMESTAMP,
        has_custom_badge BOOLEAN DEFAULT FALSE,
        selected_badge VARCHAR(50),
        featured_until TIMESTAMP,
        priority_support_until TIMESTAMP,
        message_boosts_remaining INT DEFAULT 0,
        avatar_style VARCHAR(50),
        last_activity TIMESTAMP DEFAULT NOW(),
        is_suspended BOOLEAN DEFAULT FALSE,
        suspended_until TIMESTAMP
      );
    `);

    // Friendships
    await client.query(`
      CREATE TABLE IF NOT EXISTS friendships (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days'
      );
    `);

    // Messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        is_boosted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Groups
    await client.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        created_by INT NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id INT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
        joined_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (group_id, user_id)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id SERIAL PRIMARY KEY,
        group_id INT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        sender_id INT NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Tools
    await client.query(`
      CREATE TABLE IF NOT EXISTS tools (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        url VARCHAR(500),
        category VARCHAR(100),
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        approved BOOLEAN DEFAULT FALSE,
        page_type VARCHAR(50) DEFAULT 'student',
        is_premium BOOLEAN DEFAULT FALSE,
        is_featured BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        submitted_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Tool usage
    await client.query(`
      CREATE TABLE IF NOT EXISTS tool_usage (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool_name VARCHAR(255) NOT NULL,
        tool_category VARCHAR(100),
        used_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Tool reviews
    await client.query(`
      CREATE TABLE IF NOT EXISTS tool_reviews (
        id SERIAL PRIMARY KEY,
        tool_id INT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating INT NOT NULL,
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Credits and transactions
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_credits (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        balance DECIMAL(10,2) DEFAULT 0,
        lifetime_earned DECIMAL(10,2) DEFAULT 0,
        lifetime_spent DECIMAL(10,2) DEFAULT 0,
        last_updated TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(10,2) NOT NULL,
        type VARCHAR(50) NOT NULL,
        description VARCHAR(255) NOT NULL,
        reference_id INT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_purchases (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credits INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        merchant_order_id VARCHAR(100) NOT NULL UNIQUE,
        pack_id VARCHAR(50),
        status VARCHAR(50) DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Support tickets
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'open',
        replies TEXT DEFAULT '[]',
        assigned_to INT REFERENCES users(id),
        ai_handled BOOLEAN DEFAULT FALSE,
        escalated_at TIMESTAMP,
        last_reminder_sent TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Gamification tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_quests (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(255) NOT NULL,
        target_action VARCHAR(50) NOT NULL,
        target_count INT NOT NULL,
        xp_reward INT NOT NULL,
        credits_reward INT NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_daily_quests (
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quest_id INT NOT NULL REFERENCES daily_quests(id) ON DELETE CASCADE,
        progress INT DEFAULT 0,
        completed BOOLEAN DEFAULT FALSE,
        claimed BOOLEAN DEFAULT FALSE,
        completed_at TIMESTAMP,
        date DATE DEFAULT CURRENT_DATE,
        PRIMARY KEY (user_id, quest_id, date)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_streak (
        user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        current_streak INT DEFAULT 0,
        longest_streak INT DEFAULT 0,
        last_login_date DATE,
        multiplier DECIMAL(3,2) DEFAULT 1.0,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS achievements (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(255) NOT NULL,
        icon VARCHAR(50) NOT NULL,
        condition_type VARCHAR(50) NOT NULL,
        condition_value INT NOT NULL,
        xp_reward INT NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        achievement_id INT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
        earned_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, achievement_id)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS level_rewards (
        level INT PRIMARY KEY,
        reward_type VARCHAR(50) NOT NULL,
        reward_value INT NOT NULL,
        description VARCHAR(255) NOT NULL
      );
    `);

    // Additional tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_events (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_name VARCHAR(100) NOT NULL,
        event_category VARCHAR(100),
        event_value VARCHAR(500),
        metadata TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS category_reviews (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category VARCHAR(100) NOT NULL,
        rating INT CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description VARCHAR(500),
        icon VARCHAR(50) NOT NULL,
        link VARCHAR(500) NOT NULL,
        category VARCHAR(50) NOT NULL,
        display_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        created_by INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_notifications (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        is_read BOOLEAN DEFAULT FALSE
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_read (
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, friend_id)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        used BOOLEAN DEFAULT FALSE
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS otp_store (
        email VARCHAR(255) PRIMARY KEY,
        otp VARCHAR(10) NOT NULL,
        expires_at TIMESTAMP NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_feedback (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS moderator_activity (
        id SERIAL PRIMARY KEY,
        moderator_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        moderator_name VARCHAR(100) NOT NULL,
        action VARCHAR(200) NOT NULL,
        target VARCHAR(200),
        details TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_notes (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notes TEXT NOT NULL,
        updated_by INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS premium_purchases (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        feature VARCHAR(50) NOT NULL,
        duration_days INT NOT NULL,
        merchant_order_id VARCHAR(100) NOT NULL UNIQUE,
        status VARCHAR(50) DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Insert default data if tables are empty
    const questCount = await client.query('SELECT COUNT(*) FROM daily_quests');
    if (parseInt(questCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO daily_quests (name, description, target_action, target_count, xp_reward, credits_reward) VALUES
        ('Tool Enthusiast', 'Use 5 different tools', 'use_tool', 5, 50, 10),
        ('Daily Check-in', 'Login to Nova Platform', 'login', 1, 20, 5),
        ('Social Butterfly', 'Send 3 friend requests', 'friend_request', 3, 40, 5),
        ('Reviewer', 'Write 2 tool reviews', 'review', 2, 60, 15),
        ('Referral Master', 'Refer 1 new user', 'referral', 1, 80, 20);
      `);
    }

    const achCount = await client.query('SELECT COUNT(*) FROM achievements');
    if (parseInt(achCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO achievements (name, description, icon, condition_type, condition_value, xp_reward) VALUES
        ('Tool Explorer', 'Use 5 different tools', 'fa-compass', 'tool_uses', 5, 50),
        ('Tool Master', 'Use 25 different tools', 'fa-crown', 'tool_uses', 25, 150),
        ('Social Butterfly', 'Add 5 friends', 'fa-users', 'friends', 5, 75),
        ('Super Connector', 'Add 15 friends', 'fa-user-friends', 'friends', 15, 200),
        ('Contributor', 'Submit a tool that gets approved', 'fa-upload', 'tool_approved', 1, 100),
        ('Reviewer', 'Write 3 tool reviews', 'fa-star', 'reviews', 3, 60),
        ('Referral Hero', 'Refer 3 friends who sign up', 'fa-user-plus', 'referrals', 3, 120);
      `);
    }

    const rewardCount = await client.query('SELECT COUNT(*) FROM level_rewards');
    if (parseInt(rewardCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO level_rewards (level, reward_type, reward_value, description) VALUES
        (2, 'credits', 10, '10 credits'),
        (3, 'credits', 15, '15 credits'),
        (4, 'credits', 20, '20 credits'),
        (5, 'credits', 25, '25 credits'),
        (10, 'premium_days', 7, '7 days Premium Access'),
        (15, 'credits', 100, '100 credits'),
        (20, 'premium_days', 14, '14 days Premium Access'),
        (25, 'badge', 1, '25 Level Master badge'),
        (30, 'premium_days', 30, '30 days Premium Access'),
        (40, 'custom_badge', 1, 'Custom Badge'),
        (50, 'premium_days', 60, '60 days Premium Access'),
        (75, 'premium_days', 90, '90 days Premium Access'),
        (100, 'premium_days', 365, '365 days Premium Access');
      `);
    }

    await client.query('COMMIT');
    console.log('✅ All tables created and default data inserted');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration error:', err);
  } finally {
    client.release();
    await pool.end();
  }
};

createTables();