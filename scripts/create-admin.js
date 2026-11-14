/**
 * scripts/create-admin.js
 *
 * Creates or force-updates an admin account.
 * Safe to re-run — it uses UPSERT semantics and idempotent side-effects.
 *
 * Usage:
 *   node scripts/create-admin.js
 *   node scripts/create-admin.js --force     # skip password strength check
 *
 * Recommended: run `node server.js` once first, so all tables/columns exist
 * (setupGamificationTables, ensureStaffLoungeGroup, etc.).
 */
require('dotenv').config();
const { Client } = require('pg');
const bcrypt = require('bcrypt');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — override via env vars or edit the defaults here
// ─────────────────────────────────────────────────────────────────────────────
const DB_URL =
  process.env.PUBLIC_DB_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:NeRZkqHSPZdXMOlXRrDcjqQSUYuXNXtG@yamabiko.proxy.rlwy.net:37851/railway';

const ADMIN = {
  username: process.env.ADMIN_USERNAME || 'Sarveik',
  email:    process.env.ADMIN_EMAIL    || 'ranjithkumar@sarveik.com',
  password: process.env.ADMIN_PASSWORD || 'Ranjith@123',
};

const WELCOME_BONUS = 600;
const FORCE = process.argv.includes('--force');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function log(msg)  { console.log(msg); }
function ok(msg)   { console.log('✓', msg); }
function warn(msg) { console.warn('⚠', msg); }
function err(msg)  { console.error('❌', msg); }

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('\n═══════════════════════════════════════════════════════');
  log('  Sarveik — Admin provisioning');
  log('═══════════════════════════════════════════════════════\n');

  // 1. Password strength (matches server's zxcvbn score >= 3 rule)
  if (!FORCE) {
    try {
      const zxcvbn = require('zxcvbn');
      const score = zxcvbn(ADMIN.password).score;
      const label = ['Very Weak', 'Weak', 'Medium', 'Strong', 'Very Strong'][score];
      if (score < 3) {
        err(`Password too weak (zxcvbn score=${score}/4 = "${label}"). The server would REJECT this password on login.`);
        warn('Options:');
        warn('  1. Change ADMIN.password to something stronger (min 12 chars, mix of cases/digits/symbols).');
        warn('  2. Re-run with --force if you understand the risk.');
        process.exit(1);
      }
      ok(`Password strength OK (zxcvbn score=${score}/4 = "${label}")`);
    } catch (e) {
      warn('zxcvbn not installed — skipping strength check');
    }
  } else {
    warn('--force set — skipping password strength check');
  }

  // 2. Connect
  const isLocal = /localhost|127\.0\.0\.1/.test(DB_URL);
  const client = new Client({
    connectionString: DB_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    ok('Connected to database');

    // 3. Check for username/email collisions with a DIFFERENT row
    //    (prevents accidentally hijacking someone else's account)
    const conflict = await client.query(
      `SELECT id, username, email, role
       FROM users
       WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2))
         AND NOT (username = $1 AND email = $2)`,
      [ADMIN.username, ADMIN.email]
    );
    if (conflict.rows.length > 0) {
      warn('Collision detected — another account already owns this username or email:');
      conflict.rows.forEach(r => console.warn('   ', r));
      warn('Aborting to avoid account hijack. If this is expected:');
      warn('  • Rename/delete the conflicting user, OR');
      warn('  • Change ADMIN.username / ADMIN.email in this script.');
      process.exit(2);
    }

    // 4. Hash the password
    const hash = await bcrypt.hash(ADMIN.password, 10);
    ok('Password hashed (bcrypt cost 10)');

    // 5. Upsert admin — reset lockout/ban flags so login can't be blocked by stale state
    const upsert = await client.query(
      `INSERT INTO users
         (username, email, password, role,
          is_banned, login_attempts, lock_until,
          created_at, updated_at)
       VALUES
         ($1, $2, $3, 'admin',
          false, 0, NULL,
          NOW(), NOW())
       ON CONFLICT (username) DO UPDATE SET
         email          = EXCLUDED.email,
         password       = EXCLUDED.password,
         role           = 'admin',
         is_banned      = false,
         login_attempts = 0,
         lock_until     = NULL,
         updated_at     = NOW()
       RETURNING id, username, email, role, is_banned`,
      [ADMIN.username, ADMIN.email, hash]
    );
    const admin = upsert.rows[0];
    ok(`Admin upserted → id=${admin.id}, username=${admin.username}, role=${admin.role}`);

    // 6. Ensure welcome credits exist (mirrors server's initializeUserCredits)
    const creditsInsert = await client.query(
      `INSERT INTO user_credits (user_id, balance, lifetime_earned)
       VALUES ($1, $2, $2)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id`,
      [admin.id, WELCOME_BONUS]
    );
    if (creditsInsert.rowCount > 0) {
      await client.query(
        `INSERT INTO credit_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'bonus', 'Welcome bonus for joining Sraveik')`,
        [admin.id, WELCOME_BONUS]
      );
      ok(`Welcome bonus granted (${WELCOME_BONUS} credits)`);
    } else {
      ok('Credits row already exists — skipped');
    }

    // 7. Ensure gamification fields are sane (columns added by setupGamificationTables)
    try {
      await client.query(
        `UPDATE users SET
           level           = COALESCE(level, 1),
           xp              = COALESCE(xp, 0),
           total_xp_earned = COALESCE(total_xp_earned, 0)
         WHERE id = $1`,
        [admin.id]
      );
      ok('Gamification fields initialised');
    } catch (e) {
      if (e.code === '42703') warn('Gamification columns not present yet — run the server once to create them.');
      else throw e;
    }

    // 8. Add to Staff Lounge if it exists
    try {
      const lounge = await client.query(`SELECT id FROM groups WHERE name = 'Staff Lounge' LIMIT 1`);
      if (lounge.rows.length > 0) {
        await client.query(
          `INSERT INTO group_members (group_id, user_id)
           SELECT $1, $2
           WHERE NOT EXISTS (
             SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2
           )`,
          [lounge.rows[0].id, admin.id]
        );
        ok('Added to Staff Lounge');
      } else {
        warn('Staff Lounge group not created yet — run the server once.');
      }
    } catch (e) {
      if (e.code === '42P01') warn('groups / group_members tables not present yet — run the server once.');
      else throw e;
    }

    // 9. Final summary
    log('\n═══════════════════════════════════════════════════════');
    log('  ✅ ADMIN READY');
    log('═══════════════════════════════════════════════════════');
    log(`  User ID  : ${admin.id}`);
    log(`  Username : ${ADMIN.username}`);
    log(`  Email    : ${ADMIN.email}`);
    log(`  Password : ${ADMIN.password}`);
    log(`  Role     : admin`);
    log(`  Banned   : ${admin.is_banned}`);
    log('═══════════════════════════════════════════════════════');
    log('  ⚠  Change this password immediately after first login.');
    log('  ⚠  Never commit this script with a real DB password.');
    log('═══════════════════════════════════════════════════════\n');

  } catch (error) {
    err(`Fatal: ${error.message}`);
    if (error.code === '28P01') err('   Bad DB password in the connection string.');
    if (error.code === '3D000') err('   Database does not exist — check the URL path.');
    if (error.code === '42P01') err('   Missing table — run `node server.js` once to create schemas.');
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED')
      err('   DB host unreachable — is the Railway service running?');
    if (error.code === '42703') err('   Missing column — run `node server.js` once to create it.');
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();