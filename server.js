require('dotenv').config();


// ==================== ENVIRONMENT CHECKS ====================
// FIXED: session secret length check operator precedence
if (process.env.NODE_ENV === 'production' && (process.env.SESSION_SECRET?.length || 0) < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
}

console.log('Google Client ID:', process.env.GOOGLE_CLIENT_ID);
console.log('Google Callback URL:', process.env.GOOGLE_CALLBACK_URL);

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const sharedsession = require('express-socket.io-session');
const { pool } = require('./database');
// Auto-migration: create tables if they don't exist (first deploy only)
(async () => {
    try {
        await pool.query('SELECT 1 FROM users LIMIT 1');
        console.log('✅ Database tables already exist');
    } catch (err) {
        console.log('⚠️ Tables missing, running migration...');
        try {
            require('./migrate-pg.js');
            console.log('✅ Migration completed');
        } catch (migrateErr) {
            console.error('❌ Migration failed:', migrateErr.message);
        }
    }
})();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const zxcvbn = require('zxcvbn');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { fileTypeFromBuffer } = require('file-type');

// PhonePe SDK
const { StandardCheckoutClient, Env, StandardCheckoutPayRequest } = require('@phonepe-pg/pg-sdk-node');
const crypto = require('crypto');

const { 
    sendWelcomeEmail, 
    sendPasswordChangeNotification, 
    sendAdminAlert, 
    sendOtpEmail,
    sendPasswordResetOtp,
    sendFriendRequestEmail,
    sendWeeklyDigest,
    sendAccountDeletionAlert 
} = require('./utils/emailService');

// ==================== EMAIL CONFIGURATION (Fallback) ====================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendEmail(to, subject, html) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER || 'noreply@novaplatform.com',
            to,
            subject,
            html
        });
        return { success: true };
    } catch (error) {
        console.error('Email error:', error);
        return { success: false, error: error.message };
    }
}

// ---------- EMAIL FUNCTIONS FOR TOOL APPROVAL ----------
async function sendToolApprovalEmail(to, username, toolName) {
    const subject = 'Your submitted tool has been approved!';
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 10px;">
            <div style="background: white; padding: 30px; border-radius: 10px;">
                <h2 style="color: #667eea;">Great News, ${username}! 🎉</h2>
                <p>Your submitted tool "<strong>${toolName}</strong>" has been <strong style="color: #10b981;">APPROVED</strong> by our admin team!</p>
                <div style="background: #f0fdf4; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 0; color: #166534;">✨ You have earned <strong style="font-size: 20px;">25 CREDITS</strong> for this submission!</p>
                </div>
                <p>Your tool is now live on Sraveik and available for all users.</p>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/main.html" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; margin-top: 20px;">View All Tools</a>
                <p style="margin-top: 20px; font-size: 12px; color: #666;">Thank you for contributing to our community!</p>
            </div>
        </div>
    `;
    console.log(`📧 [DEV] Approval email would be sent to ${to}: ${subject}`);
    return sendEmail(to, subject, html);
}

async function sendToolRejectionEmail(to, username, toolName, reason = null) {
    const subject = 'Your tool submission was not approved';
    const reasonText = reason ? `<p><strong>Reason:</strong> ${reason}</p>` : '<p>Please review our guidelines and try submitting again.</p>';
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 10px;">
            <div style="background: white; padding: 30px; border-radius: 10px;">
                <h2 style="color: #ef4444;">Hello ${username}</h2>
                <p>Thank you for submitting "<strong>${toolName}</strong>" to Sraveik.</p>
                <div style="background: #fef2f2; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 0; color: #991b1b;">After careful review, our admin team has decided <strong>not to approve</strong> this tool at this time.</p>
                    ${reasonText}
                </div>
                <p>You can submit a new tool with corrections anytime.</p>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/submit-tool.html" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; margin-top: 20px;">Submit Another Tool</a>
                <p style="margin-top: 20px; font-size: 12px; color: #666;">We appreciate your contribution to Sraveik!</p>
            </div>
        </div>
    `;
    console.log(`📧 [DEV] Rejection email would be sent to ${to}: ${subject}`);
    return sendEmail(to, subject, html);
}

// ==================== ENHANCED ADMIN ALERT ====================
async function sendToolSubmissionAlert(details) {
    try {
        await poolConnect;
        const admins = await pool.request().query("SELECT email, username FROM users WHERE role = 'admin'");
        for (let admin of admins.recordset) {
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f4f4f4; border-radius: 10px;">
                    <h2 style="color: #667eea;">New Tool Submission</h2>
                    <p><strong>Submitted by:</strong> ${details.username} (${details.userEmail})</p>
                    <hr>
                    <h3>Tool Details:</h3>
                    <ul>
                        <li><strong>Name:</strong> ${details.toolName}</li>
                        <li><strong>URL:</strong> <a href="${details.toolUrl}">${details.toolUrl}</a></li>
                        <li><strong>Description:</strong> ${details.toolDescription || 'No description'}</li>
                        <li><strong>Category:</strong> ${details.toolCategory}</li>
                        <li><strong>Page Type:</strong> ${details.pageType || 'student'}</li>
                    </ul>
                    <p>Please review and approve/reject from the admin panel.</p>
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/admin-dashboard.html" style="display: inline-block; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 5px;">Go to Admin Panel</a>
                </div>
            `;
            await sendEmail(admin.email, `New Tool Submission: ${details.toolName}`, html);
        }
        console.log(`📧 Admin alerts sent for tool "${details.toolName}"`);
    } catch (err) {
        console.error('Error sending admin alerts:', err);
    }
}

const app = express();
app.set('trust proxy', 1);
app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ==================== SECURITY MIDDLEWARE ====================
// HTTPS enforcement (production)
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(`https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

// CORS - restrict to allowed origins
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'];
app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

// Request size limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// PhonePe webhook needs raw body (must be placed BEFORE JSON parser for this route)
app.use('/api/phonepe-webhook', express.raw({ type: 'application/json' }));
app.use(express.static('public'));

// Session configuration with secure cookie
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
});
app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// ==================== XSS HELPER ====================
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[m]));
}
function validateIntParam(value, paramName) {
    const num = Number(value);
    if (isNaN(num) || !Number.isInteger(num) || num < -2147483648 || num > 2147483647) {
        throw new Error(`Invalid ${paramName}: must be a 32‑bit integer`);
    }
    return num;
}

// ==================== OTP STORAGE (DATABASE) ====================
// Table creation (ensure it exists)


// Clean expired OTPs every 10 minutes
setInterval(async () => {
    try {
        await pool.query('DELETE FROM otp_store WHERE expires_at < NOW()');
        await pool.query('DELETE FROM password_resets WHERE expires_at < NOW()');
    } catch (err) { console.error('OTP cleanup error:', err); }
}, 10 * 60 * 1000);

// ==================== RATE LIMITING ====================
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.'
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    skipSuccessfulRequests: true,
    message: 'Too many attempts, please try again later.'
});
// FIXED: ipKeyGenerator no longer needed - use req.ip directly
const otpVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => {
        // If the request contains an email, use that as the key
        if (req.body.email) return req.body.email;
        // Otherwise, use the official ipKeyGenerator helper (handles IPv6 safely)
        return ipKeyGenerator(req.ip);
    },
    message: 'Too many OTP verification attempts, please try again later.'
});

// ==================== DATABASE INITIALIZATION (ADD BADGE COLUMNS) ====================

// ==================== STAFF LOUNGE (ADMIN/MODERATOR GROUP) ====================
async function ensureStaffLoungeGroup() {
    try {
        // Insert group if not exists
        await pool.query(`
            INSERT INTO groups (name, created_by)
            SELECT 'Staff Lounge', 1
            WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = 'Staff Lounge')
        `);
        // Get the group id
        const groupRes = await pool.query(`SELECT id FROM groups WHERE name = 'Staff Lounge'`);
        if (groupRes.rows.length === 0) return;
        const groupId = groupRes.rows[0].id;
        // Get all staff users
        const staffRes = await pool.query(`SELECT id FROM users WHERE role IN ('admin', 'moderator')`);
        for (const user of staffRes.rows) {
            await pool.query(`
                INSERT INTO group_members (group_id, user_id)
                SELECT $1, $2
                WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2)
            `, [groupId, user.id]);
        }
        console.log(`✅ Staff Lounge group ready (ID: ${groupId}) with ${staffRes.rows.length} members`);
    } catch (err) {
        console.error('Error ensuring Staff Lounge group:', err);
    }
}


// ==================== GAMIFICATION HELPER FUNCTIONS ====================

/**
 * XP required to reach a given level (exponential curve)
 */
// ==================== GAMIFICATION HELPER FUNCTIONS ====================

/**
 * XP required to reach a given level (exponential curve) - with memoization for performance
 */
const xpCache = new Map();
function xpForLevel(level) {
    if (level <= 1) return 0;
    if (xpCache.has(level)) return xpCache.get(level);
    let total = 0;
    for (let l = 2; l <= level; l++) {
        total += Math.floor(100 * Math.pow(1.08, l - 2));
    }
    xpCache.set(level, total);
    return total;
}

/**
 * Add XP to a user, trigger level‑up, and log transaction
 */
async function addXP(userId, amount, source) {
    await pool.request()
        .input('userId', sql.Int, userId)
        .input('amount', sql.Int, amount)
        .query('UPDATE users SET xp = xp + @amount, total_xp_earned = total_xp_earned + @amount WHERE id = @userId');
    await checkLevelUp(userId);
    await pool.request()
        .input('userId', sql.Int, userId)
        .input('amount', sql.Int, amount)
        .input('source', sql.NVarChar, source)
        .query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (@userId, @amount, \'xp\', @source)');
}

/**
 * Check if user reached a new level and grant rewards
 */
async function checkLevelUp(userId) {
    const user = await pool.request()
        .input('userId', sql.Int, userId)
        .query('SELECT level, xp FROM users WHERE id = @userId');
    if (!user.recordset[0]) return;
    let { level, xp } = user.recordset[0];
    let newLevel = level;
    while (xp >= xpForLevel(newLevel + 1)) {
        newLevel++;
    }
    if (newLevel > level) {
        await pool.request()
            .input('userId', sql.Int, userId)
            .input('newLevel', sql.Int, newLevel)
            .query('UPDATE users SET level = @newLevel WHERE id = @userId');
        await grantLevelRewards(userId, level, newLevel);
        const socketInfo = onlineUsers.get(userId);
        if (socketInfo && socketInfo.socketId) io.to(socketInfo.socketId).emit('level_up', { oldLevel: level, newLevel });
        console.log(`User ${userId} leveled up from ${level} to ${newLevel}`);
    }
}

/**
 * Grant rewards for each passed level (credits, premium days, badges)
 */
async function grantLevelRewards(userId, oldLevel, newLevel) {
    const rewards = await pool.request()
        .input('minLevel', sql.Int, oldLevel + 1)
        .input('maxLevel', sql.Int, newLevel)
        .query('SELECT * FROM level_rewards WHERE level BETWEEN @minLevel AND @maxLevel');
    for (const reward of rewards.recordset) {
        if (reward.reward_type === 'credits') {
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('amount', sql.Decimal(10,2), reward.reward_value)
                .query('UPDATE user_credits SET balance = balance + @amount WHERE user_id = @userId');
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('amount', sql.Decimal(10,2), reward.reward_value)
                .input('desc', sql.NVarChar, `Level ${reward.level} reward: ${reward.reward_value} credits`)
                .query('INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (@userId, @amount, \'bonus\', @desc)');
        } else if (reward.reward_type === 'premium_days') {
            const user = await pool.request()
                .input('userId', sql.Int, userId)
                .query('SELECT premium_until FROM users WHERE id = @userId');
            let current = user.recordset[0].premium_until;
            let newExpiry;
            if (current && new Date(current) > new Date()) {
                newExpiry = new Date(new Date(current).getTime() + reward.reward_value * 24 * 60 * 60 * 1000);
            } else {
                newExpiry = new Date(Date.now() + reward.reward_value * 24 * 60 * 60 * 1000);
            }
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('expiry', sql.DateTime, newExpiry)
                .query('UPDATE users SET premium_until = @expiry WHERE id = @userId');
        } else if (reward.reward_type === 'badge') {
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('achievementId', sql.Int, reward.reward_value)
                .query('INSERT INTO user_achievements (user_id, achievement_id) VALUES (@userId, @achievementId)');
        } else if (reward.reward_type === 'custom_badge') {
            await pool.request()
                .input('userId', sql.Int, userId)
                .query('UPDATE users SET has_custom_badge = true WHERE id = @userId');
        }
    }
}

/**
 * Update daily login streak and return multiplier
 */
async function updateStreak(userId, loginDate = new Date()) {
    const dateStr = loginDate.toISOString().slice(0,10);
    const streak = await pool.request()
        .input('userId', sql.Int, userId)
        .query('SELECT current_streak, last_login_date FROM user_streak WHERE user_id = @userId');
    if (streak.recordset.length === 0) {
        await pool.request()
            .input('userId', sql.Int, userId)
            .input('date', sql.Date, dateStr)
            .query('INSERT INTO user_streak (user_id, current_streak, longest_streak, last_login_date, multiplier) VALUES (@userId, 1, 1, @date, 1.0)');
        return 1;
    }
    const lastDate = streak.recordset[0].last_login_date ? new Date(streak.recordset[0].last_login_date) : null;
    let current = streak.recordset[0].current_streak;
    let longest = streak.recordset[0].longest_streak;
    let multiplier = 1.0;
    if (lastDate) {
        const diffDays = Math.floor((loginDate - lastDate) / (1000*60*60*24));
        if (diffDays === 1) {
            current++;
            multiplier = Math.min(2.0, 1 + (current-1)*0.05);
        } else if (diffDays > 1) {
            current = 1;
            multiplier = 1.0;
        }
    } else {
        current = 1;
        multiplier = 1.0;
    }
    if (current > longest) longest = current;
    await pool.request()
        .input('userId', sql.Int, userId)
        .input('streak', sql.Int, current)
        .input('longest', sql.Int, longest)
        .input('date', sql.Date, dateStr)
        .input('multiplier', sql.Decimal(3,2), multiplier)
        .query('UPDATE user_streak SET current_streak = @streak, longest_streak = @longest, last_login_date = @date, multiplier = @multiplier WHERE user_id = @userId');
    return multiplier;
}

/**
 * Get or initialise daily quests for a user (creates missing rows)
 */
async function getDailyQuests(userId) {
    const today = new Date().toISOString().slice(0,10);
    const quests = await pool.request()
        .input('userId', sql.Int, userId)
        .input('today', sql.Date, today)
        .query(`
            SELECT q.*, uqd.progress, uqd.completed, uqd.claimed
            FROM daily_quests q
            LEFT JOIN user_daily_quests uqd ON q.id = uqd.quest_id AND uqd.user_id = @userId AND uqd.date = @today
        `);
    for (const q of quests.recordset) {
        if (q.progress === undefined) {
            await pool.request()
                .input('userId', sql.Int, userId)
                .input('questId', sql.Int, q.id)
                .input('date', sql.Date, today)
                .query('INSERT INTO user_daily_quests (user_id, quest_id, date, progress, completed, claimed) VALUES (@userId, @questId, @date, 0, 0, 0)');
            q.progress = 0;
            q.completed = 0;
            q.claimed = 0;
        }
    }
    return quests.recordset;
}

/**
 * Update quest progress for a specific action (login, use_tool, etc.)
 */
async function updateQuestProgress(userId, action, increment = 1) {
    const today = new Date().toISOString().slice(0,10);
    try {
        // First, ensure a row exists for today (INSERT if not exists)
        await pool.query(`
            INSERT INTO user_daily_quests (user_id, quest_id, date, progress, completed, claimed)
            SELECT $1, q.id, $2, 0, false, false
            FROM daily_quests q
            WHERE q.target_action = $3
            ON CONFLICT (user_id, quest_id, date) DO NOTHING
        `, [userId, today, action]);

        // Then update progress for that quest (if not completed)
        const updateRes = await pool.query(`
            UPDATE user_daily_quests
            SET progress = progress + $1
            WHERE user_id = $2
              AND quest_id IN (SELECT id FROM daily_quests WHERE target_action = $3)
              AND date = $4
              AND completed = false
        `, [increment, userId, action, today]);
        console.log(`[Quest] Updated ${updateRes.rowCount} quest(s)`);

        // Mark as completed if target reached
        const completedRes = await pool.query(`
            UPDATE user_daily_quests
            SET completed = true
            WHERE user_id = $1
              AND quest_id IN (SELECT id FROM daily_quests WHERE target_action = $2)
              AND date = $3
              AND completed = false
              AND progress >= (SELECT target_count FROM daily_quests WHERE id = quest_id)
        `, [userId, action, today]);
        if (completedRes.rowCount > 0) {
            console.log(`[Quest] Marked ${completedRes.rowCount} quest(s) as completed`);
            const socketInfo = onlineUsers.get(userId);
            if (socketInfo && socketInfo.socketId) 
                io.to(socketInfo.socketId).emit('quest_ready', { action });
        }
    } catch (err) {
        console.error('updateQuestProgress error:', err);
    }
}

/**
 * Check and unlock achievements based on user's data (retrospective)
 */
async function checkAchievements(userId) {
    const achievements = await pool.query(`
        SELECT a.* FROM achievements a
        WHERE NOT EXISTS (
            SELECT 1 FROM user_achievements ua
            WHERE ua.user_id = $1 AND ua.achievement_id = a.id
        )
    `, [userId]);
    
    for (const ach of achievements.rows) {
        let achieved = false;
        switch (ach.condition_type) {
            case 'tool_uses': {
                const toolRes = await pool.query(
                    'SELECT COUNT(DISTINCT tool_name) as cnt FROM tool_usage WHERE user_id = $1',
                    [userId]
                );
                achieved = toolRes.rows[0].cnt >= ach.condition_value;
                break;
            }
            case 'friends': {
                const friendRes = await pool.query(
                    `SELECT COUNT(*) as cnt FROM friendships 
                     WHERE (user_id = $1 OR friend_id = $1) AND status = 'accepted'`,
                    [userId]
                );
                achieved = friendRes.rows[0].cnt >= ach.condition_value;
                break;
            }
            case 'referrals': {
                const refRes = await pool.query(
                    'SELECT COUNT(*) as cnt FROM users WHERE referrer_id = $1',
                    [userId]
                );
                achieved = refRes.rows[0].cnt >= ach.condition_value;
                break;
            }
            case 'tool_approved': {
                const appRes = await pool.query(
                    'SELECT COUNT(*) as cnt FROM tools WHERE user_id = $1 AND approved = true',
                    [userId]
                );
                achieved = appRes.rows[0].cnt >= ach.condition_value;
                break;
            }
            case 'reviews': {
                const revRes = await pool.query(
                    'SELECT COUNT(*) as cnt FROM user_feedback WHERE user_id = $1',
                    [userId]
                );
                achieved = revRes.rows[0].cnt >= ach.condition_value;
                break;
            }
            case 'login_streak': {
                const streakRes = await pool.query(
                    'SELECT current_streak FROM user_streak WHERE user_id = $1',
                    [userId]
                );
                achieved = (streakRes.rows[0]?.current_streak || 0) >= ach.condition_value;
                break;
            }
        }
        if (achieved) {
            await pool.query(
                'INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2)',
                [userId, ach.id]
            );
            await addXP(userId, ach.xp_reward, `Achievement: ${ach.name}`);
            const socketInfo = onlineUsers.get(userId);
            if (socketInfo && socketInfo.socketId) {
                io.to(socketInfo.socketId).emit('achievement_unlocked', {
                    name: ach.name,
                    icon: ach.icon,
                    xp: ach.xp_reward
                });
            }
            console.log(`User ${userId} unlocked achievement: ${ach.name}`);
        }
    }
}
// ==================== PASSPORT SERIALIZATION ====================
passport.serializeUser((user, done) => {
    if (!user || !user.id) return done(new Error('User object missing id'));
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query('SELECT id, username, email, role FROM users WHERE id = @id');
        done(null, result.recordset[0]);
    } catch (err) {
        done(err);
    }
});

// ==================== GOOGLE OAUTH STRATEGY ====================
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // Find user by google_id
      let userResult = await pool.query(
        'SELECT id, username, email, role FROM users WHERE google_id = $1',
        [profile.id]
      );
      let user = userResult.rows[0];

      if (!user) {
        const email = profile.emails[0].value;
        // Check if user exists with this email
        let existingUserResult = await pool.query(
          'SELECT id, username, email, role FROM users WHERE email = $1',
          [email]
        );
        let existingUser = existingUserResult.rows[0];

        if (existingUser) {
          // Link google_id to existing account
          await pool.query(
            'UPDATE users SET google_id = $1 WHERE email = $2',
            [profile.id, email]
          );
          // Fetch updated user
          const updatedResult = await pool.query(
            'SELECT id, username, email, role FROM users WHERE email = $1',
            [email]
          );
          user = updatedResult.rows[0];
        } else {
          // Create new user
          let username = profile.displayName.replace(/\s/g, '').toLowerCase();
          const checkUsernameResult = await pool.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
          );
          if (checkUsernameResult.rows.length > 0) {
            username += Math.floor(Math.random() * 1000);
          }
          
          const dummyPassword = await bcrypt.hash('google_oauth_' + Date.now() + Math.random(), 10);
          
          const insertResult = await pool.query(
            `INSERT INTO users (username, email, google_id, password) 
             VALUES ($1, $2, $3, $4)
             RETURNING id, username, email`,
            [username, email, profile.id, dummyPassword]
          );
          user = insertResult.rows[0];
          await initializeUserCredits(user.id);
        }
      }
      return done(null, user);
    } catch (err) {
      console.error('Google strategy error:', err);
      return done(err);
    }
  }
));
// ==================== FILE UPLOAD SECURITY ====================
// Store avatars outside public folder, serve via route
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './private_uploads/avatars';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'avatar-' + req.session.userId + '-' + unique + ext);
    }
});

const upload = multer({
    storage: avatarStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif/;
        const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mime = allowedTypes.test(file.mimetype);
        if (ext && mime) return cb(null, true);
        cb(new Error('Only images are allowed'));
    }
});

// ==================== AUTH MIDDLEWARE (with role in session) ====================
const isAuthenticated = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    try {
        await poolConnect;
        if (!req.session.role) {
            const result = await pool.request()
                .input('id', sql.Int, req.session.userId)
                .query('SELECT role, is_banned FROM users WHERE id = @id');
            if (result.recordset.length === 0) {
                req.session.destroy();
                return res.status(401).json({ error: 'User not found' });
            }
            if (result.recordset[0].is_banned) {
                req.session.destroy();
                return res.status(403).json({ error: 'Your account has been banned' });
            }
            req.session.role = result.recordset[0].role;
        }
        next();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};

const isAdmin = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    if (req.session.role !== 'admin') {
        try {
            const result = await pool.request()
                .input('id', sql.Int, req.session.userId)
                .query('SELECT role FROM users WHERE id = @id');
            if (result.recordset.length === 0 || result.recordset[0].role !== 'admin')
                return res.status(403).json({ error: 'Access denied' });
            req.session.role = 'admin';
        } catch (err) {
            return res.status(500).json({ error: 'Server error' });
        }
    }
    next();
};

const isAdminOrModerator = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const role = req.session.role;
    if (role === 'admin' || role === 'moderator') {
        next();
    } else {
        try {
            const result = await pool.request()
                .input('id', sql.Int, req.session.userId)
                .query('SELECT role FROM users WHERE id = @id');
            const dbRole = result.recordset[0]?.role;
            if (dbRole === 'admin' || dbRole === 'moderator') {
                req.session.role = dbRole;
                next();
            } else {
                res.status(403).json({ error: 'Access denied' });
            }
        } catch (err) {
            res.status(500).json({ error: 'Server error' });
        }
    }
};

// ==================== AVATAR SERVING ROUTE (after isAuthenticated) ====================
app.get('/uploads/avatars/:filename', isAuthenticated, (req, res) => {
    const filepath = path.join(__dirname, 'private_uploads', 'avatars', req.params.filename);
    if (fs.existsSync(filepath)) {
        res.sendFile(filepath);
    } else {
        res.status(404).send('Avatar not found');
    }
});

// ==================== HELPER: GET PREMIUM STATUS (WITH BADGE) ====================
async function getPremiumStatus(userId) {
    const result = await pool.query(`
        SELECT 
            premium_until,
            analytics_until,
            featured_until,
            priority_support_until,
            message_boosts_remaining,
            has_custom_badge,
            selected_badge
        FROM users 
        WHERE id = $1
    `, [userId]);
    const user = result.rows[0];
    if (!user) return {}; // handle missing user
    const now = new Date();
    return {
        isPremium: user.premium_until && new Date(user.premium_until) > now,
        premiumUntil: user.premium_until,
        hasAnalytics: user.analytics_until && new Date(user.analytics_until) > now,
        analyticsUntil: user.analytics_until,
        isFeatured: user.featured_until && new Date(user.featured_until) > now,
        featuredUntil: user.featured_until,
        hasPrioritySupport: user.priority_support_until && new Date(user.priority_support_until) > now,
        prioritySupportUntil: user.priority_support_until,
        messageBoostsRemaining: user.message_boosts_remaining || 0,
        hasCustomBadge: user.has_custom_badge === true,   // PostgreSQL BOOLEAN
        selectedBadge: user.selected_badge
    };
}

// ==================== CREDITS SYSTEM (ATOMIC SPEND WITH TRANSACTION) ====================
async function spendCredits(userId, amount, reason, feature, durationDays = 0, uses = 0) {
    const client = await pool.connect(); // get a client for transaction
    try {
        await client.query('BEGIN');
        
        // Update user credits (check balance first)
        const updateResult = await client.query(
            `UPDATE user_credits 
             SET balance = balance - $1, lifetime_spent = lifetime_spent + $1, last_updated = NOW()
             WHERE user_id = $2 AND balance >= $1`,
            [amount, userId]
        );
        if (updateResult.rowCount === 0) {
            throw new Error('Insufficient credits');
        }
        
        // Insert transaction record
        await client.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'spend', $3)`,
            [userId, amount, reason || `Spent ${amount} credits on ${feature}`]
        );
        
        const now = new Date();
        if (feature === 'badge') {
            await client.query(
                'UPDATE users SET has_custom_badge = true WHERE id = $1',
                [userId]
            );
        } else if (feature === 'boost') {
            const boostUses = uses || 10;
            await client.query(
                'UPDATE users SET message_boosts_remaining = message_boosts_remaining + $1 WHERE id = $2',
                [boostUses, userId]
            );
        } else {
            const columnMap = {
                premium: 'premium_until',
                analytics: 'analytics_until',
                support: 'priority_support_until',
                featured: 'featured_until'
            };
            const column = columnMap[feature];
            if (column && durationDays > 0) {
                const current = await client.query(
                    `SELECT ${column} FROM users WHERE id = $1`,
                    [userId]
                );
                let currentDate = current.rows[0][column];
                let newExpiry;
                if (currentDate && new Date(currentDate) > now) {
                    newExpiry = new Date(new Date(currentDate).getTime() + durationDays * 24 * 60 * 60 * 1000);
                } else {
                    newExpiry = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
                }
                await client.query(
                    `UPDATE users SET ${column} = $1 WHERE id = $2`,
                    [newExpiry, userId]
                );
            }
        }
        
        await client.query('COMMIT');
        
        // Get new balance
        const balanceResult = await pool.query(
            'SELECT balance FROM user_credits WHERE user_id = $1',
            [userId]
        );
        return balanceResult.rows[0]?.balance || 0;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
// ==================== USER CREDITS INIT ====================
async function initializeUserCredits(userId) {
    try {
        await poolConnect;
        const existing = await pool.request()
            .input('user_id', sql.Int, userId)
            .query('SELECT id FROM user_credits WHERE user_id = @user_id');
        
        if (existing.recordset.length === 0) {
            const welcomeBonus = 600;
            await pool.request()
                .input('user_id', sql.Int, userId)
                .input('balance', sql.Decimal(10,2), welcomeBonus)
                .input('lifetime_earned', sql.Decimal(10,2), welcomeBonus)
                .query(`
                    INSERT INTO user_credits (user_id, balance, lifetime_earned)
                    VALUES (@user_id, @balance, @lifetime_earned)
                `);
            
            await pool.request()
                .input('user_id', sql.Int, userId)
                .input('amount', sql.Decimal(10,2), welcomeBonus)
                .input('type', sql.NVarChar, 'bonus')
                .input('description', sql.NVarChar, 'Welcome bonus for joining Sraveik')
                .query(`
                    INSERT INTO credit_transactions (user_id, amount, type, description)
                    VALUES (@user_id, @amount, @type, @description)
                `);
        }
    } catch (err) {
        console.error('Error initializing user credits:', err);
    }
}

async function ensureUserCredits(userId) {
    try {
        await poolConnect;
        const existing = await pool.request()
            .input('user_id', sql.Int, userId)
            .query('SELECT id FROM user_credits WHERE user_id = @user_id');
        if (existing.recordset.length === 0) {
            await initializeUserCredits(userId);
        }
    } catch (err) {
        console.error('Error ensuring user credits:', err);
    }
}

async function awardCreditsForToolApproval(userId, toolName) {
    try {
        const approvalBonus = 25;
        await pool.request()
            .input('user_id', sql.Int, userId)
            .input('amount', sql.Decimal(10,2), approvalBonus)
            .query(`
                UPDATE user_credits 
                SET balance = balance + @amount, lifetime_earned = lifetime_earned + @amount
                WHERE user_id = @user_id
            `);
        
        await pool.request()
            .input('user_id', sql.Int, userId)
            .input('amount', sql.Decimal(10,2), approvalBonus)
            .input('type', sql.NVarChar, 'earn')
            .input('description', sql.NVarChar, `Tool approved: ${toolName}`)
            .query(`
                INSERT INTO credit_transactions (user_id, amount, type, description)
                VALUES (@user_id, @amount, @type, @description)
            `);
        
        console.log(`✅ Awarded ${approvalBonus} credits to user ${userId} for tool approval: ${toolName}`);
    } catch (err) {
        console.error('Error awarding credits:', err);
    }
}

// ==================== PHONEPE PAYMENT GATEWAY ====================
// Initialize PhonePe Client
let phonepeClient = null;
if (process.env.PHONEPE_CLIENT_ID && process.env.PHONEPE_CLIENT_SECRET) {
    try {
        phonepeClient = StandardCheckoutClient.getInstance(
            process.env.PHONEPE_CLIENT_ID,
            process.env.PHONEPE_CLIENT_SECRET,
            parseInt(process.env.PHONEPE_CLIENT_VERSION) || 1,
            process.env.PHONEPE_ENV === 'sandbox' ? Env.SANDBOX : Env.PRODUCTION
        );
        console.log('✅ PhonePe client initialized');
    } catch (err) {
        console.error('❌ PhonePe initialization failed:', err.message);
    }
} else {
    console.log('⚠️ PhonePe credentials missing, payments disabled');
}

// Credit packs for purchase
const CREDIT_PACKS = [
    { id: 'pack_100', credits: 100, pricePaise: 4900, name: '100 Credits' },
    { id: 'pack_250', credits: 250, pricePaise: 9900, name: '250 Credits' },
    { id: 'pack_500', credits: 500, pricePaise: 17900, name: '500 Credits' },
    { id: 'pack_1000', credits: 1000, pricePaise: 29900, name: '1000 Credits' }
];

// Endpoint to initiate PhonePe payment
app.post('/api/create-phonepe-order', isAuthenticated, async (req, res) => {
    const { packId, credits, amountInPaise } = req.body;
    if (!packId || !credits || !amountInPaise) {
        return res.status(400).json({ error: 'Missing payment details' });
    }
    const merchantOrderId = `ORDER_${Date.now()}_${req.session.userId}`;
    try {
        // Build payment request
        const paymentRequest = await StandardCheckoutPayRequest.builder()
            .merchantOrderId(merchantOrderId)
            .amount(amountInPaise) // in paise
            .redirectUrl(`${process.env.PHONEPE_REDIRECT_URL}?order_id=${merchantOrderId}`)   // <-- ONLY CHANGE HERE
            .build();
        const paymentResponse = await phonepeClient.pay(paymentRequest);
        // Save transaction in DB
        await poolConnect;
        await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('credits', sql.Int, credits)
            .input('amount', sql.Decimal(10,2), amountInPaise / 100)
            .input('merchant_order_id', sql.NVarChar, merchantOrderId)
            .input('pack_id', sql.NVarChar, packId)
            .query(`
                INSERT INTO credit_purchases (user_id, credits, amount, merchant_order_id, pack_id, status, created_at)
                VALUES (@user_id, @credits, @amount, @merchant_order_id, @pack_id, 'PENDING', NOW())
            `);
        res.json({ success: true, redirectUrl: paymentResponse.redirectUrl });
    } catch (err) {
        console.error('PhonePe order error:', err);
        res.status(500).json({ error: 'Failed to initiate payment' });
    }
});

// PhonePe webhook to confirm payment and add credits
app.post('/api/phonepe-webhook', async (req, res) => {
    const authHeader = req.headers['x-verify'];
    const responseBody = req.body;
    try {
        // FIXED: Convert buffer to string properly
        const rawBody = responseBody.toString();
        const isValid = phonepeClient.validateCallback(
            process.env.PHONEPE_CLIENT_ID,
            process.env.PHONEPE_CLIENT_SECRET,
            authHeader,
            rawBody
        );
        if (!isValid) {
            console.error('Invalid PhonePe webhook signature');
            return res.status(401).send('Invalid signature');
        }
        const eventData = JSON.parse(rawBody);
        if (eventData.type === 'PG_ORDER_COMPLETED' && eventData.payload.state === 'COMPLETED') {
            const merchantOrderId = eventData.payload.orderId;
            await poolConnect;
            const purchase = await pool.request()
                .input('merchant_order_id', sql.NVarChar, merchantOrderId)
                .query('SELECT * FROM credit_purchases WHERE merchant_order_id = @merchant_order_id AND status = \'PENDING\'');
            if (purchase.recordset.length > 0) {
                const { user_id, credits } = purchase.recordset[0];
                await ensureUserCredits(user_id);
                await pool.request()
                    .input('user_id', sql.Int, user_id)
                    .input('amount', sql.Decimal(10,2), credits)
                    .query(`
                        UPDATE user_credits 
                        SET balance = balance + @amount, lifetime_earned = lifetime_earned + @amount
                        WHERE user_id = @user_id
                    `);
                await pool.request()
                    .input('user_id', sql.Int, user_id)
                    .input('amount', sql.Decimal(10,2), credits)
                    .input('type', sql.NVarChar, 'earn')
                    .input('description', sql.NVarChar, `Purchased ${credits} credits via PhonePe`)
                    .query(`
                        INSERT INTO credit_transactions (user_id, amount, type, description)
                        VALUES (@user_id, @amount, @type, @description)
                    `);
                await pool.request()
                    .input('merchant_order_id', sql.NVarChar, merchantOrderId)
                    .query('UPDATE credit_purchases SET status = \'COMPLETED\', updated_at = NOW() WHERE merchant_order_id = @merchant_order_id');
                console.log(`✅ Added ${credits} credits to user ${user_id} via PhonePe`);
            }
        }
        res.status(200).send('Webhook received');
    } catch (err) {
        console.error('PhonePe webhook error:', err);
        res.status(500).send('Internal server error');
    }
});
// Manual verification endpoint (fallback if webhook fails)
app.get('/api/verify-payment', isAuthenticated, async (req, res) => {
    const { order_id } = req.query;
    if (!order_id) {
        return res.status(400).json({ error: 'Missing order_id parameter' });
    }

    try {
        await poolConnect;

        // Find the pending purchase
        const purchase = await pool.request()
            .input('merchant_order_id', sql.NVarChar, order_id)
            .input('user_id', sql.Int, req.session.userId)
            .query(`
                SELECT * FROM credit_purchases 
                WHERE merchant_order_id = @merchant_order_id 
                  AND user_id = @user_id 
                  AND status = 'PENDING'
            `);

        if (purchase.recordset.length === 0) {
            return res.json({ status: 'not_found', message: 'No pending purchase found' });
        }

        const { id, credits, amount, merchant_order_id, user_id } = purchase.recordset[0];

        // Add credits to user's wallet
        await pool.request()
            .input('user_id', sql.Int, user_id)
            .input('credits', sql.Int, credits)
            .query(`
                UPDATE user_credits 
                SET balance = balance + @credits, lifetime_earned = lifetime_earned + @credits
                WHERE user_id = @user_id
            `);

        // Log transaction
        await pool.request()
            .input('user_id', sql.Int, user_id)
            .input('amount', sql.Decimal(10,2), credits)
            .input('type', sql.NVarChar, 'earn')
            .input('description', sql.NVarChar, `Purchased ${credits} credits via PhonePe (manual verification)`)
            .query(`
                INSERT INTO credit_transactions (user_id, amount, type, description)
                VALUES (@user_id, @amount, @type, @description)
            `);

        // Mark purchase as completed
        await pool.request()
            .input('id', sql.Int, id)
            .query(`
                UPDATE credit_purchases 
                SET status = 'COMPLETED', updated_at = NOW() 
                WHERE id = @id
            `);

        res.json({ success: true, credits_added: credits });
    } catch (err) {
        console.error('Manual verification error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create PhonePe order for a premium feature (e.g., 'premium' for 30 days)
app.post('/api/create-phonepe-premium-order', isAuthenticated, async (req, res) => {
  const { feature, durationDays, amountPaise } = req.body;
  const merchantOrderId = `PREMIUM_${Date.now()}_${req.session.userId}`;
  try {
    const paymentRequest = await StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantOrderId)
      .amount(amountPaise)
      .redirectUrl(`${process.env.PHONEPE_REDIRECT_URL}?order_id=${merchantOrderId}&feature=${feature}&days=${durationDays}`)
      .build();
    const paymentResponse = await phonepeClient.pay(paymentRequest);
    // Store pending premium purchase in a new table (e.g., premium_purchases)
    await pool.request()
      .input('user_id', sql.Int, req.session.userId)
      .input('feature', sql.NVarChar, feature)
      .input('duration_days', sql.Int, durationDays)
      .input('merchant_order_id', sql.NVarChar, merchantOrderId)
      .query(`INSERT INTO premium_purchases (user_id, feature, duration_days, merchant_order_id, status) 
              VALUES (@user_id, @feature, @duration_days, @merchant_order_id, 'PENDING')`);
    res.json({ success: true, redirectUrl: paymentResponse.redirectUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to initiate premium purchase' });
  }
});

// ==================== SOCKET.IO SETUP (ENHANCED with group chat and admin stats) ====================
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: allowedOrigins, credentials: true } });
io.use(sharedsession(sessionMiddleware, { autoSave: true }));

// FIXED: Store multiple socket IDs per user
const onlineUsers = new Map(); // userId -> { socketId: string, socketIds: Set }

async function getFriendsList(userId) {
    await poolConnect;
    const result = await pool.request()
        .input('user_id', sql.Int, userId)
        .query(`
            SELECT u.id, u.username, u.display_name, u.avatar_url, u.status
            FROM friendships f
            JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
            WHERE (f.user_id = @user_id OR f.friend_id = @user_id)
              AND f.status = 'accepted'
              AND u.id != @user_id
        `);
    return result.recordset;
}

// Helper for real‑time admin stats
async function getTotalUsersCount() {
    const result = await pool.query('SELECT COUNT(*) as count FROM users');
    return result.rows[0].count;
}
async function getRecentActivities() {
    const result = await pool.query(`SELECT action, moderator_name, created_at FROM moderator_activity ORDER BY created_at DESC LIMIT 5`);
    return result.rows;
}

// Server-side interval for broadcasting admin stats (once per 10 seconds)
//let adminStatsInterval = null;
//if (!adminStatsInterval) {
  //  adminStatsInterval = setInterval(async () => {
    //    const totalUsers = await getTotalUsersCount();
      //  const recentActivities = await getRecentActivities();
        //io.to('admin_room').emit('admin_stats', {
          //  onlineUsers: onlineUsers.size,
            //totalUsers,
            //recentActivities
        //});
    //}, 10000);
//}

io.on('connection', (socket) => {
    const session = socket.handshake.session;
    const userId = session.userId;
    if (!userId) {
        socket.disconnect();
        return;
    }
    
    // Manage multiple sockets per user
    let userEntry = onlineUsers.get(userId);
    if (!userEntry) {
        userEntry = { socketId: socket.id, socketIds: new Set() };
        onlineUsers.set(userId, userEntry);
    }
    userEntry.socketIds.add(socket.id);
    userEntry.socketId = socket.id; // primary socket for simplicity
    
    socket.join(`user_${userId}`);
    
    // Join admin room if role allows
    if (session.role === 'admin' || session.role === 'moderator') {
        socket.join('admin_room');
        // Send initial stats
        (async () => {
            const totalUsers = await getTotalUsersCount();
            const recentActivities = await getRecentActivities();
            socket.emit('admin_stats', {
                onlineUsers: onlineUsers.size,
                totalUsers,
                recentActivities
            });
        })();
    }

    // ---- Existing: friend online status ----
    (async () => {
        try {
            const friends = await getFriendsList(userId);
            friends.forEach(friend => {
                const friendEntry = onlineUsers.get(friend.id);
                if (friendEntry && friendEntry.socketId) io.to(friendEntry.socketId).emit('user_status', { userId, status: 'online' });
            });
        } catch (err) { console.error('Error broadcasting online status:', err); }
    })();

    // ---- Existing: private messages ----
    socket.on('private_message', async (data) => {
        const { to, message, tempId } = data;
        if (!to || !message) return;
        try {
            await poolConnect;
            const result = await pool.request()
                .input('sender_id', sql.Int, userId)
                .input('receiver_id', sql.Int, to)
                .input('content', sql.NVarChar, message)
                .query('INSERT INTO messages (sender_id, receiver_id, content) VALUES (@sender_id, @receiver_id, @content)');
            const newMessageId = result.rowsAffected[0] ? result.recordset?.[0]?.id : null;
            const realMessage = {
                id: newMessageId,
                sender_id: userId,
                content: message,
                created_at: new Date().toISOString(),
                is_boosted: false
            };
            const toEntry = onlineUsers.get(to);
            if (toEntry && toEntry.socketId) io.to(toEntry.socketId).emit('private_message', { from: userId, message, timestamp: new Date().toISOString(), id: newMessageId });
            if (tempId) {
                socket.emit('message_confirmed', { tempId, realMessage });
            }
        } catch (err) { console.error('Error saving message:', err); }
    });

    // ========== Group Chat Handlers (Enhanced) ==========
    socket.on('join_group', async (groupId) => {
        socket.join(`group_${groupId}`);
    });
    socket.on('leave_group', (groupId) => {
        socket.leave(`group_${groupId}`);
    });
    socket.on('group_message', async (data) => {
    const { groupId, message } = data;
    if (!groupId || !message) return;
    try {
        // Check membership
        const membership = await pool.query(
            'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
            [groupId, userId]
        );
        if (membership.rows.length === 0) return;

        // Insert message and get new ID (single statement)
        const result = await pool.query(
            'INSERT INTO group_messages (group_id, sender_id, content) VALUES ($1, $2, $3) RETURNING id',
            [groupId, userId, message]
        );
        const newId = result.rows[0].id;

        // Broadcast
        io.to(`group_${groupId}`).emit('group_message', {
            groupId,
            from: userId,
            message,
            timestamp: new Date().toISOString(),
            id: newId
        });
    } catch (err) {
        console.error('Group message error:', err);
    }
});
    socket.on('disconnect', () => {
        const userEntry = onlineUsers.get(userId);
        if (userEntry) {
            userEntry.socketIds.delete(socket.id);
            if (userEntry.socketIds.size === 0) {
                onlineUsers.delete(userId);
                (async () => {
                    try {
                        const friends = await getFriendsList(userId);
                        friends.forEach(friend => {
                            const friendEntry = onlineUsers.get(friend.id);
                            if (friendEntry && friendEntry.socketId) io.to(friendEntry.socketId).emit('user_status', { userId, status: 'offline' });
                        });
                    } catch (err) { console.error('Error broadcasting offline status:', err); }
                })();
            } else {
                // Update primary socket id
                userEntry.socketId = Array.from(userEntry.socketIds)[0];
            }
        }
        console.log(`User ${userId} disconnected`);
    });
});

// ==================== GROUP CHAT REST ENDPOINTS (NEW) ====================

// Get group messages with pagination
app.get('/api/groups/:id/messages', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 30;
    if (isNaN(groupId)) return res.status(400).json({ error: 'Invalid group ID' });
    try {
        await poolConnect;
        // Verify user is a member
        const membership = await pool.request()
            .input('groupId', sql.Int, groupId)
            .input('userId', sql.Int, req.session.userId)
            .query('SELECT 1 FROM group_members WHERE group_id = @groupId AND user_id = @userId');
        if (membership.recordset.length === 0) {
            return res.status(403).json({ error: 'You are not a member of this group' });
        }
        const result = await pool.request()
            .input('groupId', sql.Int, groupId)
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, limit)
            .query(`
                SELECT gm.id, gm.sender_id, gm.content, gm.created_at, u.username as sender_name
                FROM group_messages gm
                JOIN users u ON gm.sender_id = u.id
                WHERE gm.group_id = @groupId
                ORDER BY gm.created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch group messages' });
    }
});

// Get group members
app.get('/api/groups/:id/members', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    if (isNaN(groupId)) return res.status(400).json({ error: 'Invalid group ID' });
    try {
        await poolConnect;
        const membership = await pool.request()
            .input('groupId', sql.Int, groupId)
            .input('userId', sql.Int, req.session.userId)
            .query('SELECT 1 FROM group_members WHERE group_id = @groupId AND user_id = @userId');
        if (membership.recordset.length === 0) {
            return res.status(403).json({ error: 'You are not a member of this group' });
        }
        const result = await pool.request()
            .input('groupId', sql.Int, groupId)
            .query(`
                SELECT u.id, u.username, u.display_name, u.avatar_url
                FROM group_members gm
                JOIN users u ON gm.user_id = u.id
                WHERE gm.group_id = @groupId
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch group members' });
    }
});

// Add member to group (admin only – group creator)
app.post('/api/groups/:id/members', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    const { userId } = req.body;
    if (isNaN(groupId) || !userId) return res.status(400).json({ error: 'Invalid parameters' });
    try {
        await poolConnect;
        // Check if current user is group creator
        const group = await pool.request()
            .input('groupId', sql.Int, groupId)
            .query('SELECT created_by FROM groups WHERE id = @groupId');
        if (group.recordset.length === 0) return res.status(404).json({ error: 'Group not found' });
        if (group.recordset[0].created_by !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only group creator can add members' });
        }
        // Check if user exists and not already a member
        const existing = await pool.request()
            .input('groupId', sql.Int, groupId)
            .input('userId', sql.Int, userId)
            .query('SELECT 1 FROM group_members WHERE group_id = @groupId AND user_id = @userId');
        if (existing.recordset.length > 0) {
            return res.status(409).json({ error: 'User is already a member' });
        }
        await pool.request()
            .input('groupId', sql.Int, groupId)
            .input('userId', sql.Int, userId)
            .query('INSERT INTO group_members (group_id, user_id) VALUES (@groupId, @userId)');
        res.json({ success: true, message: 'Member added' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add member' });
    }
});

// Remove member from group (admin only)
app.delete('/api/groups/:id/members/:userId', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    const memberId = parseInt(req.params.userId);
    if (isNaN(groupId) || isNaN(memberId)) return res.status(400).json({ error: 'Invalid parameters' });
    try {
        await poolConnect;
        const group = await pool.request()
            .input('groupId', sql.Int, groupId)
            .query('SELECT created_by FROM groups WHERE id = @groupId');
        if (group.recordset.length === 0) return res.status(404).json({ error: 'Group not found' });
        if (group.recordset[0].created_by !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only group creator can remove members' });
        }
        // Cannot remove creator
        if (memberId === group.recordset[0].created_by) {
            return res.status(400).json({ error: 'Cannot remove group creator' });
        }
        await pool.request()
            .input('groupId', sql.Int, groupId)
            .input('userId', sql.Int, memberId)
            .query('DELETE FROM group_members WHERE group_id = @groupId AND user_id = @userId');
        res.json({ success: true, message: 'Member removed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to remove member' });
    }
});

// Leave group (for current user)
app.post('/api/groups/:id/leave', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    if (isNaN(groupId)) return res.status(400).json({ error: 'Invalid group ID' });

    try {
        await poolConnect;

        // Get group info
        const group = await pool.request()
            .input('groupId', sql.Int, groupId)
            .query('SELECT created_by FROM groups WHERE id = @groupId');
        if (group.recordset.length === 0) return res.status(404).json({ error: 'Group not found' });

        const isCreator = (group.recordset[0].created_by === req.session.userId);

        // ──────────────────────────────────────────────
        // OPTION 1: Creator can leave → group is deleted
        // ──────────────────────────────────────────────
        if (isCreator) {
            // Delete entire group (cascades to members & messages)
            await pool.request()
                .input('groupId', sql.Int, groupId)
                .query('DELETE FROM groups WHERE id = @groupId');
            
            // Notify all members that group is gone
            const members = await pool.request()
                .input('groupId', sql.Int, groupId)
                .query('SELECT user_id FROM group_members WHERE group_id = @groupId');
            for (const member of members.recordset) {
                const userEntry = onlineUsers.get(member.user_id);
                if (userEntry && userEntry.socketId) {
                    io.to(userEntry.socketId).emit('group_deleted', { groupId });
                }
            }
            
            return res.json({ success: true, message: 'Group deleted because you were the creator' });
        }

        // ──────────────────────────────────────────────
        // Regular member leaves
        // ──────────────────────────────────────────────
        await pool.request()
            .input('groupId', sql.Int, groupId)
            .input('userId', sql.Int, req.session.userId)
            .query('DELETE FROM group_members WHERE group_id = @groupId AND user_id = @userId');

        // Notify the user to leave socket room
        const userEntry = onlineUsers.get(req.session.userId);
        if (userEntry && userEntry.socketId) {
            io.to(userEntry.socketId).emit('leave_group', groupId);
        }

        res.json({ success: true, message: 'Left group' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to leave group' });
    }
});
// ==================== ADD THESE MISSING ENDPOINTS ====================

// CREATE GROUP
app.post('/api/admin/groups', isAdminOrModerator, async (req, res) => {
    const { name, members } = req.body;
    if (!name || !Array.isArray(members)) {
        return res.status(400).json({ error: 'Group name and members array required' });
    }

    try {
        await poolConnect;

        // Verify that all members are either admin or moderator
        for (const userId of members) {
            const roleCheck = await pool.request()
                .input('userId', sql.Int, userId)
                .query('SELECT role FROM users WHERE id = @userId');
            if (roleCheck.recordset.length === 0)
                return res.status(400).json({ error: `User ${userId} does not exist` });
            const role = roleCheck.recordset[0].role;
            if (role !== 'admin' && role !== 'moderator') {
                return res.status(403).json({ error: 'Only admins and moderators can be added to staff groups' });
            }
        }

        // Create group
        const result = await pool.request()
            .input('name', sql.NVarChar, name)
            .input('created_by', sql.Int, req.session.userId)
            .query(`INSERT INTO groups (name, created_by) OUTPUT INSERTED.id VALUES (@name, @created_by)`);
        const groupId = result.recordset[0].id;

        // Add creator
        await pool.request()
            .input('groupId', sql.Int, groupId)
            .input('userId', sql.Int, req.session.userId)
            .query(`INSERT INTO group_members (group_id, user_id) VALUES (@groupId, @userId)`);

        // Add other members
        for (const userId of members) {
            if (userId === req.session.userId) continue;
               const isFriend = await pool.request()
               .input('userId', req.session.userId)
               .input('friendId', userId)
               .query(`SELECT 1 FROM friendships 
                WHERE (user_id = @userId AND friend_id = @friendId)
                   OR (user_id = @friendId AND friend_id = @userId)
                  AND status = 'accepted'`);
            if (isFriend.recordset.length === 0) {
                 return res.status(403).json({ error: 'You can only add friends to a group' });
                }
        }
        for (const userId of members) {
            await pool.request()
                .input('groupId', sql.Int, groupId)
                .input('userId', sql.Int, userId)
                .query(`INSERT INTO group_members (group_id, user_id) VALUES (@groupId, @userId)`);
        }

        // Notify all members via Socket.IO
        for (const userId of [req.session.userId, ...members]) {
            const userEntry = onlineUsers.get(userId);
            if (userEntry && userEntry.socketId) io.to(userEntry.socketId).emit('group_created', { groupId, name });
        }

        res.status(201).json({ success: true, groupId, name });
    } catch (err) {
        console.error('Group creation error:', err);
        res.status(500).json({ error: 'Failed to create group' });
    }
});

// GET USER'S GROUPS
app.get('/api/groups', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .input('userId', sql.Int, req.session.userId)
            .query(`
                SELECT g.id, g.name, g.created_at,
                       (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
                FROM groups g
                JOIN group_members gm ON g.id = gm.group_id
                WHERE gm.user_id = @userId
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});
app.delete('/api/groups/:id', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    try {
        const group = await pool.request()
            .input('id', groupId)
            .query('SELECT created_by FROM groups WHERE id = @id');
        if (group.recordset.length === 0) return res.status(404).json({ error: 'Group not found' });
        if (group.recordset[0].created_by !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only creator or admin can delete' });
        }
        await pool.request().input('id', groupId).query('DELETE FROM groups WHERE id = @id');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete group' });
    }
});

// ==================== STAFF LOUNGE INFO ENDPOINT ====================
app.get('/api/staff-lounge', isAdminOrModerator, async (req, res) => {
    try {
        await poolConnect;
        const groupResult = await pool.request()
            .query(`SELECT id FROM groups WHERE name = 'Staff Lounge'`);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Staff Lounge not found' });
        }
        const groupId = groupResult.recordset[0].id;
        res.json({
            groupId,
            name: 'Staff Lounge',
            description: 'Public conference for all admins and moderators'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== PUBLIC ROUTES ====================
app.post('/send-otp', authLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send('Email is required');
    try {
        /*await poolConnect;
        const check = await pool.request()
            .input('email', sql.NVarChar, email)
            .query('SELECT id FROM users WHERE email = @email');
        if (check.recordset.length > 0) return res.status(409).send('Email already registered');*/
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 10 * 60 * 1000);
        
        await pool.request()
            .input('email', sql.NVarChar, email)
            .input('otp', sql.NVarChar, otp)
            .input('expires', sql.DateTime, expires)
            .query(`MERGE INTO otp_store AS target
                    USING (SELECT @email AS email) AS source
                    ON target.email = source.email
                    WHEN MATCHED THEN UPDATE SET otp = @otp, expires_at = @expires
                    WHEN NOT MATCHED THEN INSERT (email, otp, expires_at) VALUES (@email, @otp, @expires);`);
        
        const emailSent = await sendOtpEmail(email, otp);
        if (!emailSent.success) return res.status(500).send('Failed to send OTP email');
        res.status(200).send('OTP sent successfully');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});
// Create a new group
app.post('/api/groups', isAuthenticated, async (req, res) => {
    const { name, members } = req.body;
    if (!name || !Array.isArray(members)) {
        return res.status(400).json({ error: 'Group name and members array required' });
    }
    try {
        // Insert group and return id
        const result = await pool.query(
            `INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id`,
            [name, req.session.userId]
        );
        const groupId = result.rows[0].id;
        
        // Add creator as member
        await pool.query(
            `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
            [groupId, req.session.userId]
        );
        
        // Add other members
        for (const memberId of members) {
            await pool.query(
                `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
                [groupId, memberId]
            );
        }
        
        // Notify all members via Socket.IO
        for (const userId of [req.session.userId, ...members]) {
            const userEntry = onlineUsers.get(userId);
            if (userEntry && userEntry.socketId) {
                io.to(userEntry.socketId).emit('group_created', { groupId, name });
            }
        }
        
        res.status(201).json({ success: true, groupId, name });
    } catch (err) {
        console.error('Group creation error:', err);
        res.status(500).json({ error: 'Failed to create group' });
    }
});
app.get('/api/groups', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT g.id, g.name, g.created_at,
                   (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
            FROM groups g
            JOIN group_members gm ON g.id = gm.group_id
            WHERE gm.user_id = $1
        `, [req.session.userId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});
// ==================== FIXED REGISTER: Username uniqueness check + proper error ====================
app.post('/register', authLimiter, async (req, res) => {
    const { username, email, password, otp, ref } = req.body;
    if (!username || !email || !password || !otp)
        return res.status(400).send('All fields (including OTP) are required');

    const strength = validatePasswordStrength(password);
    if (!strength.valid) return res.status(400).send(strength.message);

    try {
        // Check username existence
        const existingUsername = await pool.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
        );
        if (existingUsername.rows.length > 0) {
            return res.status(409).send('Username already exists');
        }

        const storedOtp = await pool.query(
            'SELECT otp, expires_at FROM otp_store WHERE email = $1',
            [email]
        );
        if (storedOtp.rows.length === 0) return res.status(400).send('No OTP requested or expired');
        const { otp: storedOtpCode, expires_at } = storedOtp.rows[0];
        if (new Date() > new Date(expires_at)) {
            await pool.query('DELETE FROM otp_store WHERE email = $1', [email]);
            return res.status(400).send('OTP expired. Please request a new one.');
        }
        if (storedOtpCode !== otp) return res.status(400).send('Invalid OTP');

        const checkEmail = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        if (checkEmail.rows.length > 0) return res.status(409).send('Email already registered');

        const hashedPassword = await bcrypt.hash(password, 10);
        
        let referrerId = null;
        if (ref) {
            const referrer = await pool.query(
                'SELECT id FROM users WHERE username = $1',
                [ref]
            );
            if (referrer.rows.length > 0) {
                referrerId = referrer.rows[0].id;
            }
        }
        
        const result = await pool.query(
            `INSERT INTO users (username, email, password, referrer_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [username, email, hashedPassword, referrerId]
        );
        const newUserId = result.rows[0].id;

        io.emit('new_user_registration', { userId: newUserId, username, email });
        
        await pool.query('DELETE FROM otp_store WHERE email = $1', [email]);
        await initializeUserCredits(newUserId);
        
        if (referrerId) {
            const referralBonus = 50;
            await pool.query(
                `UPDATE user_credits 
                 SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
                 WHERE user_id = $2`,
                [referralBonus, referrerId]
            );
            
            await pool.query(
                `INSERT INTO credit_transactions (user_id, amount, type, description)
                 VALUES ($1, $2, 'earn', $3)`,
                [referrerId, referralBonus, `Referral bonus for inviting ${username}`]
            );
            // GAMIFICATION: Award XP to referrer for referral
            await addXP(referrerId, 50, 'Referral');
            await updateQuestProgress(referrerId, 'referral');
            await checkAchievements(referrerId);
        }
        
        sendWelcomeEmail(email, username).catch(err => console.error('Welcome email failed:', err.message));
        sendAdminAlert({ subject: 'New User Registration', message: `New user ${username} (${email}) registered.` }).catch(err => console.error('Admin alert failed:', err.message));
        res.status(201).send('Registration successful! Please login.');
    } catch (err) {
        console.error(err);
        // Handle duplicate key error from PostgreSQL
        if (err.code === '23505') { // unique violation
            if (err.constraint === 'users_username_key') return res.status(409).send('Username already exists');
            if (err.constraint === 'users_email_key') return res.status(409).send('Email already registered');
        }
        res.status(500).send('Server error');
    }
});
// ==================== LOGIN ====================
const MAX_LOGIN_ATTEMPTS = 15;
function validatePasswordStrength(password) {
    const result = zxcvbn(password);
    if (result.score < 3) {
        return { valid: false, message: 'Password too weak. Use a mix of letters, numbers, and symbols.' };
    }
    return { valid: true };
}

app.post('/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Username/email and password required');
    
    try {
        const isEmail = username.includes('@') && username.includes('.');
        const column = isEmail ? 'email' : 'username';
        const result = await pool.query(`SELECT * FROM users WHERE ${column} = $1`, [username]);
        
        if (result.rows.length === 0) {
            return res.status(401).send('Invalid username/email or password');
        }
        const user = result.rows[0];

        if (user.google_id && !user.password) {
            return res.status(401).send('This account uses Google Sign-In. Please log in with Google.');
        }
        if (user.is_banned) {
            return res.status(401).send('Your account has been banned. Contact support.');
        }

        const isAdminUser = user.role === 'admin';
        if (!isAdminUser && user.lock_until && new Date() < new Date(user.lock_until)) {
            return res.status(401).send('Account temporarily locked. Try again later.');
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            if (!isAdminUser) {
                await pool.query(`
                    UPDATE users SET 
                        login_attempts = login_attempts + 1,
                        lock_until = CASE 
                            WHEN login_attempts + 1 >= $1 THEN NOW() + INTERVAL '30 minutes'
                            ELSE lock_until
                        END
                    WHERE id = $2
                `, [MAX_LOGIN_ATTEMPTS, user.id]);
            }
            return res.status(401).send('Invalid username/email or password');
        }

        if (!isAdminUser) {
            await pool.query(
                'UPDATE users SET login_attempts = 0, lock_until = NULL WHERE id = $1',
                [user.id]
            );
        }

        req.session.regenerate((err) => {
            if (err) return res.status(500).send('Session error');
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.email = user.email;
            req.session.role = user.role;
            if (user.role === 'admin') res.send('Login successful:admin');
            else res.send('Login successful');
        });

        // GAMIFICATION: update login streak, award XP, and check achievements
        const multiplier = await updateStreak(user.id);
        await addXP(user.id, Math.floor(5 * multiplier), 'Daily login');
        await updateQuestProgress(user.id, 'login');
        await checkAchievements(user.id);

    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});


// ==================== LOGOUT ====================
const logoutHandler = (req, res) => {
    req.session.destroy(err => {
        if (err) console.error(err);
        res.send('Logged out');
    });
};
app.post('/logout', logoutHandler);
app.post('/api/logout', logoutHandler);

app.get('/check-session', (req, res) => {
    if (req.session.userId) res.json({ loggedIn: true, username: req.session.username });
    else res.json({ loggedIn: false });
});

// ==================== GOOGLE OAUTH ====================
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
    req.session.regenerate((err) => {
        if (err) return res.redirect('/');
        req.session.userId = req.user.id;
        req.session.username = req.user.username;
        req.session.email = req.user.email;
        req.session.role = req.user.role;
        if (req.user.role === 'admin') res.redirect('/admin-dashboard.html');
        else res.redirect('/dashboard.html');
    });
});

// ==================== TOOL USAGE TRACKING (with gamification) ====================
app.post('/api/track-usage', isAuthenticated, async (req, res) => {
    const { tool_name, tool_category } = req.body;
    if (!tool_name) return res.status(400).send('Tool name required');
    try {
        await poolConnect;
        await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('tool_name', sql.NVarChar, tool_name)
            .input('tool_category', sql.NVarChar, tool_category || null)
            .query('INSERT INTO tool_usage (user_id, tool_name, tool_category) VALUES (@user_id, @tool_name, @tool_category)');

        // ========== GAMIFICATION ADDITIONS ==========
        await addXP(req.session.userId, 2, 'Tool used');
        await updateQuestProgress(req.session.userId, 'use_tool');
        await checkAchievements(req.session.userId);
        // ===========================================

        res.send('Tracked');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});
// ==================== TOOL REVIEW ENDPOINT (with gamification) ====================
app.post('/api/tools/:id/review', isAuthenticated, async (req, res) => {
    const toolId = req.params.id;
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    try {
        await poolConnect;
        // Insert review (assuming reviews table exists; create if not exists)
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tool_reviews' AND xtype='U')
            CREATE TABLE tool_reviews (
                id INT IDENTITY(1,1) PRIMARY KEY,
                tool_id INT NOT NULL,
                user_id INT NOT NULL,
                rating INT NOT NULL,
                comment NVARCHAR(1000) NULL,
                created_at DATETIME DEFAULT NOW(),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE
            )
        `);
        await pool.request()
            .input('tool_id', sql.Int, toolId)
            .input('user_id', sql.Int, req.session.userId)
            .input('rating', sql.Int, rating)
            .input('comment', sql.NVarChar, comment || '')
            .query('INSERT INTO tool_reviews (tool_id, user_id, rating, comment) VALUES (@tool_id, @user_id, @rating, @comment)');
        
        // GAMIFICATION: award XP for writing a review, update quest, check achievements
        await addXP(req.session.userId, 10, 'Review');
        await updateQuestProgress(req.session.userId, 'review');
        await checkAchievements(req.session.userId);
        
        res.json({ success: true, message: 'Review submitted! +10 XP' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit review' });
    }
});
// ==================== CATEGORY REVIEW (for main page cards) ====================
app.post('/api/category-review', isAuthenticated, async (req, res) => {
    const { category, rating, comment } = req.body;
    if (!category || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Category and valid rating (1-5) are required' });
    }
    try {
        await poolConnect;
        // Create category_reviews table if not exists
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='category_reviews' AND xtype='U')
            CREATE TABLE category_reviews (
                id INT IDENTITY(1,1) PRIMARY KEY,
                user_id INT NOT NULL,
                category NVARCHAR(100) NOT NULL,
                rating INT NOT NULL,
                comment NVARCHAR(1000) NULL,
                created_at DATETIME DEFAULT NOW(),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        // Insert review
        await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('category', sql.NVarChar, category)
            .input('rating', sql.Int, rating)
            .input('comment', sql.NVarChar, comment || '')
            .query(`INSERT INTO category_reviews (user_id, category, rating, comment) VALUES (@user_id, @category, @rating, @comment)`);
        
        // Award XP and update quest progress (same as tool review)
        await addXP(req.session.userId, 10, 'Category Review');
        await updateQuestProgress(req.session.userId, 'review');
        await checkAchievements(req.session.userId);
        
        res.json({ success: true, message: `Review submitted for ${category}! +10 XP` });
    } catch (err) {
        console.error('Category review error:', err);
        res.status(500).json({ error: 'Failed to submit review' });
    }
});

// ==================== BADGE ENDPOINTS ====================
app.post('/api/user/set-badge', isAuthenticated, async (req, res) => {
    const { badge } = req.body;
    const allowedBadges = ['premium', 'contributor', 'helper', 'expert'];
    if (badge && !allowedBadges.includes(badge)) {
        return res.status(400).json({ error: 'Invalid badge' });
    }
    try {
        await poolConnect;
        const user = await pool.request()
            .input('userId', req.session.userId)
            .query('SELECT has_custom_badge FROM users WHERE id = @userId');
        if (!user.recordset[0]?.has_custom_badge) {
            return res.status(403).json({ error: 'You have not purchased a custom badge' });
        }
        await pool.request()
            .input('userId', req.session.userId)
            .input('badge', badge || null)
            .query('UPDATE users SET selected_badge = @badge WHERE id = @userId');
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN REWARDS DEDICATED ENDPOINT ====================
app.get('/api/credits/admin-rewards', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .input('userId', req.session.userId)
            .query(`
                SELECT id, amount, type, description, created_at
                FROM credit_transactions
                WHERE user_id = @userId AND type = 'earn' AND (description LIKE '%admin%' OR description LIKE '%reward%')
                ORDER BY created_at DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== PREMIUM STATUS ROUTE (WITH BADGE) ====================
app.get('/api/user/premium-status', isAuthenticated, async (req, res) => {
    try {
        const status = await getPremiumStatus(req.session.userId);
        res.json(status);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== SPEND ROUTE (ATOMIC) ====================
app.post('/api/credits/spend', isAuthenticated, async (req, res) => {
    const { amount, reason, feature, duration } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!feature) return res.status(400).json({ error: 'Feature is required' });

    try {
        await ensureUserCredits(req.session.userId);
        
        let days = 0, uses = 0;
        if (duration) {
            if (typeof duration === 'number') days = duration;
            else if (typeof duration === 'string') {
                const match = duration.match(/(\d+)/);
                if (match) {
                    if (feature === 'boost') uses = parseInt(match[1]);
                    else days = parseInt(match[1]);
                }
            }
        }
        if (feature === 'boost' && uses === 0) uses = 10;
        
        const newBalance = await spendCredits(req.session.userId, amount, reason, feature, days, uses);
        
        const updatedPremiumStatus = await getPremiumStatus(req.session.userId);
        res.json({ success: true, message: `Spent ${amount} credits on ${feature}`, newBalance, premiumStatus: updatedPremiumStatus });
    } catch (err) {
        console.error('Spend error:', err);
        if (err.message === 'Insufficient credits') {
            res.status(400).json({ error: 'Insufficient credits' });
        } else {
            res.status(500).json({ error: 'Server error' });
        }
    }
});

// ==================== PROFILE UPDATE (WITH ESCAPING) ====================
app.put('/profile/update', isAuthenticated, async (req, res) => {
    const { display_name, bio, phone, github, twitter, linkedin } = req.body;
    try {
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, req.session.userId)
            .input('display_name', sql.NVarChar, display_name ? escapeHtml(display_name) : null)
            .input('bio', sql.NVarChar, bio ? escapeHtml(bio) : null)
            .input('phone', sql.NVarChar, phone ? escapeHtml(phone) : null)
            .input('github', sql.NVarChar, github ? escapeHtml(github) : null)
            .input('twitter', sql.NVarChar, twitter ? escapeHtml(twitter) : null)
            .input('linkedin', sql.NVarChar, linkedin ? escapeHtml(linkedin) : null)
            .query(`
                UPDATE users SET
                    display_name = @display_name,
                    bio = @bio,
                    phone = @phone,
                    github = @github,
                    twitter = @twitter,
                    linkedin = @linkedin,
                    updated_at = NOW()
                WHERE id = @id
            `);
        const updated = await pool.request()
            .input('id', sql.Int, req.session.userId)
            .query(`
                SELECT id, username, display_name, email, bio, phone,
                       github, twitter, linkedin, email_verified,
                       two_factor_enabled, created_at, updated_at,
                       avatar_url
                FROM users WHERE id = @id
            `);
        res.json(updated.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== AVATAR UPLOAD (with file type validation) ====================
app.post('/profile/avatar', isAuthenticated, upload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');
    try {
        const buffer = fs.readFileSync(req.file.path);
        const fileType = await fileTypeFromBuffer(buffer);
        if (!fileType || !['image/jpeg', 'image/png', 'image/gif'].includes(fileType.mime)) {
            fs.unlinkSync(req.file.path);
            return res.status(400).send('Invalid image file');
        }
        const avatarUrl = '/uploads/avatars/' + req.file.filename;
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, req.session.userId)
            .input('avatar_url', sql.NVarChar, avatarUrl)
            .query('UPDATE users SET avatar_url = @avatar_url WHERE id = @id');
        res.send('Avatar uploaded successfully');
    } catch (err) {
        console.error(err);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).send('Server error');
    }
});

// ==================== TOOL SUBMISSION & APPROVAL SYSTEM ====================
// (All your original tool routes go here – unchanged)

// User submits a new tool
app.post('/api/tools/submit', isAuthenticated, async (req, res) => {
    const { name, url, description, category, pageType } = req.body;
    
    if (!name || !url) {
        return res.status(400).json({ error: 'Name and URL are required' });
    }
    
    const urlPattern = /^https?:\/\/.+/;
    if (!urlPattern.test(url)) {
        return res.status(400).json({ error: 'Invalid URL format. Use http:// or https://' });
    }
    
    const finalPageType = pageType || 'student';
    
    try {
        const existing = await pool.query(
            'SELECT id FROM tools WHERE name = $1 OR url = $2',
            [name, url]
        );
        
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'A tool with this name or URL already exists' });
        }
        
        await pool.query(`
            INSERT INTO tools (name, url, description, category, user_id, page_type, approved, submitted_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, false, NOW(), NOW())
        `, [name, url, description || '', category || 'study', req.session.userId, finalPageType]);
        
        try {
            await sendToolSubmissionAlert({
                username: req.session.username,
                userEmail: req.session.email,
                toolName: name,
                toolUrl: url,
                toolDescription: description,
                toolCategory: category,
                pageType: finalPageType
            });
        } catch(emailErr) {
            console.error('Admin notification failed:', emailErr);
        }
        
        res.status(201).json({ 
            success: true, 
            message: 'Tool submitted successfully! Admin will review it shortly.' 
        });
    } catch (err) {
        console.error('Tool submission error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});
// Get all pending tools (for admin/moderator)
app.get('/api/admin/tools/pending', isAdminOrModerator, async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .query(`
                SELECT t.*, u.username as submitted_by, u.email as submitter_email
                FROM tools t
                LEFT JOIN users u ON t.user_id = u.id
                WHERE t.approved = false OR t.approved IS NULL
                ORDER BY t.submitted_at DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all tools (admin/moderator view - includes pending) - ENHANCED with usage_count and is_featured
app.get('/api/admin/tools', isAdminOrModerator, async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .query(`
                SELECT t.*, u.username as submitted_by, 
                       (SELECT COUNT(*) FROM tool_usage WHERE tool_name = t.name) as usage_count,
                       COALESCE(t.is_featured, false) as is_featured
                FROM tools t
                LEFT JOIN users u ON t.user_id = u.id
                ORDER BY t.id DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Approve a tool (admin only)
app.put('/api/admin/tools/:id/approve', isAdmin, async (req, res) => {
    const toolId = req.params.id;
    
    try {
        await poolConnect;
        
        const toolResult = await pool.request()
            .input('id', sql.Int, toolId)
            .query(`
                SELECT t.*, u.email as submitter_email, u.username as submitter_name
                FROM tools t
                LEFT JOIN users u ON t.user_id = u.id
                WHERE t.id = @id
            `);
        
        if (toolResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Tool not found' });
        }
        
        const tool = toolResult.recordset[0];
        
        await pool.request()
            .input('id', sql.Int, toolId)
            .query('UPDATE tools SET approved = true WHERE id = @id');
        
        if (tool.user_id) {
            await awardCreditsForToolApproval(tool.user_id, tool.name);
            
            if (tool.submitter_email) {
                await sendToolApprovalEmail(tool.submitter_email, tool.submitter_name, tool.name);
            }
        }
        
        res.json({ 
            success: true, 
            message: 'Tool approved successfully! User has been awarded 25 credits.' 
        });
        
    } catch (err) {
        console.error('Approval error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN: GET USER CREDIT TRANSACTIONS ====================
app.get('/api/admin/users/:id/credits/transactions', isAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    const { limit = 50, offset = 0 } = req.query;
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });
    try {
        await poolConnect;
        const result = await pool.request()
            .input('user_id', sql.Int, userId)
            .input('limit', sql.Int, parseInt(limit))
            .input('offset', sql.Int, parseInt(offset))
            .query(`
                SELECT id, amount, type, description, created_at,
                       CASE WHEN type IN ('earn', 'bonus', 'refund') THEN '+' ELSE '-' END as sign
                FROM credit_transactions
                WHERE user_id = @user_id
                ORDER BY created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        const countResult = await pool.request()
            .input('user_id', sql.Int, userId)
            .query('SELECT COUNT(*) as total FROM credit_transactions WHERE user_id = @user_id');
        res.json({
            transactions: result.recordset,
            total: countResult.recordset[0]?.total || 0
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN: BULK EMAIL ====================
app.post('/api/admin/bulk-email', isAdmin, async (req, res) => {
    const { userIds, subject, htmlContent } = req.body;
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'No users selected' });
    }
    if (!subject || !htmlContent) {
        return res.status(400).json({ error: 'Subject and content are required' });
    }
    try {
        await poolConnect;
        const users = await pool.request()
            .query(`SELECT id, email, username FROM users WHERE id IN (${userIds.join(',')})`);
        let successCount = 0, failCount = 0;
        for (const user of users.recordset) {
            const ok = await sendEmail(user.email, subject, htmlContent);
            if (ok.success) successCount++;
            else failCount++;
        }
        // Log the action
        await pool.request()
            .input('moderator_id', sql.Int, req.session.userId)
            .input('moderator_name', sql.NVarChar, req.session.username)
            .input('action', sql.NVarChar, 'Bulk email')
            .input('target', sql.NVarChar, `${successCount} users`)
            .input('details', sql.NVarChar, `Subject: ${subject}`)
            .query(`INSERT INTO moderator_activity (moderator_id, moderator_name, action, target, details) VALUES (@moderator_id, @moderator_name, @action, @target, @details)`);
        res.json({ success: true, successCount, failCount });
    } catch (err) {
        console.error('Bulk email error:', err);
        res.status(500).json({ error: 'Failed to send emails' });
    }
});

// Admin: give credits to user
app.post('/api/admin/users/:id/credits', isAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    let { amount, reason } = req.body;

    if (isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }

    let numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ error: 'Invalid credit amount. Must be a positive number.' });
    }

    try {
        await poolConnect;

        const userCheck = await pool.request()
            .input('id', sql.Int, userId)
            .query('SELECT id FROM users WHERE id = @id');
        if (userCheck.recordset.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        await ensureUserCredits(userId);

        await pool.request()
            .input('user_id', sql.Int, userId)
            .input('amount', sql.Decimal(10,2), numericAmount)
            .query(`
                UPDATE user_credits 
                SET balance = balance + @amount, 
                    lifetime_earned = lifetime_earned + @amount,
                    last_updated = NOW()
                WHERE user_id = @user_id
            `);

        const transactionReason = reason ? reason.trim() : `Admin added ${numericAmount} credits`;
        await pool.request()
            .input('user_id', sql.Int, userId)
            .input('amount', sql.Decimal(10,2), numericAmount)
            .input('type', sql.NVarChar, 'earn')
            .input('description', sql.NVarChar, transactionReason)
            .query(`
                INSERT INTO credit_transactions (user_id, amount, type, description)
                VALUES (@user_id, @amount, @type, @description)
            `);

        console.log(`✅ Admin ${req.session.username} gave ${numericAmount} credits to user ${userId}`);
        res.json({ success: true, message: `Added ${numericAmount} credits to user ${userId}` });
    } catch (err) {
        console.error('Error giving credits:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Reject a tool (admin only)
app.delete('/api/admin/tools/:id/reject', isAdmin, async (req, res) => {
    const toolId = req.params.id;
    const { reason } = req.body;
    
    try {
        await poolConnect;
        
        const toolResult = await pool.request()
            .input('id', sql.Int, toolId)
            .query(`
                SELECT t.name, t.user_id, u.email as submitter_email, u.username as submitter_name
                FROM tools t
                LEFT JOIN users u ON t.user_id = u.id
                WHERE t.id = @id
            `);
        
        if (toolResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Tool not found' });
        }
        
        const tool = toolResult.recordset[0];
        
        if (tool.submitter_email) {
            await sendToolRejectionEmail(tool.submitter_email, tool.submitter_name || 'User', tool.name, reason);
        }
        
        await pool.request()
            .input('id', sql.Int, toolId)
            .query('DELETE FROM tools WHERE id = @id');
        
        console.log(`❌ Tool "${tool.name}" rejected by admin`);
        
        res.json({ 
            success: true, 
            message: 'Tool rejected and removed.' 
        });
        
    } catch (err) {
        console.error('Rejection error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get approved tools only for a specific page (for users) - ENHANCED with is_featured
app.get('/api/tools', isAuthenticated, async (req, res) => {
    const { page = 'student', premium = 'false' } = req.query;
    try {
        let query = `
            SELECT * FROM tools 
            WHERE approved = true AND page_type = $1
        `;
        const params = [page];
        if (premium !== 'true') {
            query += ` AND (is_premium = false OR is_premium IS NULL)`;
        }
        query += ` ORDER BY is_featured DESC, created_at DESC`;
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get recently approved tools (for newtools.html – all categories)
app.get('/api/tools/recent', isAuthenticated, async (req, res) => {
    const { limit = 50, page } = req.query;
    try {
        await poolConnect;
        let query = `
            SELECT TOP (@limit) t.*, u.username as submitted_by
            FROM tools t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.approved = true
        `;
        if (page && page !== 'all') {
            query += ` AND t.page_type = @page_type`;
        }
        query += ` ORDER BY t.created_at DESC`;
        
        const request = pool.request().input('limit', sql.Int, parseInt(limit));
        if (page && page !== 'all') {
            request.input('page_type', sql.NVarChar, page);
        }
        const result = await request.query(query);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin add tool directly (ENHANCED: now accepts is_featured flag)
app.post('/api/admin/tools', isAdmin, async (req, res) => {
    const { name, url, description, category, approved, pageType, is_premium, is_featured } = req.body;
    
    if (!name || !url) {
        return res.status(400).json({ error: 'Name and URL are required' });
    }
    
    try {
        await poolConnect;
        
        const result = await pool.request()
            .input('name', sql.NVarChar, name)
            .input('url', sql.NVarChar, url)
            .input('description', sql.NVarChar, description || '')
            .input('category', sql.NVarChar, category || 'study')
            .input('approved', sql.Bit, approved === undefined ? 1 : approved)
            .input('page_type', sql.NVarChar, pageType || 'student')
            .input('is_premium', sql.Bit, is_premium || 0)
            .input('is_featured', sql.Bit, is_featured || 0)
            .query(`
                INSERT INTO tools (name, url, description, category, approved, page_type, is_premium, is_featured, created_at)
                OUTPUT INSERTED.id
                VALUES (@name, @url, @description, @category, @approved, @page_type, @is_premium, @is_featured, NOW())
            `);
        
        res.status(201).json({ 
            success: true, 
            message: 'Tool added successfully',
            toolId: result.recordset[0]?.id 
        });
        
    } catch (err) {
        console.error('Add tool error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin update tool (ENHANCED: includes is_featured)
app.put('/api/admin/tools/:id', isAdmin, async (req, res) => {
    const toolId = req.params.id;
    const { name, url, description, category, approved, pageType, is_premium, is_featured } = req.body;
    
    try {
        await poolConnect;
        
        await pool.request()
            .input('id', sql.Int, toolId)
            .input('name', sql.NVarChar, name)
            .input('url', sql.NVarChar, url)
            .input('description', sql.NVarChar, description || '')
            .input('category', sql.NVarChar, category || 'study')
            .input('approved', sql.Bit, approved)
            .input('page_type', sql.NVarChar, pageType || 'student')
            .input('is_premium', sql.Bit, is_premium || 0)
            .input('is_featured', sql.Bit, is_featured || 0)
            .query(`
                UPDATE tools SET 
                    name = @name, 
                    url = @url, 
                    description = @description,
                    category = @category, 
                    approved = @approved,
                    page_type = @page_type,
                    is_premium = @is_premium,
                    is_featured = @is_featured
                WHERE id = @id
            `);
        
        res.json({ success: true, message: 'Tool updated successfully' });
        
    } catch (err) {
        console.error('Update tool error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin delete tool
app.delete('/api/admin/tools/:id', isAdmin, async (req, res) => {
    const toolId = req.params.id;
    
    try {
        await poolConnect;
        
        await pool.request()
            .input('id', sql.Int, toolId)
            .query('DELETE FROM tools WHERE id = @id');
        
        res.json({ success: true, message: 'Tool deleted successfully' });
        
    } catch (err) {
        console.error('Delete tool error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});


// ==================== CARDS MANAGEMENT (Admin only) ====================

// Get all cards (public, but admin uses it)
app.get('/api/cards', async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request().query(`
            SELECT * FROM cards ORDER BY display_order ASC, id ASC
        `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch cards' });
    }
});

// Get single card
app.get('/api/cards/:id', isAdmin, async (req, res) => {
    const cardId = parseInt(req.params.id);
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, cardId)
            .query('SELECT * FROM cards WHERE id = @id');
        if (result.recordset.length === 0) return res.status(404).json({ error: 'Card not found' });
        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch card' });
    }
});

// Create new card (admin only)
app.post('/api/cards', isAdmin, async (req, res) => {
    const { title, description, icon, link, category, order } = req.body;
    if (!title || !icon || !link || !category) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        await poolConnect;
        const result = await pool.request()
            .input('title', sql.NVarChar, title)
            .input('description', sql.NVarChar, description || '')
            .input('icon', sql.NVarChar, icon)
            .input('link', sql.NVarChar, link)
            .input('category', sql.NVarChar, category)
            .input('display_order', sql.Int, order || 0)
            .query(`
                INSERT INTO cards (title, description, icon, link, category, display_order)
                OUTPUT INSERTED.id
                VALUES (@title, @description, @icon, @link, @category, @display_order)
            `);
        res.status(201).json({ success: true, id: result.recordset[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create card' });
    }
});

// Update card (admin only)
app.put('/api/cards/:id', isAdmin, async (req, res) => {
    const cardId = parseInt(req.params.id);
    const { title, description, icon, link, category, order } = req.body;
    try {
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, cardId)
            .input('title', sql.NVarChar, title)
            .input('description', sql.NVarChar, description || '')
            .input('icon', sql.NVarChar, icon)
            .input('link', sql.NVarChar, link)
            .input('category', sql.NVarChar, category)
            .input('display_order', sql.Int, order || 0)
            .query(`
                UPDATE cards SET
                    title = @title,
                    description = @description,
                    icon = @icon,
                    link = @link,
                    category = @category,
                    display_order = @display_order,
                    updated_at = NOW()
                WHERE id = @id
            `);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update card' });
    }
});

// Delete card (admin only)
app.delete('/api/cards/:id', isAdmin, async (req, res) => {
    const cardId = parseInt(req.params.id);
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, cardId)
            .query('DELETE FROM cards WHERE id = @id');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Card not found' });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete card' });
    }
});

// ==================== CREDITS SYSTEM ====================

// Get user credits balance
app.get('/api/credits/balance', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        await ensureUserCredits(req.session.userId);
        const result = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .query(`
                SELECT 
                    COALESCE(balance, false) as balance,
                    COALESCE(lifetime_earned, false) as lifetime_earned,
                    COALESCE(lifetime_spent, false) as lifetime_spent
                FROM user_credits 
                WHERE user_id = @user_id
            `);
        
        if (result.recordset.length === 0) {
            await initializeUserCredits(req.session.userId);
            return res.json({ balance: 100, lifetime_earned: 100, lifetime_spent: 0 });
        }
        
        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get credit transactions
app.get('/api/credits/transactions', isAuthenticated, async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;
    // Validate integers
    const validLimit = validateIntParam(limit, 'limit');
    const validOffset = validateIntParam(offset, 'offset');
    try {
        await poolConnect;
        const result = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('limit', sql.Int, validLimit)
            .input('offset', sql.Int, validOffset)
            .query(`
                SELECT 
                    id,
                    amount,
                    type,
                    description,
                    created_at,
                    CASE 
                        WHEN type IN ('earn', 'bonus', 'refund') THEN '+'
                        WHEN type = 'spend' THEN '-'
                    END as sign
                FROM credit_transactions
                WHERE user_id = @user_id
                ORDER BY created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        
        const countResult = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .query('SELECT COUNT(*) as total FROM credit_transactions WHERE user_id = @user_id');
        
        res.json({
            transactions: result.recordset,
            total: countResult.recordset[0].total
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get credit opportunities
app.get('/api/credits/opportunities', isAuthenticated, async (req, res) => {
    const opportunities = [
        { id: 1, title: "Daily Login Bonus", description: "Log in daily to earn credits", amount: 5, icon: "fa-calendar-day", action: "daily_login", frequency: "daily" },
        { id: 2, title: "Use a Tool", description: "Earn credits for each tool you use", amount: 2, icon: "fa-tools", action: "use_tool", frequency: "per_use" },
        { id: 3, title: "Invite a Friend", description: "Get credits when your friends join", amount: 50, icon: "fa-user-plus", action: "invite_friend", frequency: "one_time" },
        { id: 4, title: "Submit a Tool", description: "Earn credits for submitting new tools", amount: 25, icon: "fa-upload", action: "submit_tool", frequency: "per_submission" },
        { id: 5, title: "Complete Profile", description: "Fill out your profile completely", amount: 30, icon: "fa-user-check", action: "complete_profile", frequency: "one_time" },
        { id: 6, title: "Write a Review", description: "Review tools and earn credits", amount: 10, icon: "fa-star", action: "write_review", frequency: "per_review" }
    ];
    res.json(opportunities);
});

// Claim daily bonus
app.post('/api/credits/claim-daily', isAuthenticated, async (req, res) => {
    try {
        await ensureUserCredits(req.session.userId);
        
        // Check if already claimed today (using NOW() and CURRENT_DATE)
        const lastClaim = await pool.query(`
            SELECT created_at 
            FROM credit_transactions 
            WHERE user_id = $1 
              AND type = 'bonus' 
              AND description LIKE '%Daily login%'
              AND CAST(created_at AS DATE) = CURRENT_DATE
            ORDER BY created_at DESC
            LIMIT 1
        `, [req.session.userId]);
        
        if (lastClaim.rows.length > 0) {
            return res.status(400).json({ error: 'Daily bonus already claimed today' });
        }
        
        const dailyBonus = 5;
        
        // Update user credits
        await pool.query(`
            UPDATE user_credits 
            SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
            WHERE user_id = $2
        `, [dailyBonus, req.session.userId]);
        
        // Insert transaction record
        await pool.query(`
            INSERT INTO credit_transactions (user_id, amount, type, description)
            VALUES ($1, $2, 'bonus', 'Daily login bonus')
        `, [req.session.userId, dailyBonus]);
        
        res.json({ success: true, message: `Claimed ${dailyBonus} credits!` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get spend options (without badge)
app.get('/api/credits/spend-options', isAuthenticated, async (req, res) => {
    const options = [
        { id: 1, title: "Premium Tools Access", description: "Unlock all premium AI tools for 30 days", cost: 500, icon: "fa-crown", duration: "30 days", popular: true, feature: "premium" },
        { id: 2, title: "Advanced Analytics", description: "Get detailed insights and analytics", cost: 200, icon: "fa-chart-line", duration: "7 days", popular: false, feature: "analytics" },
        { id: 3, title: "Priority Support", description: "24/7 priority customer support", cost: 100, icon: "fa-headset", duration: "30 days", popular: false, feature: "support" },
        { id: 4, title: "Featured Profile", description: "Your profile appears in featured section", cost: 300, icon: "fa-star", duration: "7 days", popular: false, feature: "featured" },
        { id: 5, title: "Message Boosts", description: "Highlight your messages in chats (10 uses)", cost: 50, icon: "fa-bolt", duration: "10 uses", popular: false, feature: "boost" }
    ];
    res.json(options);
});

// ==================== REFERRAL SYSTEM ====================
app.get('/api/referrals/stats', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userId = req.session.userId;
        
        const earningsResult = await pool.request()
            .input('user_id', sql.Int, userId)
            .query(`
                SELECT COALESCE(SUM(amount), false) as total 
                FROM credit_transactions 
                WHERE user_id = @user_id AND type = 'earn' AND description LIKE '%Referral%'
            `);
        
        const referralsResult = await pool.request()
            .input('referrer_id', sql.Int, userId)
            .query(`
                SELECT id, username, email, created_at 
                FROM users 
                WHERE referrer_id = @referrer_id
                ORDER BY created_at DESC
            `);
        
        res.json({
            totalEarned: earningsResult.recordset[0]?.total || 0,
            referrals: referralsResult.recordset
        });
    } catch (err) {
        console.error('Referral stats error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/referrals/link', isAuthenticated, async (req, res) => {
    try {
        const username = req.session.username;
        const baseUrl = process.env.FRONTEND_URL || `http://localhost:3000`;
        const referralLink = `${baseUrl}/?ref=${encodeURIComponent(username)}`;
        res.json({ link: referralLink });
    } catch (err) {
        console.error('Referral link error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ========== PREMIUM FEATURES ENDPOINTS ==========
app.get('/api/user/premium-status', isAuthenticated, async (req, res) => {
    try {
        const status = await getPremiumStatus(req.session.userId);
        res.json(status);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/user/use-boost', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.request()
            .input('userId', req.session.userId)
            .query('SELECT message_boosts_remaining FROM users WHERE id = @userId');
        const remaining = result.recordset[0]?.message_boosts_remaining || 0;
        if (remaining <= 0) {
            return res.status(400).json({ error: 'No boosts remaining' });
        }
        await pool.request()
            .input('userId', req.session.userId)
            .query('UPDATE users SET message_boosts_remaining = message_boosts_remaining - 1 WHERE id = @userId');
        res.json({ success: true, remaining: remaining - 1 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
// ==================== UPDATE USER AVATAR STYLE ====================
app.post('/api/user/avatar-style', isAuthenticated, async (req, res) => {
    const { style } = req.body;
    if (!style || typeof style !== 'string') {
        return res.status(400).json({ error: 'Avatar style is required' });
    }
    try {
        await poolConnect;
        await pool.request()
            .input('userId', sql.Int, req.session.userId)
            .input('style', sql.NVarChar, style)
            .query('UPDATE users SET avatar_style = @style WHERE id = @userId');
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating avatar style:', err);
        res.status(500).json({ error: 'Failed to update avatar style' });
    }
});

app.post('/api/messages/boost/:messageId', isAuthenticated, async (req, res) => {
    const messageId = req.params.messageId;
    const userId = req.session.userId;
    try {
        await poolConnect;
        const msg = await pool.request()
            .input('id', messageId)
            .input('userId', userId)
            .query('SELECT sender_id FROM messages WHERE id = @id AND sender_id = @userId');
        if (msg.recordset.length === 0) {
            return res.status(404).json({ error: 'Message not found or not yours' });
        }
        
        const boostsResult = await pool.request()
            .input('userId', userId)
            .query('SELECT message_boosts_remaining FROM users WHERE id = @userId');
        let boostsRemaining = boostsResult.recordset[0]?.message_boosts_remaining || 0;
        
        if (boostsRemaining > 0) {
            await pool.request()
                .input('userId', userId)
                .query('UPDATE users SET message_boosts_remaining = message_boosts_remaining - 1 WHERE id = @userId');
        } else {
            const balanceCheck = await pool.request()
                .input('userId', userId)
                .query('SELECT balance FROM user_credits WHERE user_id = @userId');
            const balance = balanceCheck.recordset[0]?.balance || 0;
            if (balance < 10) {
                return res.status(400).json({ error: 'Insufficient credits (need 10) and no boosts left' });
            }
            await pool.request()
                .input('userId', userId)
                .input('amount', 10)
                .query(`
                    UPDATE user_credits SET balance = balance - @amount WHERE user_id = @userId;
                    INSERT INTO credit_transactions (user_id, amount, type, description)
                    VALUES (@userId, @amount, 'spend', 'Message boost');
                `);
        }
        
        await pool.request()
            .input('id', messageId)
            .query('UPDATE messages SET is_boosted = true WHERE id = @id');
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/referrals/list', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.request()
            .input('referrerId', req.session.userId)
            .query('SELECT id, username, email, created_at FROM users WHERE referrer_id = @referrerId ORDER BY created_at DESC');
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/messages/send', isAuthenticated, async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing fields' });
    try {
        await poolConnect;
        await pool.request()
            .input('sender_id', sql.Int, req.session.userId)
            .input('receiver_id', sql.Int, to)
            .input('content', sql.NVarChar, message)
            .query('INSERT INTO messages (sender_id, receiver_id, content) VALUES (@sender_id, @receiver_id, @content)');
        const toEntry = onlineUsers.get(parseInt(to));
        if (toEntry && toEntry.socketId) {
            io.to(toEntry.socketId).emit('private_message', { from: req.session.userId, message, timestamp: new Date() });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== SUPPORT TICKETS SYSTEM (ENHANCED) ====================

// AI Helper Function for Support
async function getAIResponseForSupport(subject, message, conversationHistory = []) {
    try {
        const prompt = `You are a support assistant for Sraveik . 
        User subject: ${subject}
        User message: ${message}
        Previous conversation: ${JSON.stringify(conversationHistory)}
        Provide a helpful, concise answer. If you cannot answer, say "I cannot answer this. A human moderator will assist you shortly."`;
        
        // Call your existing AI service (Cohere via Spring Boot)
        const response = await fetch('http://localhost:8080/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: prompt })
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "I'm unable to answer right now. A moderator will assist you shortly.";
    } catch (err) {
        console.error('AI support error:', err);
        return "Our AI assistant is currently unavailable. Please click 'Talk to Human' to connect with a moderator.";
    }
}

async function getTicketWithReplies(ticketId, userId, isModOrAdmin) {
    const ticket = await pool.request()
        .input('id', sql.Int, ticketId)
        .query(`
            SELECT t.*, u.username as user_name, u.email as user_email
            FROM support_tickets t
            JOIN users u ON t.user_id = u.id
            WHERE t.id = @id
        `);
    if (ticket.recordset.length === 0) return null;
    const ticketData = ticket.recordset[0];
    if (!isModOrAdmin && ticketData.user_id !== userId) return null;
    
    let replies = [];
    if (ticketData.replies) {
        try { replies = JSON.parse(ticketData.replies); } catch(e) { replies = []; }
    }
    ticketData.replies = replies;
    return ticketData;
}

app.post('/api/support/tickets', isAuthenticated, async (req, res) => {
    const { subject, message } = req.body;
    if (!subject || !message) {
        return res.status(400).json({ error: 'Subject and message are required' });
    }
    try {
        await poolConnect;
        const result = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('subject', sql.NVarChar, subject)
            .input('message', sql.NVarChar, message)
            .query(`
                INSERT INTO support_tickets (user_id, subject, message, replies, status)
                OUTPUT INSERTED.id
                VALUES (@user_id, @subject, @message, '[]', 'open')
            `);
        const ticketId = result.recordset[0].id;
        
        // Generate AI reply
        const aiReplyText = await getAIResponseForSupport(subject, message);
        
        // Store AI reply as a system message
        const aiReply = {
            id: Date.now(),
            message: aiReplyText,
            sender_id: null,
            sender_name: 'Sraveik AI',
            sender_role: 'ai',
            created_at: new Date().toISOString()
        };
        
        await pool.request()
            .input('id', sql.Int, ticketId)
            .input('replies', sql.NVarChar, JSON.stringify([aiReply]))
            .query(`UPDATE support_tickets SET replies = @replies, ai_handled = true WHERE id = @id`);
        
        res.status(201).json({ success: true, ticketId: ticketId, aiReply: aiReplyText });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Escalate to human moderator
app.post('/api/support/tickets/:id/escalate', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        await poolConnect;
        
        // Find ticket
        const ticket = await pool.request()
            .input('id', sql.Int, ticketId)
            .query('SELECT * FROM support_tickets WHERE id = @id');
        if (ticket.recordset.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const ticketData = ticket.recordset[0];
        
        // Check if user is the owner or admin/moderator
        if (ticketData.user_id !== req.session.userId && req.session.role !== 'admin' && req.session.role !== 'moderator') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        // Find a free moderator (role = 'moderator' only, NOT admin)
        const moderator = await pool.request()
            .query(`
                SELECT TOP 1 u.id, u.username, u.email
                FROM users u
                LEFT JOIN moderator_status ms ON u.id = ms.user_id
                WHERE u.role = 'moderator'
                AND (ms.is_online = 1 OR ms.is_online IS NULL)
                ORDER BY ISNULL(ms.current_tickets, 0) ASC
            `);
        
        if (moderator.recordset.length === 0) {
            return res.status(503).json({ error: 'No moderator available. Please try again later.' });
        }
        
        const moderatorId = moderator.recordset[0].id;
        const moderatorName = moderator.recordset[0].username;
        
        // Assign ticket to moderator
        await pool.request()
            .input('id', sql.Int, ticketId)
            .input('assigned_to', sql.Int, moderatorId)
            .input('escalated_at', sql.DateTime, new Date())
            .query(`UPDATE support_tickets SET assigned_to = @assigned_to, escalated_at = @escalated_at, ai_handled = false WHERE id = @id`);
        
        // Update moderator status
        await pool.request()
            .input('user_id', sql.Int, moderatorId)
            .query(`MERGE INTO moderator_status AS target
                    USING (SELECT @user_id AS user_id) AS source
                    ON target.user_id = source.user_id
                    WHEN MATCHED THEN UPDATE SET current_tickets = current_tickets + 1, last_active = NOW()
                    WHEN NOT MATCHED THEN INSERT (user_id, current_tickets) VALUES (@user_id, 1);`);
        
        // Notify moderator via Socket.IO
        const moderatorEntry = onlineUsers.get(moderatorId);
        if (moderatorEntry && moderatorEntry.socketId) {
            io.to(moderatorEntry.socketId).emit('new_support_ticket', {
                ticketId,
                fromUser: req.session.username,
                subject: ticketData.subject
            });
        }

        io.emit('ticket_escalated', { ticketId, subject: ticketData.subject, userId: req.session.userId, username: req.session.username });
        
        // Return the assigned moderator's name
        res.json({ success: true, moderatorName });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
// Get all tickets (admin/moderator sees all, user sees own)
app.get('/api/support/tickets', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userRole = await pool.request()
            .input('userId', sql.Int, req.session.userId)
            .query('SELECT role FROM users WHERE id = @userId');
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.recordset[0]?.role);

        let query;
        if (isModOrAdmin) {
            query = `
                SELECT t.*, u.username as user_name, u.email as user_email
                FROM support_tickets t
                LEFT JOIN users u ON t.user_id = u.id
                ORDER BY t.created_at DESC
            `;
        } else {
            query = `
                SELECT t.*, u.username as user_name, u.email as user_email
                FROM support_tickets t
                LEFT JOIN users u ON t.user_id = u.id
                WHERE t.user_id = @userId
                ORDER BY t.created_at DESC
            `;
        }
        const request = pool.request();
        if (!isModOrAdmin) request.input('userId', sql.Int, req.session.userId);
        const result = await request.query(query);
        
        const tickets = result.recordset.map(t => {
            let replies = [];
            if (t.replies) {
                try { replies = JSON.parse(t.replies); } catch(e) {}
            }
            return { ...t, replies };
        });
        res.json(tickets);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/support/tickets/:id', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        await poolConnect;
        const userRole = await pool.request()
            .input('userId', sql.Int, req.session.userId)
            .query('SELECT role FROM users WHERE id = @userId');
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.recordset[0]?.role);
        
        const ticketData = await getTicketWithReplies(ticketId, req.session.userId, isModOrAdmin);
        if (!ticketData) return res.status(404).json({ error: 'Ticket not found or access denied' });
        res.json(ticketData);
    } catch (err) {
        console.error('Error in /api/support/tickets/:id', err);
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/support/tickets/debug/:id', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        const result = await pool.request()
            .input('id', sql.Int, ticketId)
            .query('SELECT * FROM support_tickets WHERE id = @id');
        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/support/tickets/:id/reply', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    
    try {
        await poolConnect;
        const userRole = await pool.request()
            .input('userId', sql.Int, req.session.userId)
            .query('SELECT role FROM users WHERE id = @userId');
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.recordset[0]?.role);
        
        const ticket = await pool.request()
            .input('id', sql.Int, ticketId)
            .query('SELECT user_id, status, replies, assigned_to FROM support_tickets WHERE id = @id');
        if (ticket.recordset.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const ticketData = ticket.recordset[0];
        
        if (!isModOrAdmin && ticketData.user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Access denied' });
        }
        if (ticketData.status === 'closed') {
            return res.status(400).json({ error: 'Cannot reply to a closed ticket' });
        }
        
        let replies = [];
        if (ticketData.replies) {
            try { replies = JSON.parse(ticketData.replies); } catch(e) { replies = []; }
        }
        
        const newReply = {
            id: replies.length + 1,
            message: message,
            sender_id: req.session.userId,
            sender_name: req.session.username,
            sender_role: isModOrAdmin ? (userRole.recordset[0]?.role || 'moderator') : 'user',
            created_at: new Date().toISOString()
        };
        replies.push(newReply);
        
        // If this is a moderator reply, update assigned_to if not already
        if (isModOrAdmin && !ticketData.assigned_to) {
            await pool.request()
                .input('id', sql.Int, ticketId)
                .input('assigned_to', sql.Int, req.session.userId)
                .input('last_reminder_sent', null)
                .query(`UPDATE support_tickets SET assigned_to = @assigned_to, last_reminder_sent = NULL, replies = @replies, updated_at = NOW() WHERE id = @id`);
        } else {
            await pool.request()
                .input('id', sql.Int, ticketId)
                .input('replies', sql.NVarChar, JSON.stringify(replies))
                .input('last_reminder_sent', null)
                .query(`UPDATE support_tickets SET replies = @replies, last_reminder_sent = NULL, updated_at = NOW() WHERE id = @id`);
        }
        
        // Notify user if reply is from moderator, or notify moderator if reply is from user
        if (isModOrAdmin) {
            const userEntry = onlineUsers.get(ticketData.user_id);
            if (userEntry && userEntry.socketId) io.to(userEntry.socketId).emit('ticket_reply', { ticketId, message });
        } else if (ticketData.assigned_to) {
            const modEntry = onlineUsers.get(ticketData.assigned_to);
            if (modEntry && modEntry.socketId) io.to(modEntry.socketId).emit('ticket_reply', { ticketId, message });
        }
        
        res.json({ success: true, reply: newReply });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Forward ticket to another moderator (reassign)
app.post('/api/support/tickets/:id/forward', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    const { newModeratorId } = req.body;
    if (!newModeratorId) return res.status(400).json({ error: 'New moderator ID required' });
    try {
        await poolConnect;
        // Check current user is admin or the assigned moderator
        const ticket = await pool.request()
            .input('id', sql.Int, ticketId)
            .query('SELECT assigned_to FROM support_tickets WHERE id = @id');
        if (ticket.recordset.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const currentAssigned = ticket.recordset[0].assigned_to;
        if (currentAssigned !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only assigned moderator can forward this ticket' });
        }
        // Verify new moderator exists and has role 'moderator'
        const newMod = await pool.request()
            .input('id', sql.Int, newModeratorId)
            .query('SELECT id FROM users WHERE id = @id AND role = \'moderator\'');
        if (newMod.recordset.length === 0) return res.status(404).json({ error: 'Moderator not found' });
        // Update ticket
        await pool.request()
            .input('id', sql.Int, ticketId)
            .input('assigned_to', sql.Int, newModeratorId)
            .input('escalated_at', sql.DateTime, new Date())
            .query('UPDATE support_tickets SET assigned_to = @assigned_to, escalated_at = @escalated_at WHERE id = @id');
        // Update moderator_status counts
        if (currentAssigned) {
            await pool.request()
                .input('user_id', sql.Int, currentAssigned)
                .query('UPDATE moderator_status SET current_tickets = current_tickets - 1 WHERE user_id = @user_id');
        }
        await pool.request()
            .input('user_id', sql.Int, newModeratorId)
            .query(`MERGE INTO moderator_status AS target
                    USING (SELECT @user_id AS user_id) AS source
                    ON target.user_id = source.user_id
                    WHEN MATCHED THEN UPDATE SET current_tickets = current_tickets + 1, last_active = NOW()
                    WHEN NOT MATCHED THEN INSERT (user_id, current_tickets) VALUES (@user_id, 1);`);
        // Notify new moderator via Socket.IO
        const newModEntry = onlineUsers.get(parseInt(newModeratorId));
        if (newModEntry && newModEntry.socketId) {
            io.to(newModEntry.socketId).emit('new_support_ticket', {
                ticketId,
                fromUser: req.session.username,
                subject: ticket.recordset[0]?.subject || 'Forwarded ticket'
            });
        }
        res.json({ success: true, message: 'Ticket forwarded' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Unassign ticket (put back to unassigned)
app.post('/api/support/tickets/:id/unassign', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        await poolConnect;
        const ticket = await pool.request()
            .input('id', sql.Int, ticketId)
            .query('SELECT assigned_to FROM support_tickets WHERE id = @id');
        if (ticket.recordset.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const currentAssigned = ticket.recordset[0].assigned_to;
        if (currentAssigned !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only assigned moderator can unassign this ticket' });
        }
        await pool.request()
            .input('id', sql.Int, ticketId)
            .query('UPDATE support_tickets SET assigned_to = NULL WHERE id = @id');
        if (currentAssigned) {
            await pool.request()
                .input('user_id', sql.Int, currentAssigned)
                .query('UPDATE moderator_status SET current_tickets = current_tickets - 1 WHERE user_id = @user_id');
        }
        res.json({ success: true, message: 'Ticket unassigned' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/support/tickets/:id/close', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        await poolConnect;
        const userRole = await pool.request()
            .input('userId', sql.Int, req.session.userId)
            .query('SELECT role FROM users WHERE id = @userId');
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.recordset[0]?.role);
        if (!isModOrAdmin) return res.status(403).json({ error: 'Only moderators and admins can close tickets' });
        
        const result = await pool.request()
            .input('id', sql.Int, ticketId)
            .query('UPDATE support_tickets SET status = \'closed\', updated_at = NOW() WHERE id = @id');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Ticket not found' });
        res.json({ success: true, message: 'Ticket closed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/support/tickets/:id', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        await poolConnect;
        const userRole = await pool.request()
            .input('userId', sql.Int, req.session.userId)
            .query('SELECT role FROM users WHERE id = @userId');
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.recordset[0]?.role);
        if (!isModOrAdmin) return res.status(403).json({ error: 'Only moderators and admins can delete tickets' });
        
        const result = await pool.request()
            .input('id', sql.Int, ticketId)
            .query('DELETE FROM support_tickets WHERE id = @id');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Ticket not found' });
        res.json({ success: true, message: 'Ticket deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== MODERATOR REMINDERS CRON JOB ====================
cron.schedule('*/5 * * * *', async () => {
    console.log('🔔 Running moderator reminder cron job...');
    const REMINDER_THRESHOLD_MINUTES = parseInt(process.env.REMINDER_THRESHOLD_MINUTES) || 5;
    const BATCH_LIMIT = parseInt(process.env.REMINDER_BATCH_LIMIT) || 50;

    try {
        // Query stale tickets with a batch limit
        const staleTickets = await pool.query(`
            SELECT t.id, t.subject, t.assigned_to, u.username as moderator_name, u.email as moderator_email,
                   t.escalated_at, t.last_reminder_sent
            FROM support_tickets t
            JOIN users u ON t.assigned_to = u.id
            WHERE t.assigned_to IS NOT NULL
              AND t.status = 'open'
              AND EXTRACT(EPOCH FROM (NOW() - t.escalated_at)) / 60 > $1
              AND (t.last_reminder_sent IS NULL 
                   OR EXTRACT(EPOCH FROM (NOW() - t.last_reminder_sent)) / 60 > $1)
            ORDER BY t.escalated_at ASC
            LIMIT $2
        `, [REMINDER_THRESHOLD_MINUTES, BATCH_LIMIT]);

        if (staleTickets.rows.length === 0) {
            console.log('ℹ️ No stale tickets found.');
            return;
        }

        console.log(`📋 Found ${staleTickets.rows.length} stale tickets to process.`);

        let reminderCount = 0;
        let errorCount = 0;

        for (const ticket of staleTickets.rows) {
            try {
                // Emit Socket.IO reminder to online moderator
                const moderatorEntry = onlineUsers.get(ticket.assigned_to);
                if (moderatorEntry && moderatorEntry.socketId) {
                    io.to(moderatorEntry.socketId).emit('support_reminder', {
                        ticketId: ticket.id,
                        subject: ticket.subject,
                        minutesSince: Math.floor((Date.now() - new Date(ticket.escalated_at).getTime()) / 60000)
                    });
                }

                // Send email reminder
                await sendEmail(
                    ticket.moderator_email,
                    `Support Ticket Reminder #${ticket.id}`,
                    `<p>You have a pending support ticket <strong>#${ticket.id}: "${escapeHtml(ticket.subject)}"</strong> that was escalated ${Math.floor((Date.now() - new Date(ticket.escalated_at).getTime()) / 60000)} minutes ago.</p><p>Please respond soon.</p>`
                );

                // Update last_reminder_sent
                await pool.query(
                    `UPDATE support_tickets SET last_reminder_sent = NOW() WHERE id = $1`,
                    [ticket.id]
                );
                reminderCount++;
                console.log(`✅ Reminder sent for ticket ${ticket.id} to moderator ${ticket.moderator_name} (${ticket.moderator_email})`);
            } catch (err) {
                errorCount++;
                console.error(`❌ Failed to process reminder for ticket ${ticket.id}:`, err.message);
            }
        }

        console.log(`✅ Cron job finished: ${reminderCount} reminders sent, ${errorCount} errors.`);
    } catch (err) {
        console.error('❌ Reminder cron error (query level):', err);
    }
}, { scheduled: true, recoverMissedExecutions: false });


// ==================== STATS, USER STATUS, USAGE ANALYTICS ====================
app.get('/api/stats', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userId = req.session.userId;

        const toolsResult = await pool.request()
            .input('userId', sql.Int, userId)
            .query('SELECT COUNT(*) as count FROM tool_usage WHERE user_id = @userId');
        const toolsUsed = toolsResult.recordset[0].count;

        const friendsResult = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT COUNT(*) as count FROM friendships 
                WHERE (user_id = @userId OR friend_id = @userId) AND status = 'accepted'
            `);
        const friendsCount = friendsResult.recordset[0].count;

        let streak = 0;
        const streakResult = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT DISTINCT CAST(used_at AS DATE) as date
                FROM tool_usage
                WHERE user_id = @userId
                ORDER BY date DESC
            `);
        const dates = streakResult.recordset.map(row => new Date(row.date));
        let expected = new Date();
        expected.setHours(0,0,0,0);
        for (let d of dates) {
            if (d.getTime() === expected.getTime()) {
                streak++;
                expected.setDate(expected.getDate() - 1);
            } else break;
        }

        const creditsResult = await pool.request()
            .input('user_id', sql.Int, userId)
            .query('SELECT balance FROM user_credits WHERE user_id = @user_id');
        const aiCredits = creditsResult.recordset[0]?.balance || 0;

        res.json({ toolsUsed, friendsCount, streak, aiCredits });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/user-status', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, req.session.userId)
            .query('SELECT status FROM users WHERE id = @id');
        const status = result.recordset[0]?.status || 'online';
        res.json({ status });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/usage/analytics', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userId = req.session.userId;
        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT 
                    tool_name as name,
                    COUNT(*) as count
                FROM tool_usage
                WHERE user_id = @userId
                GROUP BY tool_name
                ORDER BY count DESC
            `);
        const tools = result.recordset.map(t => ({
            name: t.name,
            count: t.count,
            totalTime: t.count * 30
        }));
        res.json({ tools });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== FRIEND & NETWORK ENDPOINTS ====================
app.post('/api/friends/request', isAuthenticated, async (req, res) => {
    const { friendUsername } = req.body;
    if (!friendUsername) return res.status(400).send('Username required');
    try {
        await poolConnect;
        const friendResult = await pool.request()
            .input('username', sql.NVarChar, friendUsername)
            .query('SELECT id, email FROM users WHERE username = @username');
        if (friendResult.recordset.length === 0) return res.status(404).send('User not found');
        const friendId = friendResult.recordset[0].id;
        const friendEmail = friendResult.recordset[0].email;
        if (friendId === req.session.userId) return res.status(400).send('Cannot add yourself');

        const existing = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('friend_id', sql.Int, friendId)
            .query(`SELECT * FROM friendships WHERE (user_id = @user_id AND friend_id = @friend_id)
                    OR (user_id = @friend_id AND friend_id = @user_id)`);
        if (existing.recordset.length > 0) {
            const row = existing.recordset[0];
            if (row.status === 'accepted') return res.status(409).send('Already friends');
            if (row.status === 'pending' && row.expires_at > new Date()) {
                return res.status(409).send('Friend request already pending');
            }
            if (row.status === 'pending' && row.expires_at <= new Date()) {
                await pool.request()
                    .input('id', sql.Int, row.id)
                    .query('DELETE FROM friendships WHERE id = @id');
            }
        }

        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('friend_id', sql.Int, friendId)
            .input('expires_at', sql.DateTime, expiresAt)
            .query('INSERT INTO friendships (user_id, friend_id, status, expires_at) VALUES (@user_id, @friend_id, \'pending\', @expires_at)');

        sendFriendRequestEmail(friendEmail, req.session.username).catch(err => console.error('Friend request email failed:', err));
        const friendEntry = onlineUsers.get(friendId);
        if (friendEntry && friendEntry.socketId) io.to(friendEntry.socketId).emit('friend_request_notification', {
            from: req.session.userId,
            fromUsername: req.session.username
        });
        
        // GAMIFICATION: award XP for sending a friend request, update quest, check achievements
        await addXP(req.session.userId, 5, 'Friend request');
        await updateQuestProgress(req.session.userId, 'friend_request');
        await checkAchievements(req.session.userId);
        
        res.send('Friend request sent');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.put('/api/friends/accept/:requestId', isAuthenticated, async (req, res) => {
    const requestId = req.params.requestId;
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, requestId)
            .input('friend_id', sql.Int, req.session.userId)
            .query('UPDATE friendships SET status = \'accepted\' WHERE id = @id AND friend_id = @friend_id AND status = \'pending\'');
        if (result.rowsAffected[0] === 0) return res.status(404).send('Request not found');
        const request = await pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT user_id FROM friendships WHERE id = @id');
        const otherUserId = request.recordset[0]?.user_id;
        if (otherUserId) {
            const otherEntry = onlineUsers.get(otherUserId);
            if (otherEntry && otherEntry.socketId) io.to(otherEntry.socketId).emit('connection_accepted', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }
        res.send('Friend request accepted');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.put('/api/friends/decline/:requestId', isAuthenticated, async (req, res) => {
    const requestId = req.params.requestId;
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, requestId)
            .input('friend_id', sql.Int, req.session.userId)
            .query('UPDATE friendships SET status = \'declined\' WHERE id = @id AND friend_id = @friend_id AND status = \'pending\'');
        if (result.rowsAffected[0] === 0) return res.status(404).send('Request not found');
        res.send('Friend request declined');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/api/friends', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userId = req.session.userId;
        const { status, search } = req.query;
        let query = `
            SELECT u.id, u.username, u.display_name, u.avatar_url, u.status
            FROM friendships f
            JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
            WHERE (f.user_id = @userId OR f.friend_id = @userId)
              AND f.status = 'accepted'
              AND u.id != @userId
        `;
        if (status) query += ` AND u.status = @status`;
        if (search) query += ` AND (u.username LIKE @search OR u.display_name LIKE @search)`;
        const request = pool.request().input('userId', sql.Int, userId);
        if (status) request.input('status', sql.NVarChar, status);
        if (search) request.input('search', sql.NVarChar, `%${search}%`);
        const result = await request.query(query);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends/requests', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userId = req.session.userId;
        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT f.id, u.id as sender_id, u.username, u.display_name, u.avatar_url
                FROM friendships f
                JOIN users u ON f.user_id = u.id
                WHERE f.friend_id = @userId AND f.status = 'pending'
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends/outgoing-requests', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userId = req.session.userId;
        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT f.id, u.id as friend_id, u.username, u.display_name, u.avatar_url
                FROM friendships f
                JOIN users u ON f.friend_id = u.id
                WHERE f.user_id = @userId AND f.status = 'pending'
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/friends/:friendId', isAuthenticated, async (req, res) => {
    const friendId = parseInt(req.params.friendId);
    if (isNaN(friendId)) return res.status(400).send('Invalid friend ID');
    try {
        await poolConnect;
        const result = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('friend_id', sql.Int, friendId)
            .query(`
                DELETE FROM friendships
                WHERE (user_id = @user_id AND friend_id = @friend_id)
                   OR (user_id = @friend_id AND friend_id = @user_id)
            `);
        if (result.rowsAffected[0] === 0) return res.status(404).send('Friend not found');
        res.send('Friend removed');
    } catch (err) {
        console.error('Error deleting friend:', err);
        res.status(500).send('Server error');
    }
});

app.delete('/api/friends/request/:friendId', isAuthenticated, async (req, res) => {
    const friendId = parseInt(req.params.friendId);
    if (isNaN(friendId)) return res.status(400).send('Invalid friend ID');
    try {
        await poolConnect;
        const result = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('friend_id', sql.Int, friendId)
            .query(`
                DELETE FROM friendships
                WHERE user_id = @user_id
                  AND friend_id = @friend_id
                  AND status = 'pending'
            `);
        if (result.rowsAffected[0] === 0) return res.status(404).send('No pending request found');
        res.send('Friend request cancelled');
    } catch (err) {
        console.error('Error cancelling friend request:', err);
        res.status(500).send('Server error');
    }
});

app.get('/api/messages/:friendId', isAuthenticated, async (req, res) => {
    const friendId = req.params.friendId;
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 30;
    try {
        await poolConnect;
        const result = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('friend_id', sql.Int, friendId)
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, limit)
            .query(`
                SELECT * FROM messages
                WHERE (sender_id = @user_id AND receiver_id = @friend_id)
                   OR (sender_id = @friend_id AND receiver_id = @user_id)
                ORDER BY created_at DESC
                OFFSET @offset ROWS
                FETCH NEXT @limit ROWS ONLY
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/messages/read/:friendId', isAuthenticated, async (req, res) => {
    const friendId = req.params.friendId;
    try {
        await poolConnect;
        await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('friend_id', sql.Int, friendId)
            .query(`
                UPDATE messages SET is_read = true
                WHERE receiver_id = @user_id AND sender_id = @friend_id AND is_read = false
            `);
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== NETWORK ENDPOINTS ====================
app.get('/api/network/stats', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userId = req.session.userId;
        const totalRes = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`SELECT COUNT(*) as count FROM friendships WHERE (user_id = @userId OR friend_id = @userId) AND status = 'accepted'`);
        const total = totalRes.recordset[0].count;
        const onlineRes = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT COUNT(*) as count FROM friendships f
                JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
                WHERE (f.user_id = @userId OR f.friend_id = @userId) AND f.status = 'accepted'
                  AND u.id != @userId AND u.status = 'online'
            `);
        const online = onlineRes.recordset[0].count;
        const pendingRes = await pool.request()
            .input('userId', sql.Int, userId)
            .query('SELECT COUNT(*) as count FROM friendships WHERE friend_id = @userId AND status = \'pending\'');
        const requests = pendingRes.recordset[0].count;
        res.json({ total, online, requests });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/network/requests', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT f.id, u.id as user_id, u.username, u.display_name, u.avatar_url, f.created_at
                FROM friendships f
                JOIN users u ON f.user_id = u.id
                WHERE f.friend_id = @userId AND f.status = 'pending'
                ORDER BY f.created_at DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
app.get('/api/trending/professionals', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const result = await pool.query(`
            SELECT id, username, display_name, avatar_url, 
                   'Professional' as profession, 
                   false as is_pro, 
                   false as is_verified
            FROM users
            WHERE id != $1
            ORDER BY RANDOM()
            LIMIT 5
        `, [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/network/unread', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const unread = await pool.request()
            .input('userId', sql.Int, userId)
            .query('SELECT COUNT(*) as count FROM messages WHERE receiver_id = @userId AND is_read = false');
        const pending = await pool.request()
            .input('userId', sql.Int, userId)
            .query('SELECT COUNT(*) as count FROM friendships WHERE friend_id = @userId AND status = \'pending\'');
        const total = unread.recordset[0].count + pending.recordset[0].count;
        res.json({ total });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/network/export', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const result = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT u.username, u.display_name, u.email, u.status
                FROM friendships f
                JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
                WHERE (f.user_id = @userId OR f.friend_id = @userId) AND f.status = 'accepted' AND u.id != @userId
            `);
        const csvRows = [['Username', 'Display Name', 'Email', 'Status']];
        result.recordset.forEach(row => {
            csvRows.push([row.username, row.display_name || '', row.email, row.status]);
        });
        const csv = csvRows.map(row => row.join(',')).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="Sraveik-network.csv"');
        res.send(csv);
    } catch (err) {
        console.error(err);
        res.status(500).send('Export failed');
    }
});

app.delete('/api/network/:friendId', isAuthenticated, async (req, res) => {
    const friendId = parseInt(req.params.friendId);
    if (isNaN(friendId)) return res.status(400).send('Invalid friend ID');
    try {
        await poolConnect;
        const result = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('friend_id', sql.Int, friendId)
            .query(`
                DELETE FROM friendships
                WHERE (user_id = @user_id AND friend_id = @friend_id)
                   OR (user_id = @friend_id AND friend_id = @user_id)
            `);
        if (result.rowsAffected[0] === 0) return res.status(404).send('Connection not found');
        res.send('Connection removed');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/network/accept/:requestId', isAuthenticated, async (req, res) => {
    const requestId = req.params.requestId;
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, requestId)
            .input('friend_id', sql.Int, req.session.userId)
            .query('UPDATE friendships SET status = \'accepted\' WHERE id = @id AND friend_id = @friend_id AND status = \'pending\'');
        if (result.rowsAffected[0] === 0) return res.status(404).send('Request not found');
        const request = await pool.request()
            .input('id', sql.Int, requestId)
            .query('SELECT user_id FROM friendships WHERE id = @id');
        const otherUserId = request.recordset[0]?.user_id;
        if (otherUserId) {
            const otherEntry = onlineUsers.get(otherUserId);
            if (otherEntry && otherEntry.socketId) io.to(otherEntry.socketId).emit('connection_accepted', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }
        res.send('Request accepted');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/network/decline/:requestId', isAuthenticated, async (req, res) => {
    const requestId = req.params.requestId;
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, requestId)
            .input('friend_id', sql.Int, req.session.userId)
            .query('UPDATE friendships SET status = \'declined\' WHERE id = @id AND friend_id = @friend_id AND status = \'pending\'');
        if (result.rowsAffected[0] === 0) return res.status(404).send('Request not found');
        res.send('Request declined');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== USER STATUS UPDATE ====================
app.post('/api/update-status', isAuthenticated, async (req, res) => {
    const { status } = req.body;
    if (!['online', 'away', 'busy', 'offline'].includes(status)) {
        return res.status(400).send('Invalid status');
    }
    try {
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, req.session.userId)
            .input('status', sql.NVarChar, status)
            .query('UPDATE users SET status = @status WHERE id = @id');
        res.send('Status updated');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== ADMIN ROUTES (with moderator view access) ====================
app.get('/admin/users', isAdminOrModerator, async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .query(`
                SELECT id, username, email, role, created_at, is_banned,
                       display_name, avatar_url
                FROM users 
                ORDER BY id
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/admin/users/:id', isAdmin, async (req, res) => {
    const userId = req.params.id;
    if (userId == req.session.userId) return res.status(400).send('Cannot delete yourself');
    try {
        await poolConnect;

        // Delete all dependent records (order matters only for self-referential FKs)
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM user_streak WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM user_daily_quests WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM user_achievements WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM credit_transactions WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM user_credits WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM tool_usage WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM messages WHERE sender_id = @id OR receiver_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM friendships WHERE user_id = @id OR friend_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM group_members WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM group_messages WHERE sender_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM support_tickets WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM user_feedback WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM moderator_activity WHERE moderator_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM tools WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM password_resets WHERE email IN (SELECT email FROM users WHERE id = @id)');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM otp_store WHERE email IN (SELECT email FROM users WHERE id = @id)');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM category_reviews WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM tool_reviews WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM user_events WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM credit_purchases WHERE user_id = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM announcements WHERE created_by = @id');
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM user_notes WHERE user_id = @id OR updated_by = @id');

        // Finally delete the user
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM users WHERE id = @id');

        res.send('User deleted');
    } catch (err) {
        console.error('Admin delete user error:', err);
        res.status(500).send('Server error: ' + err.message);
    }
});

app.patch('/admin/users/:id', isAdmin, async (req, res) => {
    const userId = req.params.id;
    const { role, is_banned } = req.body;
    try {
        const updateFields = [];
        const values = [];
        let paramIndex = 1;
        if (role !== undefined) {
            updateFields.push(`role = $${paramIndex}`);
            values.push(role);
            paramIndex++;
        }
        if (is_banned !== undefined) {
            updateFields.push(`is_banned = $${paramIndex}`);
            // Convert to boolean: true if 1 or true, false otherwise
            values.push(is_banned === true || is_banned === 1 ? true : false);
            paramIndex++;
        }
        if (updateFields.length === 0) {
            return res.status(400).send('No fields to update');
        }
        values.push(userId);
        const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
        await pool.query(query, values);

        // Auto‑enroll into Staff Lounge if role becomes admin or moderator
        if (role && (role === 'admin' || role === 'moderator')) {
            const groupResult = await pool.query(`SELECT id FROM groups WHERE name = 'Staff Lounge'`);
            if (groupResult.rows.length > 0) {
                const groupId = groupResult.rows[0].id;
                await pool.query(`
                    INSERT INTO group_members (group_id, user_id)
                    SELECT $1, $2
                    WHERE NOT EXISTS (SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2)
                `, [groupId, userId]);
                console.log(`User ${userId} added to Staff Lounge after role change to ${role}`);
            }
        }
        res.send('User updated');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/admin/users/:id/toggle', isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        const user = await pool.query('SELECT is_banned FROM users WHERE id = $1', [userId]);
        if (user.rows.length === 0) return res.status(404).send('User not found');
        const currentBanned = user.rows[0].is_banned;
        const newBanned = !currentBanned; // toggle boolean
        await pool.query('UPDATE users SET is_banned = $1 WHERE id = $2', [newBanned, userId]);
        res.send('Status toggled');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send('Email required');
    try {
        const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) return res.status(404).send('No account with that email');

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 10 * 60 * 1000);
        await pool.query(
            'INSERT INTO password_resets (email, otp, expires_at) VALUES ($1, $2, $3)',
            [email, otp, expires]
        );
        const emailSent = await sendPasswordResetOtp(email, otp);
        if (!emailSent.success) {
            console.error('Email send failed:', emailSent.error);
            return res.status(500).send('Failed to send OTP email');
        }
        res.send('OTP sent to email');
    } catch (err) {
        console.error('ERROR at step:', err);
        res.status(500).send('Server error');
    }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).send('All fields are required');

    try {
        // Check OTP (using NOW() which is local time; your expires_at should be stored in same time zone)
        const result = await pool.query(`
            SELECT * FROM password_resets 
            WHERE LOWER(email) = LOWER($1) 
              AND otp = $2 
              AND expires_at > NOW()
        `, [email, otp]);
        if (result.rows.length === 0) return res.status(400).send('Invalid or expired OTP');

        const strength = validatePasswordStrength(newPassword);
        if (!strength.valid) return res.status(400).send(strength.message);

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE LOWER(email) = LOWER($2)', [hashedPassword, email]);

        await pool.query('DELETE FROM password_resets WHERE LOWER(email) = LOWER($1)', [email]);

        res.send('Password reset successfully');
    } catch (err) {
        console.error('Reset error:', err);
        res.status(500).send('Server error');
    }
});
// ==================== USER SEARCH, PROFILE, ETC. ====================
app.get('/api/users/search', isAuthenticated, async (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 2) return res.json([]);
    try {
        await poolConnect;
        const result = await pool.request()
            .input('q', sql.NVarChar, `%${query}%`)
            .input('userId', sql.Int, req.session.userId)
            .query(`
                SELECT id, username, display_name, avatar_url
                FROM users
                WHERE (username LIKE @q OR display_name LIKE @q)
                  AND id != @userId
                ORDER BY username
                OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/profile', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, role FROM users WHERE id = $1',
            [req.session.userId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/profile/full', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, req.session.userId)
            .query(`
                SELECT id, username, display_name, email, bio, phone,
                       github, twitter, linkedin, email_verified,
                       two_factor_enabled, created_at, updated_at,
                       avatar_url
                FROM users WHERE id = @id
            `);
        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/profile/update', isAuthenticated, async (req, res) => {
    const { display_name, bio, phone, github, twitter, linkedin } = req.body;
    try {
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, req.session.userId)
            .input('display_name', sql.NVarChar, display_name || null)
            .input('bio', sql.NVarChar, bio || null)
            .input('phone', sql.NVarChar, phone || null)
            .input('github', sql.NVarChar, github || null)
            .input('twitter', sql.NVarChar, twitter || null)
            .input('linkedin', sql.NVarChar, linkedin || null)
            .query(`
                UPDATE users SET
                    display_name = @display_name,
                    bio = @bio,
                    phone = @phone,
                    github = @github,
                    twitter = @twitter,
                    linkedin = @linkedin,
                    updated_at = NOW()
                WHERE id = @id
            `);
        const updated = await pool.request()
            .input('id', sql.Int, req.session.userId)
            .query(`
                SELECT id, username, display_name, email, bio, phone,
                       github, twitter, linkedin, email_verified,
                       two_factor_enabled, created_at, updated_at,
                       avatar_url
                FROM users WHERE id = @id
            `);
        res.json(updated.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/profile/avatar', isAuthenticated, upload.single('avatar'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded');
    }
    try {
        const avatarUrl = '/uploads/avatars/' + req.file.filename;
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, req.session.userId)
            .input('avatar_url', sql.NVarChar, avatarUrl)
            .query('UPDATE users SET avatar_url = @avatar_url WHERE id = @id');
        res.send('Avatar uploaded successfully');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.put('/profile/password', isAuthenticated, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).send('All fields required');
    
    try {
        // Fetch the user's current password hash
        const result = await pool.query('SELECT password FROM users WHERE id = $1', [req.session.userId]);
        if (result.rows.length === 0) return res.status(404).send('User not found');
        const user = result.rows[0];

        const match = await bcrypt.compare(currentPassword, user.password);
        if (!match) return res.status(401).send('Current password incorrect');
        
        const hashedNew = await bcrypt.hash(newPassword, 10);
        
        // Update password
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedNew, req.session.userId]);
        
        if (req.session.email) {
            sendPasswordChangeNotification(req.session.email, req.session.username)
                .catch(err => console.error('Password change email failed:', err.message));
        }
        res.send('Password changed');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/profile/toggle-2fa', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, req.session.userId)
            .query('UPDATE users SET two_factor_enabled = ~two_factor_enabled WHERE id = @id');
        res.send('2FA setting toggled');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== FIXED DELETE ACCOUNT (Fully functional) ====================
app.delete('/profile/delete', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const userId = req.session.userId;
        const userEmail = req.session.email;
        const username = req.session.username;

        // Delete all related data in correct order (foreign key constraints)
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM messages WHERE sender_id = @userId OR receiver_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM friendships WHERE user_id = @userId OR friend_id = @userId');
        await pool.request().input('email', sql.NVarChar, userEmail).query('DELETE FROM password_resets WHERE email = @email');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM user_credits WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM credit_transactions WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM tool_usage WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM user_achievements WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM user_daily_quests WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM user_streak WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM support_tickets WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM user_feedback WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM moderator_activity WHERE moderator_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM group_messages WHERE sender_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM group_members WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM groups WHERE created_by = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM tools WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM tool_reviews WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM category_reviews WHERE user_id = @userId');
        await pool.request().input('userId', sql.Int, userId).query('DELETE FROM credit_purchases WHERE user_id = @userId');

        // Finally delete the user
        await pool.request().input('id', sql.Int, userId).query('DELETE FROM users WHERE id = @id');

        await sendAccountDeletionAlert({ id: userId, username, email: userEmail });

        req.session.destroy((err) => {
            if (err) console.error(err);
            res.send('Account deleted');
        });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).send('Server error: ' + err.message);
    }
});

// ==================== LEGACY ADMIN BAN / UNBAN ====================
app.put('/api/admin/users/:id/ban', isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, userId)
            .query('UPDATE users SET is_banned = true WHERE id = @id');
        res.send('User banned');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.put('/api/admin/users/:id/unban', isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        await poolConnect;
        await pool.request()
            .input('id', sql.Int, userId)
            .query('UPDATE users SET is_banned = false WHERE id = @id');
        res.send('User unbanned');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== MESSAGE DELETE & CLEAR ====================
app.delete('/api/messages/:messageId', isAuthenticated, async (req, res) => {
    const messageId = req.params.messageId;
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, messageId)
            .input('sender_id', sql.Int, req.session.userId)
            .query('DELETE FROM messages WHERE id = @id AND sender_id = @sender_id');
        if (result.rowsAffected[0] === 0) {
            return res.status(404).send('Message not found or you are not the sender');
        }
        res.send('Message deleted');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.delete('/api/messages/clear/:friendId', isAuthenticated, async (req, res) => {
    const friendId = req.params.friendId;
    try {
        await poolConnect;
        await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('friend_id', sql.Int, friendId)
            .query(`DELETE FROM messages 
                    WHERE (sender_id = @user_id AND receiver_id = @friend_id)
                       OR (sender_id = @friend_id AND receiver_id = @user_id)`);
        res.send('Conversation cleared');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/api/unread', isAuthenticated, async (req, res) => {
    try {
        await poolConnect;
        const unread = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .query(`
                SELECT sender_id as friend_id, COUNT(*) as count
                FROM messages
                WHERE receiver_id = @user_id AND is_read = false
                GROUP BY sender_id
            `);
        const requests = await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .query('SELECT COUNT(*) as count FROM friendships WHERE friend_id = @user_id AND status = \'pending\'');
        res.json({
            unread: unread.recordset,
            pendingRequests: requests.recordset[0].count
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN ANALYTICS ====================
app.get('/api/admin/analytics', isAdmin, async (req, res) => {
    try {
        const totalUsers = await pool.query('SELECT COUNT(*) as count FROM users');
        const activeUsers = await pool.query('SELECT COUNT(*) as count FROM users WHERE is_banned = false');
        const suspendedUsers = await pool.query('SELECT COUNT(*) as count FROM users WHERE is_banned = true');
        
        const weeklyUsage = await pool.query(`
            SELECT DATE(used_at) as date, COUNT(*) as count
            FROM tool_usage
            WHERE used_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(used_at)
            ORDER BY date
        `);
        
        const thisMonth = await pool.query(`SELECT COUNT(*) as count FROM users WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM NOW())`);
        const lastMonth = await pool.query(`SELECT COUNT(*) as count FROM users WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM NOW() - INTERVAL '1 month')`);
        
        const growthRate = lastMonth.rows[0].count > 0 
            ? Math.round(((thisMonth.rows[0].count - lastMonth.rows[0].count) / lastMonth.rows[0].count) * 100)
            : 100;
        
        res.json({
            totalUsers: totalUsers.rows[0].count,
            activeUsers: activeUsers.rows[0].count,
            suspendedUsers: suspendedUsers.rows[0].count,
            growthRate: growthRate,
            weeklyUsage: weeklyUsage.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});


app.get('/api/admin/analytics/top-tools', isAdmin, async (req, res) => {
    try {
        const topTools = await pool.query(`
            SELECT t.name, COUNT(u.id) as count
            FROM tools t
            LEFT JOIN tool_usage u ON t.name = u.tool_name
            WHERE t.approved = true
            GROUP BY t.name
            ORDER BY count DESC
            LIMIT 10
        `);
        const totalTools = await pool.query(`SELECT COUNT(*) as count FROM tools WHERE approved = true`);
        const pendingTools = await pool.query(`SELECT COUNT(*) as count FROM tools WHERE approved = false OR approved IS NULL`);
        const avgPerUser = await pool.query(`
            SELECT 
                CASE WHEN COUNT(DISTINCT user_id) > 0 
                THEN ROUND(CAST(COUNT(*) AS DECIMAL) / COUNT(DISTINCT user_id), 2)
                ELSE 0 END as avg
            FROM tool_usage
        `);
        res.json({
            tools: topTools.rows,
            totalTools: totalTools.rows[0]?.count || 0,
            pendingTools: pendingTools.rows[0]?.count || 0,
            avgToolsPerUser: avgPerUser.rows[0]?.avg || 0
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});



app.get('/api/admin/analytics/category-distribution', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT category, COUNT(*) as count
            FROM tools
            WHERE approved = true AND category IS NOT NULL
            GROUP BY category
            ORDER BY count DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});



app.get('/api/analytics/user-activity', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const { days = 30 } = req.query;
        const daysInt = parseInt(days);
        const daily = await pool.query(`
            SELECT DATE(used_at) as date, COUNT(*) as count
            FROM tool_usage
            WHERE user_id = $1 AND used_at >= NOW() - $2 * INTERVAL '1 day'
            GROUP BY DATE(used_at)
            ORDER BY date
        `, [userId, daysInt]);
        const categories = await pool.query(`
            SELECT tool_category, COUNT(*) as count
            FROM tool_usage
            WHERE user_id = $1 AND tool_category IS NOT NULL
            GROUP BY tool_category ORDER BY count DESC
        `, [userId]);
        const stats = await pool.query(`
            SELECT COUNT(*) as total_uses, MIN(used_at) as first_use, MAX(used_at) as last_use
            FROM tool_usage WHERE user_id = $1
        `, [userId]);
        res.json({
            daily_usage: daily.rows,
            favorite_categories: categories.rows,
            total_uses: stats.rows[0]?.total_uses || 0,
            first_activity: stats.rows[0]?.first_use,
            last_activity: stats.rows[0]?.last_use
        });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/analytics/submission-trend', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM tools
            WHERE approved = true AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/activity', isAdmin, async (req, res) => {
    try {
        const approvals = await pool.query(`
            SELECT 'Approved tool: ' || name as action, submitted_at as time, 'fa-check-circle' as icon
            FROM tools
            WHERE approved = true
            ORDER BY submitted_at DESC
            LIMIT 10
        `);
        res.json(approvals.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== USER ANALYTICS FEATURES ====================
app.get('/api/analytics/user-activity', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const { days = 30 } = req.query;
        const daysInt = parseInt(days);
        
        const daily = await pool.query(`
            SELECT 
                DATE(used_at) as date,
                COUNT(*) as count
            FROM tool_usage
            WHERE user_id = $1
                AND used_at >= NOW() - $2 * INTERVAL '1 day'
            GROUP BY DATE(used_at)
            ORDER BY date
        `, [userId, daysInt]);
        
        const categories = await pool.query(`
            SELECT 
                tool_category,
                COUNT(*) as count
            FROM tool_usage
            WHERE user_id = $1 AND tool_category IS NOT NULL
            GROUP BY tool_category
            ORDER BY count DESC
        `, [userId]);
        
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_uses,
                MIN(used_at) as first_use,
                MAX(used_at) as last_use
            FROM tool_usage
            WHERE user_id = $1
        `, [userId]);
        
        res.json({
            daily_usage: daily.rows,
            favorite_categories: categories.rows,
            total_uses: stats.rows[0]?.total_uses || 0,
            first_activity: stats.rows[0]?.first_use,
            last_activity: stats.rows[0]?.last_use
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
app.get('/api/analytics/trending-tools', isAuthenticated, async (req, res) => {
    try {
        const { period = 'week', limit = 10 } = req.query;
        let interval = period === 'week' ? '7 days' : period === 'month' ? '30 days' : '365 days';
        const limitVal = Math.min(parseInt(limit), 100);
        const result = await pool.query(`
            SELECT tool_name as name, COUNT(*) as usage_count, COUNT(DISTINCT user_id) as unique_users
            FROM tool_usage WHERE used_at >= NOW() - $1::INTERVAL
            GROUP BY tool_name ORDER BY usage_count DESC LIMIT $2
        `, [interval, limitVal]);
        res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});


app.get('/api/analytics/user-stats', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const tools = await pool.query(`
            SELECT COUNT(*) as total_uses, COUNT(DISTINCT tool_name) as unique_tools,
                   COUNT(DISTINCT DATE(used_at)) as active_days
            FROM tool_usage WHERE user_id = $1
        `, [userId]);
        const credits = await pool.query(`
            SELECT COALESCE(balance, false) as current_balance, COALESCE(lifetime_earned, false) as total_earned,
                   COALESCE(lifetime_spent, false) as total_spent
            FROM user_credits WHERE user_id = $1
        `, [userId]);
        const friends = await pool.query(`
            SELECT COUNT(*) as total_friends
            FROM friendships WHERE (user_id = $1 OR friend_id = $1) AND status = 'accepted'
        `, [userId]);
        const messages = await pool.query(`
            SELECT COUNT(*) as total_messages,
                   SUM(CASE WHEN is_read = false AND receiver_id = $1 THEN 1 ELSE 0 END) as unread_count
            FROM messages WHERE sender_id = $1 OR receiver_id = $1
        `, [userId]);
        res.json({
            tools: {
                total_uses: tools.rows[0]?.total_uses || 0,
                unique_tools: tools.rows[0]?.unique_tools || 0,
                active_days: tools.rows[0]?.active_days || 0
            },
            credits: {
                current_balance: credits.rows[0]?.current_balance || 0,
                total_earned: credits.rows[0]?.total_earned || 0,
                total_spent: credits.rows[0]?.total_spent || 0
            },
            social: {
                total_friends: friends.rows[0]?.total_friends || 0,
                total_messages: messages.rows[0]?.total_messages || 0,
                unread_messages: messages.rows[0]?.unread_count || 0
            }
        });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/analytics/usage-by-category', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const result = await pool.query(`
            SELECT tool_category as category, COUNT(*) as count, COUNT(DISTINCT tool_name) as unique_tools
            FROM tool_usage WHERE user_id = $1 AND tool_category IS NOT NULL
            GROUP BY tool_category ORDER BY count DESC
        `, [userId]);
        res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});
// ==================== TOP USERS (most active tool users, 48h cache) ==================
// Public endpoint – does not require authentication
// ==================== TOP USERS (by LEVEL & XP) ====================
app.get('/api/top-users', async (req, res) => {
    const limit = parseInt(req.query.limit) || 5;
    try {
        const result = await pool.query(`
            SELECT
                u.username,
                u.level,
                u.xp,
                u.avatar_url,
                u.display_name,
                u.id
            FROM users u
            WHERE u.is_banned = false
            ORDER BY u.level DESC, u.xp DESC
            LIMIT $1
        `, [limit]);
        const users = result.rows || [];
        res.json(users);
    } catch (err) {
        console.error('❌ Error fetching top users by level:', err);
        res.status(200).json([]);
    }
});
// ==================== AI TOOL RECOMMENDATIONS (Collaborative Filtering) ====================
app.get('/api/recommendations/:toolName', isAuthenticated, async (req, res) => {
    const { toolName } = req.params;
    const limit = parseInt(req.query.limit) || 5;
    try {
        await poolConnect;
        const result = await pool.request()
            .input('toolName', sql.NVarChar, toolName)
            .input('limit', sql.Int, limit)
            .query(`
                SELECT TOP (@limit) t2.tool_name, COUNT(*) as affinity
                FROM tool_usage t1
                JOIN tool_usage t2 ON t1.user_id = t2.user_id AND t1.tool_name != t2.tool_name
                WHERE t1.tool_name = @toolName
                GROUP BY t2.tool_name
                ORDER BY affinity DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error('Recommendations error:', err);
        res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
});

// ==================== GROUP CHAT ENDPOINTS (Already added above) ====================
// The endpoints are already included before the public routes section.
// They remain untouched.

// ==================== USER PREFERENCES TABLE (Optional) ====================


// ==================== MODERATOR FEATURES ====================


app.post('/api/activity-log', isAuthenticated, async (req, res) => {
    const { action, target, details } = req.body;
    try {
        await poolConnect;
        await pool.request()
            .input('moderator_id', sql.Int, req.session.userId)
            .input('moderator_name', sql.NVarChar, req.session.username)
            .input('action', sql.NVarChar, action)
            .input('target', sql.NVarChar, target || '')
            .input('details', sql.NVarChar, details || '')
            .query(`INSERT INTO moderator_activity (moderator_id, moderator_name, action, target, details) VALUES (@moderator_id, @moderator_name, @action, @target, @details)`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/activity-log', isAdminOrModerator, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM moderator_activity ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});



app.get('/api/user-notes/:userId', isAdminOrModerator, async (req, res) => {
    const userId = req.params.userId;
    try {
        await poolConnect;
        const result = await pool.request()
            .input('user_id', sql.Int, userId)
            .query(`SELECT notes FROM user_notes WHERE user_id = @user_id ORDER BY updated_at DESC`);
        res.json(result.recordset[0]?.notes || '');
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user-notes/:userId', isAdminOrModerator, async (req, res) => {
    const userId = req.params.userId;
    const { notes } = req.body;
    try {
        await poolConnect;
        await pool.request()
            .input('user_id', sql.Int, userId)
            .input('notes', sql.NVarChar, notes)
            .input('updated_by', sql.Int, req.session.userId)
            .query(`
                MERGE INTO user_notes AS target
                USING (SELECT @user_id AS user_id) AS source
                ON target.user_id = source.user_id
                WHEN MATCHED THEN UPDATE SET notes = @notes, updated_by = @updated_by, updated_at = NOW()
                WHEN NOT MATCHED THEN INSERT (user_id, notes, updated_by) VALUES (@user_id, @notes, @updated_by);
            `);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});



app.post('/api/users/:id/suspend', isAdminOrModerator, async (req, res) => {
    const userId = req.params.id;
    const { days } = req.body;
    const suspendedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    try {
        await pool.query(
            'UPDATE users SET is_suspended = true, suspended_until = $1 WHERE id = $2',
            [suspendedUntil, userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users/:id/unsuspend', isAdminOrModerator, async (req, res) => {
    const userId = req.params.id;
    try {
        await pool.query(
            'UPDATE users SET is_suspended = false, suspended_until = NULL WHERE id = $1',
            [userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/:id/activity', isAdminOrModerator, async (req, res) => {
    const userId = req.params.id;
    try {
        const toolUsage = await pool.query(
            `SELECT 'Used tool' as action, tool_name as details, used_at as time FROM tool_usage WHERE user_id = $1`,
            [userId]
        );
        const tickets = await pool.query(
            `SELECT 'Created ticket' as action, subject as details, created_at as time FROM support_tickets WHERE user_id = $1`,
            [userId]
        );
        // For replies, we need to parse the JSON array in 'replies' column.
        // Assuming 'replies' is a JSON array of objects with 'message' and 'created_at'.
        // PostgreSQL can unnest jsonb.
        const replies = await pool.query(`
            SELECT 'Replied to ticket' as action, 
                   r->>'message' as details, 
                   (r->>'created_at')::timestamp as time
            FROM support_tickets, jsonb_array_elements(CASE WHEN replies IS NULL THEN '[]'::jsonb ELSE replies::jsonb END) AS r
            WHERE user_id = $1
        `, [userId]);

        const all = [...toolUsage.rows, ...tickets.rows, ...replies.rows];
        all.sort((a, b) => new Date(b.time) - new Date(a.time));
        res.json(all);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tools/:id/recommend', isAdminOrModerator, async (req, res) => {
    const toolId = req.params.id;
    try {
        console.log(`Moderator ${req.session.username} recommended tool ${toolId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/announcements', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/announcements', isAdminOrModerator, async (req, res) => {
    const { title, content } = req.body;
    try {
        await pool.query(
            'INSERT INTO announcements (title, content, created_by) VALUES ($1, $2, $3)',
            [title, content, req.session.userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/announcements/:id', isAdminOrModerator, async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/support/tickets/bulk-close', isAdminOrModerator, async (req, res) => {
    const { ticketIds } = req.body;
    if (!ticketIds || !ticketIds.length) return res.status(400).json({ error: 'No tickets selected' });
    try {
        for (const id of ticketIds) {
            await pool.query('UPDATE support_tickets SET status = $1 WHERE id = $2', ['closed', id]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/support/tickets/bulk-delete', isAdminOrModerator, async (req, res) => {
    const { ticketIds } = req.body;
    if (!ticketIds || !ticketIds.length) return res.status(400).json({ error: 'No tickets selected' });
    try {
        for (const id of ticketIds) {
            await pool.query('DELETE FROM support_tickets WHERE id = $1', [id]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/moderator-stats', isAdminOrModerator, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM moderator_activity WHERE action = 'Replied to ticket' AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM NOW())) as replies,
                (SELECT COUNT(*) FROM moderator_activity WHERE action = 'Closed ticket' AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM NOW())) as closures,
                (SELECT COUNT(*) FROM moderator_activity WHERE action = 'Added user note' AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM NOW())) as notes
        `);
        res.json(stats.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== GAMIFICATION API ENDPOINTS ====================

/**
 * GET /api/gamification/status
 * Returns the user's current level, XP, streak, daily quests, and achievements.
 */
// ==================== GAMIFICATION API ENDPOINTS ====================
// ==================== GAMIFICATION API ENDPOINTS ====================
app.get('/api/gamification/status', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    try {
        const user = await pool.request()
            .input('userId', sql.Int, userId)
            .query('SELECT level, xp, total_xp_earned FROM users WHERE id = @userId');
        if (!user.recordset[0]) return res.status(404).json({ error: 'User not found' });
        
        const level = user.recordset[0].level;
        const currentXP = user.recordset[0].xp;
        const nextLevelXP = xpForLevel(level + 1);
        const progress = (currentXP - xpForLevel(level)) / (nextLevelXP - xpForLevel(level)) * 100;
        
        const streak = await pool.request()
            .input('userId', sql.Int, userId)
            .query('SELECT current_streak, longest_streak, multiplier FROM user_streak WHERE user_id = @userId');
        
        const dailyQuests = await getDailyQuests(userId);
        
        const achievements = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`
                SELECT a.id, a.name, a.description, a.icon, a.xp_reward, ua.earned_at
                FROM achievements a
                LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = @userId
            `);
        
        res.json({
            level,
            xp: currentXP,
            totalXP: user.recordset[0].total_xp_earned,
            nextLevelXP,
            progress: Math.min(100, Math.max(0, progress)),
            streak: streak.recordset[0] || { current_streak: 0, longest_streak: 0, multiplier: 1 },
            dailyQuests: dailyQuests.map(q => ({
                id: q.id,
                name: q.name,
                description: q.description,
                progress: q.progress || 0,
                target: q.target_count,
                completed: q.completed === 1,
                xpReward: q.xp_reward,
                creditsReward: q.credits_reward
            })),
            achievements: achievements.recordset.map(a => ({
                id: a.id,
                name: a.name,
                description: a.description,
                icon: a.icon,
                earned: a.earned_at !== null,
                xpReward: a.xp_reward
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/gamification/leaderboard', async (req, res) => {
    const { limit = 20 } = req.query;
    const limitValue = Math.min(parseInt(limit), 100);
    try {
        const result = await pool.query(`
            SELECT u.id, u.username, u.level, u.xp, u.avatar_url,
                RANK() OVER (ORDER BY u.xp DESC) as rank
            FROM users u
            WHERE u.is_banned = false
            ORDER BY u.xp DESC
            LIMIT $1
        `, [limitValue]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
/**
 * GET /api/gamification/leaderboard
 * Returns the top users by XP (unauthenticated).
 */
app.get('/api/gamification/leaderboard', async (req, res) => {
    const { limit = 20 } = req.query;
    try {
        const result = await pool.request()
            .input('limit', sql.Int, Math.min(parseInt(limit), 100))
            .query(`
                SELECT TOP (@limit) u.id, u.username, u.level, u.xp, u.avatar_url,
                    RANK() OVER (ORDER BY u.xp DESC) as rank
                FROM users u
                WHERE u.is_banned = false
                ORDER BY u.xp DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
// ==================== CLAIM QUEST ENDPOINT ====================
// ==================== CLAIM QUEST ENDPOINT ====================
app.post('/api/quests/:questId/claim', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    const questId = parseInt(req.params.questId);
    const today = new Date().toISOString().slice(0, 10);
    try {
        const questRow = await pool.query(`
            SELECT uqd.progress, uqd.completed, uqd.claimed, q.xp_reward, q.credits_reward, q.name
            FROM user_daily_quests uqd
            JOIN daily_quests q ON uqd.quest_id = q.id
            WHERE uqd.user_id = $1 AND uqd.quest_id = $2 AND uqd.date = $3
        `, [userId, questId, today]);

        if (questRow.rows.length === 0) {
            return res.status(404).json({ error: 'Quest not found for today' });
        }
        const quest = questRow.rows[0];
        if (!quest.completed) {
            return res.status(400).json({ error: 'Quest not yet completed' });
        }
        if (quest.claimed) {
            return res.status(400).json({ error: 'Quest already claimed' });
        }

        // Award XP and update level
        await addXP(userId, quest.xp_reward, `Daily quest: ${quest.name}`);

        // Add credits
        await pool.query(
            'UPDATE user_credits SET balance = balance + $1 WHERE user_id = $2',
            [quest.credits_reward, userId]
        );
        await pool.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'earn', $3)`,
            [userId, quest.credits_reward, `Claimed quest: ${quest.name}`]
        );

        // Mark as claimed
        await pool.query(
            `UPDATE user_daily_quests SET claimed = true 
             WHERE user_id = $1 AND quest_id = $2 AND date = $3`,
            [userId, questId, today]
        );

        // Notify frontend
        const userEntry = onlineUsers.get(userId);
        if (userEntry && userEntry.socketId) {
            io.to(userEntry.socketId).emit('quest_claimed', {
                questId,
                name: quest.name,
                xp: quest.xp_reward,
                credits: quest.credits_reward
            });
        }

        res.json({
            success: true,
            message: `Claimed ${quest.name}! +${quest.xp_reward} XP, +${quest.credits_reward} credits`
        });
    } catch (err) {
        console.error('Claim error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== DATABASE INITIALIZATION (GAMIFICATION TABLES) ====================

// ==================== USER FEEDBACK SYSTEM ==================
// Create table if not exists


// Submit feedback endpoint
app.post('/api/feedback', isAuthenticated, async (req, res) => {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    try {
        await poolConnect;
        await pool.request()
            .input('user_id', sql.Int, req.session.userId)
            .input('rating', sql.Int, rating)
            .input('comment', sql.NVarChar, comment || null)
            .query('INSERT INTO user_feedback (user_id, rating, comment) VALUES (@user_id, @rating, @comment)');
        res.json({ success: true, message: 'Thank you for your feedback!' });
    } catch (err) {
        console.error('Feedback error:', err);
        res.status(500).json({ error: 'Failed to save feedback' });
    }
});

// ==================== GET USER FEEDBACK (ADMIN ONLY) ====================
app.get('/api/admin/feedback', isAdmin, async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request().query(`
            SELECT f.id, f.rating, f.comment, f.created_at,
                   u.id as user_id, u.username, u.email
            FROM user_feedback f
            JOIN users u ON f.user_id = u.id
            ORDER BY f.created_at DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        console.error('Error fetching feedback:', err);
        res.status(500).json({ error: 'Failed to fetch feedback' });
    }
});

// ==================== FRONTEND ROUTE ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== ADD is_featured COLUMN TO TOOLS TABLE ====================


// ==================== ADD GROUPS AND RELATED TABLES (IF MISSING) ====================


// ==================== CSRF TOKEN ENDPOINT ====================
app.get('/api/csrf-token', (req, res) => {
    // In production, generate a real CSRF token. For development, a dummy.
    const token = require('crypto').randomBytes(32).toString('hex');
    req.session.csrfToken = token;
    res.json({ csrfToken: token });
});

// ==================== START SERVER ====================
// ==================== HEALTH CHECK ENDPOINT ====================
app.get('/health', (req, res) => res.status(200).send('OK'));

// ==================== DATABASE CONNECTION TEST (optional) ====================
(async () => {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ Database connection verified');
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        process.exit(1); // Do not start if DB is unreachable
    }
})();

// ==================== START SERVER WITH ENHANCED LOGGING ====================
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`🚀 Server running at http://${HOST}:${PORT}/`);
    console.log(`📧 Email service ready`);
    console.log(`⭐ Credits system active (atomic spends, PhonePe purchases)`);
    console.log(`👥 Referral system active`);
    console.log(`🛠️ Tool approval system active`);
    console.log(`📊 Enhanced user analytics active`);
    console.log(`💎 Premium features ready (stacking purchases)`);
    console.log(`🎫 Support ticket system active (AI-first with moderator escalation)`);
    console.log(`📝 Moderator features active`);
    console.log(`🏅 Custom badge system active`);
    console.log(`💳 Real-money credit purchases enabled (PhonePe)`);
    console.log(`🤖 AI tool recommendations active`);
    console.log(`👥 Group chat endpoints active (history, members, add/remove/leave)`);
    console.log(`📈 Real-time admin stats via Socket.IO active`);
    console.log(`🎮 Gamification system active (XP, levels, streaks, daily quests, achievements)`);
    console.log(`⭐ Leaderboard endpoint available at /api/gamification/leaderboard`);
    console.log(`✅ Admin can add featured tools (is_featured flag) which appear on main page`);
    console.log(`✅ Username uniqueness check fixed during registration`);
    console.log(`✅ Account deletion fully fixed with cascade deletion of all related data`);
    console.log(`✅ CSRF token endpoint added for state‑changing requests`);
});

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
// ==================== WEEKLY DIGEST CRON ====================
cron.schedule('0 9 * * 1', async () => {
    console.log('📧 Running weekly digest cron job...');
    try {
        await poolConnect;
        const users = await pool.request().query('SELECT id, username, email FROM users');
        for (const user of users.recordset) {
            let newToolsCount = 0;
            try {
                const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                const newToolsResult = await pool.request()
                    .input('weekAgo', sql.DateTime, weekAgo)
                    .query('SELECT COUNT(*) as count FROM tools WHERE created_at >= @weekAgo');
                newToolsCount = newToolsResult.recordset[0].count;
            } catch (err) { }

            const pendingResult = await pool.request()
                .input('userId', sql.Int, user.id)
                .query('SELECT COUNT(*) as count FROM friendships WHERE friend_id = @userId AND status = \'pending\'');
            const pendingRequestsCount = pendingResult.recordset[0].count;

            const unreadResult = await pool.request()
                .input('userId', sql.Int, user.id)
                .query('SELECT COUNT(*) as count FROM messages WHERE receiver_id = @userId AND is_read = false');
            const unreadMessagesCount = unreadResult.recordset[0].count;

            await sendWeeklyDigest(user.email, user.username, newToolsCount, pendingRequestsCount, unreadMessagesCount);
        }
        console.log('✅ Weekly digest cron job finished');
    } catch (err) {
        console.error('❌ Error in weekly digest cron job:', err);
    }
});