-- ==================== BUSINESSES TABLE ====================
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

CREATE INDEX IF NOT EXISTS idx_businesses_approved ON businesses(approved);
CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category);

-- ==================== SUPPORT TICKETS – ADD MISSING COLUMNS ====================
-- Add priority column if not exists
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';
-- Add category column
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general';
-- Add assigned_to column (references users.id)
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- Add escalated_at column
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP;
-- Add resolved_at column
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
-- Add internal_notes column (JSONB)
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS internal_notes JSONB;
-- Add last_reminder_sent column
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMP;
-- Ensure status column has correct default
ALTER TABLE support_tickets ALTER COLUMN status SET DEFAULT 'open';
-- Add index on priority for performance
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority);

-- ==================== MODERATOR STATUS TABLE (if missing) ====================
CREATE TABLE IF NOT EXISTS moderator_status (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_tickets INTEGER DEFAULT 0,
    is_online BOOLEAN DEFAULT true,
    last_active TIMESTAMP DEFAULT NOW()
);