require('dotenv').config();
const { Client } = require('pg');
const bcrypt = require('bcrypt');

const DB_URL = process.env.PUBLIC_DB_URL || process.env.DATABASE_URL
  || 'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway';

(async () => {
  const client = new Client({
    connectionString: DB_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false }
  });
  await client.connect();

  const { rows } = await client.query(`
    SELECT id, username, email, role,
           is_banned, login_attempts, lock_until,
           CASE WHEN google_id IS NULL THEN 'null' ELSE 'SET' END AS google,
           CASE WHEN password IS NULL THEN 'NULL'
                WHEN LENGTH(password) < 20 THEN 'CORRUPT('||LENGTH(password)||')'
                ELSE 'OK('||LENGTH(password)||' chars)' END AS pw_status,
           password
    FROM users
    WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)
  `, ['Sarveik', 'ranjithkumar@sarveik.com']);

  console.log('\n═══ MATCHING USERS ═══');
  if (!rows.length) {
    console.log('❌ NO USER FOUND with username=Sarveik or email=ranjithkumar@sarveik.com');
    console.log('   → The create-admin.js script did NOT run successfully.');
    console.log('   → Run: node scripts/create-admin.js');
  } else {
    for (const u of rows) {
      console.log('\nID:', u.id);
      console.log('  username     :', u.username, `(exact case: "${u.username}" — login is case-SENSITIVE for username!)`);
      console.log('  email        :', u.email);
      console.log('  role         :', u.role, u.role === 'admin' ? '✅' : '❌ NOT ADMIN');
      console.log('  is_banned    :', u.is_banned, u.is_banned ? '❌ BANNED — login will 401' : '✅');
      console.log('  lock_until   :', u.lock_until, u.lock_until && new Date(u.lock_until) > new Date() ? '❌ LOCKED — login will 401' : '✅');
      console.log('  login_attempts:', u.login_attempts);
      console.log('  google_id    :', u.google, u.google === 'SET' ? '⚠  password login may be blocked' : '✅');
      console.log('  password     :', u.pw_status);

      // THE CRITICAL TEST — does the password actually match?
      if (u.password && u.password.length > 20) {
        for (const testPw of ['Ranjith@123', 'ranjith@123', 'Ranjith@123 ', 'Ranjith123', 'Ranjith@1234']) {
          try {
            const match = await bcrypt.compare(testPw, u.password);
            if (match) console.log(`  ✅ bcrypt.compare("${testPw}") → MATCH`);
          } catch (e) {
            console.log(`  ❌ bcrypt.compare("${testPw}") → THREW: ${e.message}`);
          }
        }
        const noMatch = !await bcrypt.compare('Ranjith@123', u.password);
        if (noMatch) console.log('  ⚠  "Ranjith@123" does NOT match this hash → password is different');
      }
    }
  }

  await client.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });