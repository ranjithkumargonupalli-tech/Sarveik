require('dotenv').config();
const { pool } = require('./database');

async function addBusiness() {
    const businessData = {
        name: 'Sarveik Tech Hub',
        type: 'tech',
        category: 'technology',
        description: 'A premium co-working and tech incubation space for developers and startups. Offers high-speed internet, meeting rooms, and 24/7 access.',
        address: 'No. 42, Gandhi Road, T. Nagar',
        city: 'Chennai',
        state: 'Tamil Nadu',
        phone: '+91 9876543210',
        email: 'contact@sarveiktech.com',
        website: 'https://sarveiktech.com',
        whatsapp: '+91 9876543210',
        maps: 'https://maps.google.com/?q=Sarveik+Tech+Hub',
        instagram: 'https://instagram.com/sarveiktech',
        facebook: 'https://facebook.com/sarveiktech',
        hours: { Mon: '9:00-21:00', Tue: '9:00-21:00', Wed: '9:00-21:00', Thu: '9:00-21:00', Fri: '9:00-21:00', Sat: '10:00-18:00', Sun: 'Closed' },
        amenities: ['wifi', 'parking', 'ac', 'card', 'upi', 'accessible'],
        images: [],
        approved: true,      // Already approved
        verified: true,
        featured: true,
        user_id: null        // or put a valid user ID if you want to associate with an existing user
    };

    try {
        const result = await pool.query(
            `INSERT INTO businesses (
                name, type, category, description, address, city, state,
                phone, email, website, whatsapp, maps, instagram, facebook,
                hours, amenities, images, approved, verified, featured, user_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW(), NOW())
            RETURNING id`,
            [
                businessData.name,
                businessData.type,
                businessData.category,
                businessData.description,
                businessData.address,
                businessData.city,
                businessData.state,
                businessData.phone,
                businessData.email,
                businessData.website,
                businessData.whatsapp,
                businessData.maps,
                businessData.instagram,
                businessData.facebook,
                JSON.stringify(businessData.hours),
                JSON.stringify(businessData.amenities),
                JSON.stringify(businessData.images),
                businessData.approved,
                businessData.verified,
                businessData.featured,
                businessData.user_id
            ]
        );
        console.log('✅ Business added successfully. ID:', result.rows[0].id);
    } catch (err) {
        console.error('❌ Error adding business:', err);
    } finally {
        pool.end();
    }
}

addBusiness();