-- Create businesses table
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

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_businesses_approved ON businesses(approved);
CREATE INDEX IF NOT EXISTS idx_businesses_city ON businesses(city);
CREATE INDEX IF NOT EXISTS idx_businesses_category ON businesses(category);