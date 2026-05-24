require('dotenv').config();
const { pool } = require('./database');
const bcrypt = require('bcrypt');

async function addAdmin() {
    const username = 'Sarveik';
    const email = 'ranjithkumar@sarveik.com';
    const plainPassword = 'Ranjith@123';
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    try {
        const result = await pool.query(
            `INSERT INTO users (username, email, password, role, created_at, updated_at)
             VALUES ($1, $2, $3, 'admin', NOW(), NOW())
             ON CONFLICT (username) DO UPDATE SET
                email = EXCLUDED.email,
                password = EXCLUDED.password,
                role = 'admin',
                updated_at = NOW()
             RETURNING id, username, role`,
            [username, email, hashedPassword]
        );
        console.log('Admin user added/updated:', result.rows[0]);
    } catch (err) {
        console.error('Error adding admin:', err);
    } finally {
        pool.end();
    }
}

addAdmin();