require('dotenv').config();

// ==================== ENVIRONMENT CHECKS ====================
if (process.env.NODE_ENV === 'production' && (process.env.SESSION_SECRET?.length || 0) < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
}

console.log('Google Client ID:', process.env.GOOGLE_CLIENT_ID);
console.log('Google Callback URL:', process.env.GOOGLE_CALLBACK_URL);

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const sharedsession = require('express-socket.io-session');
const { pool } = require('./database');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const zxcvbn = require('zxcvbn');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { fileTypeFromBuffer } = require('file-type');
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

// ==================== EMAIL CONFIGURATION ====================
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
            from: process.env.EMAIL_USER || 'noreply@Sarveik.com',
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

// ==================== BUSINESS EMAIL NOTIFICATIONS ====================
async function sendBusinessApprovalEmail(to, userName, businessName, creditsEarned = 15) {
    const subject = `✅ Your business "${businessName}" has been approved!`;
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 10px;">
            <div style="background: white; padding: 30px; border-radius: 10px;">
                <h2 style="color: #667eea;">Business Approved! 🎉</h2>
                <p>Dear ${escapeHtml(userName || 'Valued User')},</p>
                <p>Great news! Your business listing <strong>"${escapeHtml(businessName)}"</strong> has been <strong style="color: #10b981;">APPROVED</strong> by our admin team.</p>
                <div style="background: #f0fdf4; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 0; color: #166534;">✨ You have earned <strong style="font-size: 20px;">${creditsEarned} CREDITS</strong> for this submission!</p>
                </div>
                <p>Your business is now visible on the Sarveik Directory.</p>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/businessdirectory.html" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; margin-top: 20px;">View Directory</a>
                <p style="margin-top: 20px; font-size: 12px; color: #666;">Thank you for contributing to Sarveik!</p>
            </div>
        </div>
    `;
    return sendEmail(to, subject, html);
}

async function sendBusinessRejectionEmail(to, userName, businessName, reason = null) {
    const subject = `❌ Update on your business submission "${businessName}"`;
    const reasonText = reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : '<p>Please ensure all information is accurate and complete before resubmitting.</p>';
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 10px;">
            <div style="background: white; padding: 30px; border-radius: 10px;">
                <h2 style="color: #ef4444;">Business Submission Update</h2>
                <p>Dear ${escapeHtml(userName || 'Valued User')},</p>
                <p>Thank you for submitting your business <strong>"${escapeHtml(businessName)}"</strong> to the Sarveik Directory.</p>
                <div style="background: #fef2f2; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 0; color: #991b1b;">After careful review, our admin team has decided <strong>not to approve</strong> this business at this time.</p>
                    ${reasonText}
                </div>
                <p>You can submit a new business with corrections anytime.</p>
                <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/businessdirectory.html" style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; margin-top: 20px;">Submit Again</a>
                <p style="margin-top: 20px; font-size: 12px; color: #666;">We appreciate your contribution to Sarveik!</p>
            </div>
        </div>
    `;
    return sendEmail(to, subject, html);
}

async function sendToolSubmissionAlert(details) {
    try {
        const admins = await pool.query("SELECT email, username FROM users WHERE role = 'admin'");
        for (let admin of admins.rows) {
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
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(`https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

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

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api/phonepe-webhook', express.raw({ type: 'application/json' }));
app.use(express.static('public'));

// ==================== SESSION MIDDLEWARE ====================
const sessionMiddleware = session({
    store: new pgSession({
        pool: pool,
        tableName: 'session',
        createTableIfMissing: true
    }),
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
const otpVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => {
        if (req.body.email) return req.body.email;
        return ipKeyGenerator(req);
    },
    message: 'Too many OTP verification attempts, please try again later.'
});

// ==================== SETUP MONETIZATION TABLES ====================
async function setupMonetizationTables() {
    try {
        await pool.query(`
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
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sponsored_packages (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                duration_days INT,
                price DECIMAL(10,2),
                position_priority INT,
                features JSONB
            )
        `);
        
        const pkgCheck = await pool.query('SELECT COUNT(*) FROM sponsored_packages');
        if (parseInt(pkgCheck.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO sponsored_packages (name, duration_days, price, position_priority, features) VALUES
                ('Basic Spotlight', 30, 1499, 2, '{"impressions": 5000, "badge": "Sponsored"}'::jsonb),
                ('Premium Featured', 30, 4999, 1, '{"impressions": 20000, "badge": "⭐ Featured Sponsor", "custom_message": true}'::jsonb),
                ('Enterprise Dominance', 30, 14999, 0, '{"impressions": 100000, "badge": "👑 Official Partner", "custom_message": true, "homepage_banner": true}'::jsonb)
            `);
        }
        
        await pool.query(`
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
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS affiliate_clicks (
                id SERIAL PRIMARY KEY,
                affiliate_link_id INT REFERENCES affiliate_links(id),
                user_id INT REFERENCES users(id),
                ip_address INET,
                user_agent TEXT,
                referrer TEXT,
                clicked_at TIMESTAMP DEFAULT NOW(),
                session_id VARCHAR(100)
            )
        `);
        
        await pool.query(`
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
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS business_affiliate_settings (
                business_id INT REFERENCES businesses(id) PRIMARY KEY,
                auto_approve_conversions BOOLEAN DEFAULT false,
                notification_email BOOLEAN DEFAULT true,
                min_payout_amount DECIMAL(10,2) DEFAULT 1000,
                tracking_days INT DEFAULT 30,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        console.log('✅ Monetization tables setup complete');
    } catch (err) {
        console.error('Error setting up monetization tables:', err);
    }
}

// Call setup function
setupMonetizationTables();

// ==================== STAFF LOUNGE ====================
async function ensureStaffLoungeGroup() {
    try {
        await pool.query(`
            INSERT INTO groups (name, created_by)
            SELECT 'Staff Lounge', 1
            WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = 'Staff Lounge')
        `);
        const groupRes = await pool.query(`SELECT id FROM groups WHERE name = 'Staff Lounge'`);
        if (groupRes.rows.length === 0) return;
        const groupId = groupRes.rows[0].id;
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

async function addXP(userId, amount, source) {
    try {
        await pool.query(
            'UPDATE users SET xp = xp + $1, total_xp_earned = total_xp_earned + $1 WHERE id = $2',
            [amount, userId]
        );
        await pool.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'xp', $3)`,
            [userId, amount, source]
        );
        await checkLevelUp(userId);
    } catch (err) {
        console.error('addXP error:', err);
    }
}

async function checkLevelUp(userId) {
    try {
        const user = await pool.query(
            'SELECT level, xp FROM users WHERE id = $1',
            [userId]
        );
        if (!user.rows[0]) return;
        let { level, xp } = user.rows[0];
        let newLevel = level;
        while (xp >= xpForLevel(newLevel + 1)) {
            newLevel++;
        }
        if (newLevel > level) {
            await pool.query(
                'UPDATE users SET level = $1 WHERE id = $2',
                [newLevel, userId]
            );
            const socketInfo = onlineUsers.get(userId);
            if (socketInfo?.socketId) {
                io.to(socketInfo.socketId).emit('level_up', { oldLevel: level, newLevel });
            }
        }
    } catch (err) {
        console.error('checkLevelUp error:', err);
    }
}

async function grantLevelRewards(userId, oldLevel, newLevel) {
    try {
        const rewards = await pool.query(
            'SELECT * FROM level_rewards WHERE level BETWEEN $1 AND $2',
            [oldLevel + 1, newLevel]
        );
        for (const reward of rewards.rows) {
            if (reward.reward_type === 'credits') {
                await pool.query(
                    'UPDATE user_credits SET balance = balance + $1 WHERE user_id = $2',
                    [reward.reward_value, userId]
                );
                await pool.query(
                    `INSERT INTO credit_transactions (user_id, amount, type, description)
                     VALUES ($1, $2, 'bonus', $3)`,
                    [userId, reward.reward_value, `Level ${reward.level} reward: ${reward.reward_value} credits`]
                );
            } else if (reward.reward_type === 'premium_days') {
                const user = await pool.query(
                    'SELECT premium_until FROM users WHERE id = $1',
                    [userId]
                );
                let current = user.rows[0].premium_until;
                let newExpiry;
                if (current && new Date(current) > new Date()) {
                    newExpiry = new Date(new Date(current).getTime() + reward.reward_value * 24 * 60 * 60 * 1000);
                } else {
                    newExpiry = new Date(Date.now() + reward.reward_value * 24 * 60 * 60 * 1000);
                }
                await pool.query(
                    'UPDATE users SET premium_until = $1 WHERE id = $2',
                    [newExpiry, userId]
                );
            } else if (reward.reward_type === 'badge') {
                await pool.query(
                    'INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2)',
                    [userId, reward.reward_value]
                );
            } else if (reward.reward_type === 'custom_badge') {
                await pool.query(
                    'UPDATE users SET has_custom_badge = true WHERE id = $1',
                    [userId]
                );
            }
        }
    } catch (err) {
        console.error('grantLevelRewards error:', err);
    }
}

async function updateStreak(userId) {
    const today = new Date().toISOString().slice(0, 10);
    try {
        const streak = await pool.query(
            'SELECT current_streak, last_login_date FROM user_streak WHERE user_id = $1',
            [userId]
        );
        if (streak.rows.length === 0) {
            await pool.query(
                `INSERT INTO user_streak (user_id, current_streak, longest_streak, last_login_date, multiplier)
                 VALUES ($1, 1, 1, $2, 1.0)`,
                [userId, today]
            );
            return 1;
        }
        const { current_streak, last_login_date } = streak.rows[0];
        const lastDate = last_login_date ? new Date(last_login_date) : null;
        const now = new Date();
        let current = current_streak;
        let multiplier = 1.0;

        if (lastDate) {
            const diffDays = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
            if (diffDays === 1) {
                current++;
                multiplier = Math.min(2.0, 1 + (current - 1) * 0.05);
            } else if (diffDays > 1) {
                current = 1;
                multiplier = 1.0;
            }
        }
        const longest = Math.max(current, current_streak);
        await pool.query(
            `UPDATE user_streak SET current_streak=$1, longest_streak=$2,
             last_login_date=$3, multiplier=$4 WHERE user_id=$5`,
            [current, longest, today, multiplier, userId]
        );
        return multiplier;
    } catch (err) {
        console.error('updateStreak error:', err);
        return 1;
    }
}

async function getDailyQuests(userId) {
    const today = new Date().toISOString().slice(0,10);
    const quests = await pool.query(`
        SELECT q.*, COALESCE(uqd.progress, 0) as progress, COALESCE(uqd.completed, false) as completed, COALESCE(uqd.claimed, false) as claimed
        FROM daily_quests q
        LEFT JOIN user_daily_quests uqd ON q.id = uqd.quest_id AND uqd.user_id = $1 AND uqd.date = $2
    `, [userId, today]);
    for (const q of quests.rows) {
        if (q.progress === 0 && q.completed === false && q.claimed === false && !q.progress_from_db) {
            await pool.query(
                `INSERT INTO user_daily_quests (user_id, quest_id, date, progress, completed, claimed)
                 VALUES ($1, $2, $3, 0, false, false)
                 ON CONFLICT DO NOTHING`,
                [userId, q.id, today]
            );
        }
    }
    return quests.rows;
}

async function updateQuestProgress(userId, action, increment = 1) {
    const today = new Date().toISOString().slice(0,10);
    try {
        await pool.query(`
            INSERT INTO user_daily_quests (user_id, quest_id, date, progress, completed, claimed)
            SELECT $1, q.id, $2, 0, false, false
            FROM daily_quests q
            WHERE q.target_action = $3
            ON CONFLICT (user_id, quest_id, date) DO NOTHING
        `, [userId, today, action]);

        const updateRes = await pool.query(`
            UPDATE user_daily_quests
            SET progress = progress + $1
            WHERE user_id = $2
              AND quest_id IN (SELECT id FROM daily_quests WHERE target_action = $3)
              AND date = $4
              AND completed = false
        `, [increment, userId, action, today]);
        console.log(`[Quest] Updated ${updateRes.rowCount} quest(s)`);

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

// ==================== PASSPORT ====================
passport.serializeUser((user, done) => {
    if (!user || !user.id) return done(new Error('User object missing id'));
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await pool.query(
            'SELECT id, username, email, role FROM users WHERE id = $1',
            [id]
        );
        done(null, result.rows[0]);
    } catch (err) {
        done(err);
    }
});

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let userResult = await pool.query(
        'SELECT id, username, email, role FROM users WHERE google_id = $1',
        [profile.id]
      );
      let user = userResult.rows[0];
      let isNewUser = false;

      if (!user) {
        const email = profile.emails[0].value;
        let existingUserResult = await pool.query(
          'SELECT id, username, email, role FROM users WHERE email = $1',
          [email]
        );
        let existingUser = existingUserResult.rows[0];

        if (existingUser) {
          await pool.query(
            'UPDATE users SET google_id = $1 WHERE email = $2',
            [profile.id, email]
          );
          const updatedResult = await pool.query(
            'SELECT id, username, email, role FROM users WHERE email = $1',
            [email]
          );
          user = updatedResult.rows[0];
        } else {
          isNewUser = true;
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
             RETURNING id, username, email, role`,
            [username, email, profile.id, dummyPassword]
          );
          user = insertResult.rows[0];
          
          await initializeUserCredits(user.id);
          sendWelcomeEmail(email, username).catch(err => console.error('Welcome email failed:', err.message));
          sendAdminAlert({ 
            subject: 'New User Registration (Google Sign-In)', 
            message: `New user ${username} (${email}) registered via Google Sign-In.` 
          }).catch(err => console.error('Admin alert failed:', err.message));
        }
      }
      return done(null, user);
    } catch (err) {
      console.error('Google strategy error:', err);
      return done(err);
    }
  }
));

// ==================== FILE UPLOAD (Avatars) ====================
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

// ==================== FILE UPLOAD (Product Images) ====================
const productImageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './private_uploads/products';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'product-' + req.params.id + '-' + unique + ext);
    }
});

const uploadProductImage = multer({
    storage: productImageStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mime = allowedTypes.test(file.mimetype);
        if (ext && mime) return cb(null, true);
        cb(new Error('Only images are allowed'));
    }
});

// ==================== AUTH MIDDLEWARE ====================
const isAuthenticated = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    try {
        if (!req.session.role) {
            const result = await pool.query(
                'SELECT role, is_banned FROM users WHERE id = $1',
                [req.session.userId]
            );
            if (result.rows[0].is_banned) {
                req.session.destroy();
                return res.status(403).json({ error: 'Your account has been banned' });
            }
            req.session.role = result.rows[0].role;
        }
        next();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};

const isAdmin = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    if (req.session.role === 'admin') return next();
    try {
        const result = await pool.query(
            'SELECT role FROM users WHERE id = $1',
            [req.session.userId]
        );
        if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        req.session.role = 'admin';
        next();
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
};

const isAdminOrModerator = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const role = req.session.role;
    if (role === 'admin' || role === 'moderator') return next();
    try {
        const result = await pool.query(
            'SELECT role FROM users WHERE id = $1',
            [req.session.userId]
        );
        const dbRole = result.rows[0]?.role;
        if (dbRole === 'admin' || dbRole === 'moderator') {
            req.session.role = dbRole;
            return next();
        }
        res.status(403).json({ error: 'Access denied' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
};

const isDeliveryPartner = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const result = await pool.query(
            'SELECT role FROM users WHERE id = $1',
            [req.session.userId]
        );
        if (result.rows.length === 0 || result.rows[0].role !== 'delivery_partner') {
            return res.status(403).json({ error: 'Only delivery partners can access this endpoint' });
        }
        next();
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
};

// ==================== STATIC ROUTES ====================
app.get('/uploads/avatars/:filename', isAuthenticated, (req, res) => {
    const filepath = path.join(__dirname, 'private_uploads', 'avatars', req.params.filename);
    if (fs.existsSync(filepath)) {
        res.sendFile(filepath);
    } else {
        res.status(404).send('Avatar not found');
    }
});

app.get('/uploads/products/:filename', isAuthenticated, (req, res) => {
    const filepath = path.join(__dirname, 'private_uploads', 'products', req.params.filename);
    if (fs.existsSync(filepath)) {
        res.sendFile(filepath);
    } else {
        res.status(404).send('Image not found');
    }
});

// ==================== PREMIUM STATUS HELPER ====================
async function getPremiumStatus(userId) {
    try {
        const result = await pool.query(
            `SELECT premium_until, analytics_until, featured_until,
                    priority_support_until, message_boosts_remaining,
                    has_custom_badge, selected_badge
             FROM users WHERE id = $1`,
            [userId]
        );
        const user = result.rows[0];
        if (!user) return {};
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
            hasCustomBadge: user.has_custom_badge === true,
            selectedBadge: user.selected_badge
        };
    } catch (err) {
        console.error('getPremiumStatus error:', err);
        return {};
    }
}

// ==================== CREDITS SYSTEM ====================
async function spendCredits(userId, amount, reason, feature, durationDays = 0, uses = 0) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const updateResult = await client.query(
            `UPDATE user_credits 
             SET balance = balance - $1, lifetime_spent = lifetime_spent + $1, last_updated = NOW()
             WHERE user_id = $2 AND balance >= $1`,
            [amount, userId]
        );
        if (updateResult.rowCount === 0) {
            throw new Error('Insufficient credits');
        }
        
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

async function initializeUserCredits(userId) {
    try {
        const welcomeBonus = 600;
        await pool.query(
            `INSERT INTO user_credits (user_id, balance, lifetime_earned)
             VALUES ($1, $2, $2)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId, welcomeBonus]
        );
        await pool.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'bonus', 'Welcome bonus for joining Sraveik')`,
            [userId, welcomeBonus]
        );
    } catch (err) {
        console.error('Error initializing user credits:', err);
    }
}

async function ensureUserCredits(userId) {
    try {
        const existing = await pool.query(
            'SELECT id FROM user_credits WHERE user_id = $1',
            [userId]
        );
        if (existing.rows.length === 0) {
            await initializeUserCredits(userId);
        }
    } catch (err) {
        console.error('Error ensuring user credits:', err);
    }
}

async function awardCreditsForToolApproval(userId, toolName) {
    try {
        const approvalBonus = 25;
        await pool.query(
            `UPDATE user_credits 
             SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
             WHERE user_id = $2`,
            [approvalBonus, userId]
        );
        console.log(`✅ Awarded ${approvalBonus} credits to user ${userId} for tool approval: ${toolName}`);
    } catch (err) {
        console.error('Error awarding credits:', err);
    }
}

// ==================== BUSINESS CREDIT HELPER ====================
async function awardCreditsForBusinessApproval(userId, businessName) {
    const approvalBonus = 15;
    await ensureUserCredits(userId);
    await pool.query(
        `UPDATE user_credits 
         SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
         WHERE user_id = $2`,
        [approvalBonus, userId]
    );
    await pool.query(
        `INSERT INTO credit_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'earn', $3)`,
        [userId, approvalBonus, `Business approved: ${businessName} - Earned ${approvalBonus} credits`]
    );
    console.log(`✅ Awarded ${approvalBonus} credits to user ${userId} for business approval: ${businessName}`);
}

// ==================== PHONEPE PAYMENT GATEWAY ====================
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

const CREDIT_PACKS = [
    { id: 'pack_100', credits: 100, pricePaise: 4900, name: '100 Credits' },
    { id: 'pack_250', credits: 250, pricePaise: 9900, name: '250 Credits' },
    { id: 'pack_500', credits: 500, pricePaise: 17900, name: '500 Credits' },
    { id: 'pack_1000', credits: 1000, pricePaise: 29900, name: '1000 Credits' }
];

app.post('/api/create-phonepe-order', isAuthenticated, async (req, res) => {
    const { packId, credits, amountInPaise } = req.body;
    if (!packId || !credits || !amountInPaise) {
        return res.status(400).json({ error: 'Missing payment details' });
    }
    const merchantOrderId = `ORDER_${Date.now()}_${req.session.userId}`;
    try {
        const paymentRequest = await StandardCheckoutPayRequest.builder()
            .merchantOrderId(merchantOrderId)
            .amount(amountInPaise)
            .redirectUrl(`${process.env.PHONEPE_REDIRECT_URL}?order_id=${merchantOrderId}`)
            .build();
        const paymentResponse = await phonepeClient.pay(paymentRequest);
        await pool.query(
            `INSERT INTO credit_purchases (user_id, credits, amount, merchant_order_id, pack_id, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW())`,
            [req.session.userId, credits, amountInPaise / 100, merchantOrderId, packId]
        );
        res.json({ success: true, redirectUrl: paymentResponse.redirectUrl });
    } catch (err) {
        console.error('PhonePe order error:', err);
        res.status(500).json({ error: 'Failed to initiate payment' });
    }
});

app.post('/api/phonepe-webhook', async (req, res) => {
    const authHeader = req.headers['x-verify'];
    const responseBody = req.body;
    try {
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
            const purchase = await pool.query(
                'SELECT * FROM credit_purchases WHERE merchant_order_id = $1 AND status = $2',
                [merchantOrderId, 'PENDING']
            );
            if (purchase.rows.length > 0) {
                const { user_id, credits } = purchase.rows[0];
                await ensureUserCredits(user_id);
                await pool.query(
                    `UPDATE user_credits 
                     SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
                     WHERE user_id = $2`,
                    [credits, user_id]
                );
                await pool.query(
                    `INSERT INTO credit_transactions (user_id, amount, type, description)
                     VALUES ($1, $2, 'earn', $3)`,
                    [user_id, credits, `Purchased ${credits} credits via PhonePe`]
                );
                await pool.query(
                    'UPDATE credit_purchases SET status = $1, updated_at = NOW() WHERE merchant_order_id = $2',
                    ['COMPLETED', merchantOrderId]
                );
                console.log(`✅ Added ${credits} credits to user ${user_id} via PhonePe`);
            }
        }
        res.status(200).send('Webhook received');
    } catch (err) {
        console.error('PhonePe webhook error:', err);
        res.status(500).send('Internal server error');
    }
});

app.get('/api/verify-payment', isAuthenticated, async (req, res) => {
    const { order_id } = req.query;
    if (!order_id) {
        return res.status(400).json({ error: 'Missing order_id parameter' });
    }

    try {
        const purchase = await pool.query(
            `SELECT * FROM credit_purchases 
             WHERE merchant_order_id = $1 AND user_id = $2 AND status = 'PENDING'`,
            [order_id, req.session.userId]
        );

        if (purchase.rows.length === 0) {
            return res.json({ status: 'not_found', message: 'No pending purchase found' });
        }

        const { id, credits, user_id } = purchase.rows[0];

        await pool.query(
            `UPDATE user_credits 
             SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
             WHERE user_id = $2`,
            [credits, user_id]
        );

        await pool.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'earn', $3)`,
            [user_id, credits, `Purchased ${credits} credits via PhonePe (manual verification)`]
        );

        await pool.query(
            `UPDATE credit_purchases SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
            [id]
        );

        res.json({ success: true, credits_added: credits });
    } catch (err) {
        console.error('Manual verification error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

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
    await pool.query(
      `INSERT INTO premium_purchases (user_id, feature, duration_days, merchant_order_id, status) 
       VALUES ($1, $2, $3, $4, 'PENDING')`,
      [req.session.userId, feature, durationDays, merchantOrderId]
    );
    res.json({ success: true, redirectUrl: paymentResponse.redirectUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to initiate premium purchase' });
  }
});

// ==================== SOCKET.IO SETUP ====================
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: allowedOrigins, credentials: true } });
io.use(sharedsession(sessionMiddleware, { autoSave: true }));

const onlineUsers = new Map();

async function getFriendsList(userId) {
    try {
        const result = await pool.query(
            `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status
             FROM friendships f
             JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
             WHERE (f.user_id = $1 OR f.friend_id = $1)
               AND f.status = 'accepted'
               AND u.id != $1`,
            [userId]
        );
        return result.rows;
    } catch (err) {
        console.error('getFriendsList error:', err);
        return [];
    }
}

async function getTotalUsersCount() {
    const result = await pool.query('SELECT COUNT(*) as count FROM users');
    return result.rows[0].count;
}
async function getRecentActivities() {
    const result = await pool.query(`SELECT action, moderator_name, created_at FROM moderator_activity ORDER BY created_at DESC LIMIT 5`);
    return result.rows;
}

io.on('connection', (socket) => {
    const session = socket.handshake.session;
    const userId = session.userId;
    if (!userId) {
        socket.disconnect();
        return;
    }
    
    let userEntry = onlineUsers.get(userId);
    if (!userEntry) {
        userEntry = { socketId: socket.id, socketIds: new Set() };
        onlineUsers.set(userId, userEntry);
    }
    userEntry.socketIds.add(socket.id);
    userEntry.socketId = socket.id;
    
    socket.join(`user_${userId}`);
    
    if (session.role === 'admin' || session.role === 'moderator') {
        socket.join('admin_room');
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

    (async () => {
        try {
            const friends = await getFriendsList(userId);
            friends.forEach(friend => {
                const friendEntry = onlineUsers.get(friend.id);
                if (friendEntry && friendEntry.socketId) io.to(friendEntry.socketId).emit('user_status', { userId, status: 'online' });
            });
        } catch (err) { console.error('Error broadcasting online status:', err); }
    })();

    socket.on('private_message', async (data) => {
        const { to, message, tempId } = data;
        if (!to || !message) return;
        try {
            const result = await pool.query(
                'INSERT INTO messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING id',
                [userId, to, message]
            );
            const newMessageId = result.rows[0]?.id;
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
            const membership = await pool.query(
                'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
                [groupId, userId]
            );
            if (membership.rows.length === 0) return;

            const result = await pool.query(
                'INSERT INTO group_messages (group_id, sender_id, content) VALUES ($1, $2, $3) RETURNING id',
                [groupId, userId, message]
            );
            const newId = result.rows[0].id;

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

    socket.on('partner_location_update', async (data) => {
        const { lat, lng } = data;
        if (!lat || !lng) return;
        try {
            await pool.query(
                `UPDATE users SET last_latitude = $1, last_longitude = $2, updated_at = NOW()
                 WHERE id = $3`,
                [lat, lng, userId]
            );
        } catch (err) {
            console.error('Error updating partner location:', err);
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
                userEntry.socketId = Array.from(userEntry.socketIds)[0];
            }
        }
        console.log(`User ${userId} disconnected`);
    });
});

// ==================== GROUP CHAT REST ENDPOINTS ====================
app.get('/api/groups/:id/messages', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 30;
    if (isNaN(groupId)) return res.status(400).json({ error: 'Invalid group ID' });
    try {
        const membership = await pool.query(
            'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
            [groupId, req.session.userId]
        );
        if (membership.rows.length === 0) {
            return res.status(403).json({ error: 'You are not a member of this group' });
        }
        const result = await pool.query(
            `SELECT gm.id, gm.sender_id, gm.content, gm.created_at, u.username as sender_name
             FROM group_messages gm
             JOIN users u ON gm.sender_id = u.id
             WHERE gm.group_id = $1
             ORDER BY gm.created_at DESC
             LIMIT $2 OFFSET $3`,
            [groupId, limit, offset]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch group messages' });
    }
});

app.get('/api/groups/:id/members', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    if (isNaN(groupId)) return res.status(400).json({ error: 'Invalid group ID' });
    try {
        const membership = await pool.query(
            'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
            [groupId, req.session.userId]
        );
        if (membership.rows.length === 0) {
            return res.status(403).json({ error: 'You are not a member of this group' });
        }
        const result = await pool.query(
            `SELECT u.id, u.username, u.display_name, u.avatar_url
             FROM group_members gm
             JOIN users u ON gm.user_id = u.id
             WHERE gm.group_id = $1`,
            [groupId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch group members' });
    }
});

app.post('/api/groups/:id/members', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    const { userId } = req.body;
    if (isNaN(groupId) || !userId) return res.status(400).json({ error: 'Invalid parameters' });
    try {
        const group = await pool.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
        if (group.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
        if (group.rows[0].created_by !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only group creator can add members' });
        }
        const existing = await pool.query(
            'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
            [groupId, userId]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'User is already a member' });
        }
        await pool.query(
            'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)',
            [groupId, userId]
        );
        res.json({ success: true, message: 'Member added' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add member' });
    }
});

app.delete('/api/groups/:id/members/:userId', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    const memberId = parseInt(req.params.userId);
    if (isNaN(groupId) || isNaN(memberId)) return res.status(400).json({ error: 'Invalid parameters' });
    try {
        const group = await pool.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
        if (group.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
        if (group.rows[0].created_by !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only group creator can remove members' });
        }
        if (memberId === group.rows[0].created_by) {
            return res.status(400).json({ error: 'Cannot remove group creator' });
        }
        await pool.query(
            'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
            [groupId, memberId]
        );
        res.json({ success: true, message: 'Member removed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to remove member' });
    }
});

app.post('/api/groups/:id/leave', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    if (isNaN(groupId)) return res.status(400).json({ error: 'Invalid group ID' });

    try {
        const group = await pool.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
        if (group.rows.length === 0) return res.status(404).json({ error: 'Group not found' });

        const isCreator = (group.rows[0].created_by === req.session.userId);

        if (isCreator) {
            await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
            const members = await pool.query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
            for (const member of members.rows) {
                const userEntry = onlineUsers.get(member.user_id);
                if (userEntry && userEntry.socketId) {
                    io.to(userEntry.socketId).emit('group_deleted', { groupId });
                }
            }
            return res.json({ success: true, message: 'Group deleted because you were the creator' });
        }

        await pool.query(
            'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
            [groupId, req.session.userId]
        );

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

app.post('/api/admin/groups', isAdminOrModerator, async (req, res) => {
    const { name, members } = req.body;
    if (!name || !Array.isArray(members)) {
        return res.status(400).json({ error: 'Group name and members array required' });
    }

    try {
        for (const userId of members) {
            const roleCheck = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
            if (roleCheck.rows.length === 0)
                return res.status(400).json({ error: `User ${userId} does not exist` });
            const role = roleCheck.rows[0].role;
            if (role !== 'admin' && role !== 'moderator') {
                return res.status(403).json({ error: 'Only admins and moderators can be added to staff groups' });
            }
        }

        const result = await pool.query(
            `INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id`,
            [name, req.session.userId]
        );
        const groupId = result.rows[0].id;

        await pool.query(
            `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
            [groupId, req.session.userId]
        );

        for (const userId of members) {
            if (userId === req.session.userId) continue;
            const isFriend = await pool.query(
                `SELECT 1 FROM friendships 
                 WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1) AND status = 'accepted'`,
                [req.session.userId, userId]
            );
            if (isFriend.rows.length === 0) {
                return res.status(403).json({ error: 'You can only add friends to a group' });
            }
        }
        for (const userId of members) {
            await pool.query(
                `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
                [groupId, userId]
            );
        }

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

app.delete('/api/groups/:id', isAuthenticated, async (req, res) => {
    const groupId = parseInt(req.params.id);
    try {
        const group = await pool.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
        if (group.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
        if (group.rows[0].created_by !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only creator or admin can delete' });
        }
        await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete group' });
    }
});

app.get('/api/staff-lounge', isAdminOrModerator, async (req, res) => {
    try {
        const groupResult = await pool.query(`SELECT id FROM groups WHERE name = 'Staff Lounge'`);
        if (groupResult.rows.length === 0) {
            return res.status(404).json({ error: 'Staff Lounge not found' });
        }
        const groupId = groupResult.rows[0].id;
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
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 10 * 60 * 1000);
 
        await pool.query(
            `INSERT INTO otp_store (email, otp, expires_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET otp = $2, expires_at = $3`,
            [email, otp, expires]
        );
 
        const emailSent = await sendOtpEmail(email, otp);
        if (!emailSent.success) return res.status(500).send('Failed to send OTP email');
        res.status(200).send('OTP sent successfully');
    } catch (err) {
        console.error('OTP error:', err);
        res.status(500).send('Server error');
    }
});

app.post('/api/groups', isAuthenticated, async (req, res) => {
    const { name, members } = req.body;
    if (!name || !Array.isArray(members)) {
        return res.status(400).json({ error: 'Group name and members array required' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id`,
            [name, req.session.userId]
        );
        const groupId = result.rows[0].id;
        
        await pool.query(
            `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
            [groupId, req.session.userId]
        );
        
        for (const memberId of members) {
            await pool.query(
                `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
                [groupId, memberId]
            );
        }
        
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

// ==================== REGISTER ====================
app.post('/register', authLimiter, async (req, res) => {
    const { username, email, password, otp, ref } = req.body;
    if (!username || !email || !password || !otp)
        return res.status(400).send('All fields (including OTP) are required');

    const strength = validatePasswordStrength(password);
    if (!strength.valid) return res.status(400).send(strength.message);

    try {
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
            await addXP(referrerId, 50, 'Referral');
            await updateQuestProgress(referrerId, 'referral');
            await checkAchievements(referrerId);
        }
        
        sendWelcomeEmail(email, username).catch(err => console.error('Welcome email failed:', err.message));
        sendAdminAlert({ subject: 'New User Registration', message: `New user ${username} (${email}) registered.` }).catch(err => console.error('Admin alert failed:', err.message));
        res.status(201).send('Registration successful! Please login.');
    } catch (err) {
        console.error(err);
        if (err.code === '23505') {
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
        const result = await pool.query(
            `SELECT * FROM users WHERE ${column} = $1`, 
            [username]
        );
        
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
                            WHEN login_attempts + 1 >= $1 
                            THEN NOW() + INTERVAL '30 minutes'
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

        updateStreak(user.id).catch(err => console.error('Streak error:', err));
        updateQuestProgress(user.id, 'login').catch(err => console.error('Quest error:', err));
        checkAchievements(user.id).catch(err => console.error('Achievement error:', err));

    } catch (err) {
        console.error('Login error:', err);
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
        else res.redirect('/main.html');
    });
});

// ==================== TOOL USAGE TRACKING ====================
app.post('/api/track-usage', isAuthenticated, async (req, res) => {
    const { tool_name, tool_category } = req.body;
    if (!tool_name) return res.status(400).send('Tool name required');
    try {
        await pool.query(
            'INSERT INTO tool_usage (user_id, tool_name, tool_category) VALUES ($1, $2, $3)',
            [req.session.userId, tool_name, tool_category || null]
        );
        await updateQuestProgress(req.session.userId, 'use_tool');
        await checkAchievements(req.session.userId);
        res.send('Tracked');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== TOOL REVIEW ====================
app.post('/api/tools/:id/review', isAuthenticated, async (req, res) => {
    const toolId = req.params.id;
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    try {
        await pool.query(
            `INSERT INTO tool_reviews (tool_id, user_id, rating, comment, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [toolId, req.session.userId, rating, comment || '']
        );
        await addXP(req.session.userId, 10, 'Review');
        await updateQuestProgress(req.session.userId, 'review');
        await checkAchievements(req.session.userId);
        res.json({ success: true, message: 'Review submitted! +10 XP' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit review' });
    }
});

// ==================== CATEGORY REVIEW ====================
app.post('/api/category-review', isAuthenticated, async (req, res) => {
    const { category, rating, comment } = req.body;
    if (!category || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Category and valid rating (1-5) are required' });
    }
    try {
        await pool.query(
            `INSERT INTO category_reviews (user_id, category, rating, comment, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [req.session.userId, category, rating, comment || '']
        );
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
        const user = await pool.query('SELECT has_custom_badge FROM users WHERE id = $1', [req.session.userId]);
        if (!user.rows[0]?.has_custom_badge) {
            return res.status(403).json({ error: 'You have not purchased a custom badge' });
        }
        await pool.query('UPDATE users SET selected_badge = $1 WHERE id = $2', [badge || null, req.session.userId]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN REWARDS ====================
app.get('/api/credits/admin-rewards', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, amount, type, description, created_at
             FROM credit_transactions
             WHERE user_id = $1 
               AND type = 'earn' 
               AND (description ILIKE '%admin%' OR description ILIKE '%reward%')
             ORDER BY created_at DESC`,
            [req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Admin rewards error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== PREMIUM STATUS ====================
app.get('/api/user/premium-status', isAuthenticated, async (req, res) => {
    try {
        const status = await getPremiumStatus(req.session.userId);
        res.json(status);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== SPEND CREDITS ====================
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

// ==================== PROFILE UPDATE ====================
app.put('/profile/update', isAuthenticated, async (req, res) => {
    const { display_name, bio, phone, github, twitter, linkedin } = req.body;
    try {
        await pool.query(
            `UPDATE users SET
                display_name = $1, bio = $2, phone = $3,
                github = $4, twitter = $5, linkedin = $6,
                updated_at = NOW()
             WHERE id = $7`,
            [
                display_name ? escapeHtml(display_name) : null,
                bio ? escapeHtml(bio) : null,
                phone ? escapeHtml(phone) : null,
                github ? escapeHtml(github) : null,
                twitter ? escapeHtml(twitter) : null,
                linkedin ? escapeHtml(linkedin) : null,
                req.session.userId
            ]
        );
        const updated = await pool.query(
            `SELECT id, username, display_name, email, bio, phone,
                    github, twitter, linkedin, email_verified,
                    two_factor_enabled, created_at, updated_at, avatar_url
             FROM users WHERE id = $1`,
            [req.session.userId]
        );
        res.json(updated.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== AVATAR UPLOAD ====================
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
        await pool.query(
            'UPDATE users SET avatar_url = $1 WHERE id = $2',
            [avatarUrl, req.session.userId]
        );
        
        // Also update avatar_style to 'uploaded' when user uploads
        await pool.query(
            'UPDATE users SET avatar_style = $1 WHERE id = $2',
            ['uploaded', req.session.userId]
        );
        
        res.send('Avatar uploaded successfully');
    } catch (err) {
        console.error(err);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).send('Server error');
    }
});

// ==================== AVATAR GALLERY ENDPOINTS ====================

// Get all available avatars for a user
app.get('/api/avatars/gallery', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        
        // Get user's level and premium status
        const userResult = await pool.query(
            'SELECT level, premium_until FROM users WHERE id = $1',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userLevel = userResult.rows[0].level || 1;
        const isPremium = userResult.rows[0].premium_until && new Date(userResult.rows[0].premium_until) > new Date();
        
        // Get user's owned avatars
        const ownedResult = await pool.query(
            'SELECT avatar_id, is_active FROM user_avatars WHERE user_id = $1',
            [userId]
        );
        
        const ownedAvatars = ownedResult.rows.reduce((acc, row) => {
            acc[row.avatar_id] = row.is_active;
            return acc;
        }, {});
        
        // Define all available avatars
        const avatars = {
            male: [
                // Iron Tier
                { id: 'm_iron1', name: 'Iron Recruit', icon: '⚔️', gender: 'male', tier: 'Iron', bg: '#9ca3af', minLevel: 1, premiumRequired: false },
                { id: 'm_iron2', name: 'Iron Shield', icon: '🛡️', gender: 'male', tier: 'Iron', bg: '#7f8c8d', minLevel: 3, premiumRequired: false },
                { id: 'm_iron3', name: 'Iron Guard', icon: '🪖', gender: 'male', tier: 'Iron', bg: '#7f8c8d', minLevel: 5, premiumRequired: false },
                { id: 'm_iron4', name: 'Iron Warden', icon: '🗡️', gender: 'male', tier: 'Iron', bg: '#6b7280', minLevel: 8, premiumRequired: false },
                // Bronze Tier
                { id: 'm_brnz1', name: 'Bronze Scout', icon: '🦅', gender: 'male', tier: 'Bronze', bg: '#cd7f32', minLevel: 10, premiumRequired: false },
                { id: 'm_brnz2', name: 'Bronze Knight', icon: '🏹', gender: 'male', tier: 'Bronze', bg: '#b8860b', minLevel: 12, premiumRequired: false },
                { id: 'm_brnz3', name: 'Bronze Ranger', icon: '⚡', gender: 'male', tier: 'Bronze', bg: '#b8860b', minLevel: 15, premiumRequired: false },
                { id: 'm_brnz4', name: 'Bronze Champion', icon: '🦁', gender: 'male', tier: 'Bronze', bg: '#a0522d', minLevel: 18, premiumRequired: false },
                // Silver Tier
                { id: 'm_silv1', name: 'Silver Sentinel', icon: '🌟', gender: 'male', tier: 'Silver', bg: '#60a5fa', minLevel: 20, premiumRequired: false },
                { id: 'm_silv2', name: 'Silver Blade', icon: '💎', gender: 'male', tier: 'Silver', bg: '#3b82f6', minLevel: 22, premiumRequired: false },
                { id: 'm_silv3', name: 'Silver Hawk', icon: '🔷', gender: 'male', tier: 'Silver', bg: '#2563eb', minLevel: 25, premiumRequired: false },
                { id: 'm_silv4', name: 'Silver Paladin', icon: '🦋', gender: 'male', tier: 'Silver', bg: '#1d4ed8', minLevel: 28, premiumRequired: false },
                // Gold Tier
                { id: 'm_gold1', name: 'Gold Warrior', icon: '🌠', gender: 'male', tier: 'Gold', bg: '#f59e0b', minLevel: 30, premiumRequired: false },
                { id: 'm_gold2', name: 'Gold Berserker', icon: '🔥', gender: 'male', tier: 'Gold', bg: '#d97706', minLevel: 33, premiumRequired: true },
                { id: 'm_gold3', name: 'Gold Titan', icon: '⚜️', gender: 'male', tier: 'Gold', bg: '#b45309', minLevel: 36, premiumRequired: true },
                { id: 'm_gold4', name: 'Gold Overlord', icon: '🦊', gender: 'male', tier: 'Gold', bg: '#92400e', minLevel: 39, premiumRequired: true },
                // Platinum Tier
                { id: 'm_plat1', name: 'Platinum Ace', icon: '🌊', gender: 'male', tier: 'Platinum', bg: '#06b6d4', minLevel: 40, premiumRequired: true },
                { id: 'm_plat2', name: 'Platinum Specter', icon: '🦜', gender: 'male', tier: 'Platinum', bg: '#0891b2', minLevel: 43, premiumRequired: true },
                { id: 'm_plat3', name: 'Platinum Phantom', icon: '🌀', gender: 'male', tier: 'Platinum', bg: '#0e7490', minLevel: 46, premiumRequired: true },
                { id: 'm_plat4', name: 'Platinum Sovereign', icon: '❄️', gender: 'male', tier: 'Platinum', bg: '#155e75', minLevel: 49, premiumRequired: true },
                // Diamond Tier
                { id: 'm_diam1', name: 'Diamond Mage', icon: '💜', gender: 'male', tier: 'Diamond', bg: '#8b5cf6', minLevel: 50, premiumRequired: true },
                { id: 'm_diam2', name: 'Diamond Rogue', icon: '🔮', gender: 'male', tier: 'Diamond', bg: '#7c3aed', minLevel: 53, premiumRequired: true },
                { id: 'm_diam3', name: 'Diamond Rift', icon: '🌌', gender: 'male', tier: 'Diamond', bg: '#6d28d9', minLevel: 56, premiumRequired: true },
                { id: 'm_diam4', name: 'Diamond Warlord', icon: '✨', gender: 'male', tier: 'Diamond', bg: '#5b21b6', minLevel: 59, premiumRequired: true },
                // Master Tier
                { id: 'm_mast1', name: 'Master Invoker', icon: '🐉', gender: 'male', tier: 'Master', bg: '#f97316', minLevel: 60, premiumRequired: true },
                { id: 'm_mast2', name: 'Master Pyromancer', icon: '🌋', gender: 'male', tier: 'Master', bg: '#ea580c', minLevel: 63, premiumRequired: true },
                { id: 'm_mast3', name: 'Master Warchief', icon: '🦎', gender: 'male', tier: 'Master', bg: '#dc2626', minLevel: 66, premiumRequired: true },
                { id: 'm_mast4', name: 'Master Reaper', icon: '☠️', gender: 'male', tier: 'Master', bg: '#b91c1c', minLevel: 69, premiumRequired: true },
                // Grandmaster Tier
                { id: 'm_gm1', name: 'Grandmaster Sage', icon: '🌸', gender: 'male', tier: 'Grandmaster', bg: '#ec4899', minLevel: 70, premiumRequired: true },
                { id: 'm_gm2', name: 'Grandmaster Oracle', icon: '🦄', gender: 'male', tier: 'Grandmaster', bg: '#db2777', minLevel: 73, premiumRequired: true },
                { id: 'm_gm3', name: 'Grandmaster Eclipse', icon: '🌙', gender: 'male', tier: 'Grandmaster', bg: '#be185d', minLevel: 76, premiumRequired: true },
                { id: 'm_gm4', name: 'GM Vanguard', icon: '👁️', gender: 'male', tier: 'Grandmaster', bg: '#9d174d', minLevel: 79, premiumRequired: true },
                // Challenger Tier
                { id: 'm_chal1', name: 'Challenger Nexus', icon: '⭐', gender: 'male', tier: 'Challenger', bg: '#fbbf24', minLevel: 80, premiumRequired: true },
                { id: 'm_chal2', name: 'Challenger Sarveik', icon: '🌞', gender: 'male', tier: 'Challenger', bg: '#f59e0b', minLevel: 83, premiumRequired: true },
                { id: 'm_chal3', name: 'Challenger Storm', icon: '🌪️', gender: 'male', tier: 'Challenger', bg: '#d97706', minLevel: 86, premiumRequired: true },
                { id: 'm_chal4', name: 'Challenger Apex', icon: '💥', gender: 'male', tier: 'Challenger', bg: '#b45309', minLevel: 89, premiumRequired: true },
                // Legendary Tier
                { id: 'm_leg1', name: 'Legendary Titan', icon: '👑', gender: 'male', tier: 'Legendary', bg: 'linear-gradient(135deg,#f59e0b,#ef4444)', minLevel: 90, premiumRequired: true },
                { id: 'm_leg2', name: 'Legendary Phoenix', icon: '🦅', gender: 'male', tier: 'Legendary', bg: 'linear-gradient(135deg,#ec4899,#8b5cf6)', minLevel: 93, premiumRequired: true },
                { id: 'm_leg3', name: 'Legendary Eternal', icon: '🔱', gender: 'male', tier: 'Legendary', bg: 'linear-gradient(135deg,#06b6d4,#7c3aed)', minLevel: 95, premiumRequired: true },
                { id: 'm_leg4', name: 'Legendary God-King', icon: '⚡', gender: 'male', tier: 'Legendary', bg: 'linear-gradient(135deg,#fbbf24,#f97316,#ef4444)', minLevel: 98, premiumRequired: true },
                { id: 'm_leg5', name: 'Sarveik Absolute', icon: '🌟', gender: 'male', tier: 'Legendary', bg: 'linear-gradient(135deg,#fbbf24,#8b5cf6,#06b6d4)', minLevel: 100, premiumRequired: true }
            ],
            female: [
                // Iron Tier
                { id: 'f_iron1', name: 'Iron Apprentice', icon: '🗡️', gender: 'female', tier: 'Iron', bg: '#9ca3af', minLevel: 1, premiumRequired: false },
                { id: 'f_iron2', name: 'Iron Archer', icon: '🏹', gender: 'female', tier: 'Iron', bg: '#7f8c8d', minLevel: 3, premiumRequired: false },
                { id: 'f_iron3', name: 'Iron Huntress', icon: '🦊', gender: 'female', tier: 'Iron', bg: '#7f8c8d', minLevel: 5, premiumRequired: false },
                { id: 'f_iron4', name: 'Iron Warden', icon: '🌿', gender: 'female', tier: 'Iron', bg: '#6b7280', minLevel: 8, premiumRequired: false },
                // Bronze Tier
                { id: 'f_brnz1', name: 'Bronze Ranger', icon: '🌲', gender: 'female', tier: 'Bronze', bg: '#cd7f32', minLevel: 10, premiumRequired: false },
                { id: 'f_brnz2', name: 'Bronze Valkyrie', icon: '🦋', gender: 'female', tier: 'Bronze', bg: '#b8860b', minLevel: 12, premiumRequired: false },
                { id: 'f_brnz3', name: 'Bronze Shaman', icon: '🌺', gender: 'female', tier: 'Bronze', bg: '#b8860b', minLevel: 15, premiumRequired: false },
                { id: 'f_brnz4', name: 'Bronze Champion', icon: '🐺', gender: 'female', tier: 'Bronze', bg: '#a0522d', minLevel: 18, premiumRequired: false },
                // Silver Tier
                { id: 'f_silv1', name: 'Silver Sentinel', icon: '🌸', gender: 'female', tier: 'Silver', bg: '#60a5fa', minLevel: 20, premiumRequired: false },
                { id: 'f_silv2', name: 'Silver Sorceress', icon: '💠', gender: 'female', tier: 'Silver', bg: '#3b82f6', minLevel: 22, premiumRequired: false },
                { id: 'f_silv3', name: 'Silver Rogue', icon: '🌊', gender: 'female', tier: 'Silver', bg: '#2563eb', minLevel: 25, premiumRequired: false },
                { id: 'f_silv4', name: 'Silver Paladin', icon: '⚜️', gender: 'female', tier: 'Silver', bg: '#1d4ed8', minLevel: 28, premiumRequired: false },
                // Gold Tier
                { id: 'f_gold1', name: 'Gold Enchantress', icon: '✨', gender: 'female', tier: 'Gold', bg: '#f59e0b', minLevel: 30, premiumRequired: false },
                { id: 'f_gold2', name: 'Gold Templar', icon: '🌞', gender: 'female', tier: 'Gold', bg: '#d97706', minLevel: 33, premiumRequired: true },
                { id: 'f_gold3', name: 'Gold Titan', icon: '🦁', gender: 'female', tier: 'Gold', bg: '#b45309', minLevel: 36, premiumRequired: true },
                { id: 'f_gold4', name: 'Gold Overlord', icon: '🔱', gender: 'female', tier: 'Gold', bg: '#92400e', minLevel: 39, premiumRequired: true },
                // Platinum Tier
                { id: 'f_plat1', name: 'Platinum Mage', icon: '💎', gender: 'female', tier: 'Platinum', bg: '#06b6d4', minLevel: 40, premiumRequired: true },
                { id: 'f_plat2', name: 'Platinum Specter', icon: '🌀', gender: 'female', tier: 'Platinum', bg: '#0891b2', minLevel: 43, premiumRequired: true },
                { id: 'f_plat3', name: 'Platinum Oracle', icon: '🔮', gender: 'female', tier: 'Platinum', bg: '#0e7490', minLevel: 46, premiumRequired: true },
                { id: 'f_plat4', name: 'Platinum Empress', icon: '👸', gender: 'female', tier: 'Platinum', bg: '#155e75', minLevel: 49, premiumRequired: true },
                // Diamond Tier
                { id: 'f_diam1', name: 'Diamond Witch', icon: '💜', gender: 'female', tier: 'Diamond', bg: '#8b5cf6', minLevel: 50, premiumRequired: true },
                { id: 'f_diam2', name: 'Diamond Phantom', icon: '🌙', gender: 'female', tier: 'Diamond', bg: '#7c3aed', minLevel: 53, premiumRequired: true },
                { id: 'f_diam3', name: 'Diamond Rift', icon: '🌌', gender: 'female', tier: 'Diamond', bg: '#6d28d9', minLevel: 56, premiumRequired: true },
                { id: 'f_diam4', name: 'Diamond Goddess', icon: '⭐', gender: 'female', tier: 'Diamond', bg: '#5b21b6', minLevel: 59, premiumRequired: true },
                // Master Tier
                { id: 'f_mast1', name: 'Master Invoker', icon: '🐉', gender: 'female', tier: 'Master', bg: '#f97316', minLevel: 60, premiumRequired: true },
                { id: 'f_mast2', name: 'Master Pyromancer', icon: '🌋', gender: 'female', tier: 'Master', bg: '#ea580c', minLevel: 63, premiumRequired: true },
                { id: 'f_mast3', name: 'Master Fury', icon: '🦅', gender: 'female', tier: 'Master', bg: '#dc2626', minLevel: 66, premiumRequired: true },
                { id: 'f_mast4', name: 'Master Reaper', icon: '🌹', gender: 'female', tier: 'Master', bg: '#b91c1c', minLevel: 69, premiumRequired: true },
                // Grandmaster Tier
                { id: 'f_gm1', name: 'Grandmaster Sage', icon: '🦄', gender: 'female', tier: 'Grandmaster', bg: '#ec4899', minLevel: 70, premiumRequired: true },
                { id: 'f_gm2', name: 'Grandmaster Oracle', icon: '🌟', gender: 'female', tier: 'Grandmaster', bg: '#db2777', minLevel: 73, premiumRequired: true },
                { id: 'f_gm3', name: 'GM Mystic', icon: '🕊️', gender: 'female', tier: 'Grandmaster', bg: '#be185d', minLevel: 76, premiumRequired: true },
                { id: 'f_gm4', name: 'GM Vanguard', icon: '💫', gender: 'female', tier: 'Grandmaster', bg: '#9d174d', minLevel: 79, premiumRequired: true },
                // Challenger Tier
                { id: 'f_chal1', name: 'Challenger Nexus', icon: '☀️', gender: 'female', tier: 'Challenger', bg: '#fbbf24', minLevel: 80, premiumRequired: true },
                { id: 'f_chal2', name: 'Challenger Sarveik', icon: '🌺', gender: 'female', tier: 'Challenger', bg: '#f59e0b', minLevel: 83, premiumRequired: true },
                { id: 'f_chal3', name: 'Challenger Storm', icon: '🌪️', gender: 'female', tier: 'Challenger', bg: '#d97706', minLevel: 86, premiumRequired: true },
                { id: 'f_chal4', name: 'Challenger Apex', icon: '💥', gender: 'female', tier: 'Challenger', bg: '#b45309', minLevel: 89, premiumRequired: true },
                // Legendary Tier
                { id: 'f_leg1', name: 'Legendary Empress', icon: '👑', gender: 'female', tier: 'Legendary', bg: 'linear-gradient(135deg,#ec4899,#f59e0b)', minLevel: 90, premiumRequired: true },
                { id: 'f_leg2', name: 'Legendary Phoenix', icon: '🦜', gender: 'female', tier: 'Legendary', bg: 'linear-gradient(135deg,#8b5cf6,#ec4899)', minLevel: 93, premiumRequired: true },
                { id: 'f_leg3', name: 'Legendary Eternal', icon: '🌸', gender: 'female', tier: 'Legendary', bg: 'linear-gradient(135deg,#06b6d4,#ec4899)', minLevel: 95, premiumRequired: true },
                { id: 'f_leg4', name: 'Legendary Goddess', icon: '🌙', gender: 'female', tier: 'Legendary', bg: 'linear-gradient(135deg,#fbbf24,#8b5cf6,#ec4899)', minLevel: 98, premiumRequired: true },
                { id: 'f_leg5', name: 'Sarveik Absolute', icon: '✨', gender: 'female', tier: 'Legendary', bg: 'linear-gradient(135deg,#fbbf24,#8b5cf6,#06b6d4)', minLevel: 100, premiumRequired: true }
            ]
        };
        
        // Combine all avatars
        const allAvatars = [...avatars.male, ...avatars.female];
        
        // Check which avatars are unlocked
        const unlockedAvatars = [];
        for (const avatar of allAvatars) {
            const isUnlocked = ownedAvatars[avatar.id] !== undefined;
            const isActive = ownedAvatars[avatar.id] === true;
            
            unlockedAvatars.push({
                ...avatar,
                unlocked: isUnlocked,
                active: isActive,
                canUnlock: !isUnlocked && userLevel >= avatar.minLevel && (!avatar.premiumRequired || isPremium)
            });
        }
        
        res.json({
            avatars: unlockedAvatars,
            userLevel,
            isPremium,
            ownedAvatars: Object.keys(ownedAvatars)
        });
        
    } catch (err) {
        console.error('Error fetching avatar gallery:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Unlock an avatar
app.post('/api/avatars/unlock', isAuthenticated, async (req, res) => {
    const { avatarId } = req.body;
    
    if (!avatarId) {
        return res.status(400).json({ error: 'Avatar ID is required' });
    }
    
    try {
        const userId = req.session.userId;
        
        // Check if already unlocked
        const existing = await pool.query(
            'SELECT id FROM user_avatars WHERE user_id = $1 AND avatar_id = $2',
            [userId, avatarId]
        );
        
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Avatar already unlocked' });
        }
        
        // Get user level and premium status
        const userResult = await pool.query(
            'SELECT level, premium_until FROM users WHERE id = $1',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userLevel = userResult.rows[0].level || 1;
        const isPremium = userResult.rows[0].premium_until && new Date(userResult.rows[0].premium_until) > new Date();
        
        // Define avatar requirements (simplified check)
        const avatarRequirements = {
            // Male avatars
            'm_iron1': { minLevel: 1, premiumRequired: false },
            'm_iron2': { minLevel: 3, premiumRequired: false },
            'm_iron3': { minLevel: 5, premiumRequired: false },
            'm_iron4': { minLevel: 8, premiumRequired: false },
            'm_brnz1': { minLevel: 10, premiumRequired: false },
            'm_brnz2': { minLevel: 12, premiumRequired: false },
            'm_brnz3': { minLevel: 15, premiumRequired: false },
            'm_brnz4': { minLevel: 18, premiumRequired: false },
            'm_silv1': { minLevel: 20, premiumRequired: false },
            'm_silv2': { minLevel: 22, premiumRequired: false },
            'm_silv3': { minLevel: 25, premiumRequired: false },
            'm_silv4': { minLevel: 28, premiumRequired: false },
            'm_gold1': { minLevel: 30, premiumRequired: false },
            'm_gold2': { minLevel: 33, premiumRequired: true },
            'm_gold3': { minLevel: 36, premiumRequired: true },
            'm_gold4': { minLevel: 39, premiumRequired: true },
            'm_plat1': { minLevel: 40, premiumRequired: true },
            'm_plat2': { minLevel: 43, premiumRequired: true },
            'm_plat3': { minLevel: 46, premiumRequired: true },
            'm_plat4': { minLevel: 49, premiumRequired: true },
            'm_diam1': { minLevel: 50, premiumRequired: true },
            'm_diam2': { minLevel: 53, premiumRequired: true },
            'm_diam3': { minLevel: 56, premiumRequired: true },
            'm_diam4': { minLevel: 59, premiumRequired: true },
            'm_mast1': { minLevel: 60, premiumRequired: true },
            'm_mast2': { minLevel: 63, premiumRequired: true },
            'm_mast3': { minLevel: 66, premiumRequired: true },
            'm_mast4': { minLevel: 69, premiumRequired: true },
            'm_gm1': { minLevel: 70, premiumRequired: true },
            'm_gm2': { minLevel: 73, premiumRequired: true },
            'm_gm3': { minLevel: 76, premiumRequired: true },
            'm_gm4': { minLevel: 79, premiumRequired: true },
            'm_chal1': { minLevel: 80, premiumRequired: true },
            'm_chal2': { minLevel: 83, premiumRequired: true },
            'm_chal3': { minLevel: 86, premiumRequired: true },
            'm_chal4': { minLevel: 89, premiumRequired: true },
            'm_leg1': { minLevel: 90, premiumRequired: true },
            'm_leg2': { minLevel: 93, premiumRequired: true },
            'm_leg3': { minLevel: 95, premiumRequired: true },
            'm_leg4': { minLevel: 98, premiumRequired: true },
            'm_leg5': { minLevel: 100, premiumRequired: true },
            // Female avatars (same requirements)
            'f_iron1': { minLevel: 1, premiumRequired: false },
            'f_iron2': { minLevel: 3, premiumRequired: false },
            'f_iron3': { minLevel: 5, premiumRequired: false },
            'f_iron4': { minLevel: 8, premiumRequired: false },
            'f_brnz1': { minLevel: 10, premiumRequired: false },
            'f_brnz2': { minLevel: 12, premiumRequired: false },
            'f_brnz3': { minLevel: 15, premiumRequired: false },
            'f_brnz4': { minLevel: 18, premiumRequired: false },
            'f_silv1': { minLevel: 20, premiumRequired: false },
            'f_silv2': { minLevel: 22, premiumRequired: false },
            'f_silv3': { minLevel: 25, premiumRequired: false },
            'f_silv4': { minLevel: 28, premiumRequired: false },
            'f_gold1': { minLevel: 30, premiumRequired: false },
            'f_gold2': { minLevel: 33, premiumRequired: true },
            'f_gold3': { minLevel: 36, premiumRequired: true },
            'f_gold4': { minLevel: 39, premiumRequired: true },
            'f_plat1': { minLevel: 40, premiumRequired: true },
            'f_plat2': { minLevel: 43, premiumRequired: true },
            'f_plat3': { minLevel: 46, premiumRequired: true },
            'f_plat4': { minLevel: 49, premiumRequired: true },
            'f_diam1': { minLevel: 50, premiumRequired: true },
            'f_diam2': { minLevel: 53, premiumRequired: true },
            'f_diam3': { minLevel: 56, premiumRequired: true },
            'f_diam4': { minLevel: 59, premiumRequired: true },
            'f_mast1': { minLevel: 60, premiumRequired: true },
            'f_mast2': { minLevel: 63, premiumRequired: true },
            'f_mast3': { minLevel: 66, premiumRequired: true },
            'f_mast4': { minLevel: 69, premiumRequired: true },
            'f_gm1': { minLevel: 70, premiumRequired: true },
            'f_gm2': { minLevel: 73, premiumRequired: true },
            'f_gm3': { minLevel: 76, premiumRequired: true },
            'f_gm4': { minLevel: 79, premiumRequired: true },
            'f_chal1': { minLevel: 80, premiumRequired: true },
            'f_chal2': { minLevel: 83, premiumRequired: true },
            'f_chal3': { minLevel: 86, premiumRequired: true },
            'f_chal4': { minLevel: 89, premiumRequired: true },
            'f_leg1': { minLevel: 90, premiumRequired: true },
            'f_leg2': { minLevel: 93, premiumRequired: true },
            'f_leg3': { minLevel: 95, premiumRequired: true },
            'f_leg4': { minLevel: 98, premiumRequired: true },
            'f_leg5': { minLevel: 100, premiumRequired: true }
        };
        
        const requirements = avatarRequirements[avatarId];
        if (!requirements) {
            return res.status(400).json({ error: 'Invalid avatar ID' });
        }
        
        if (userLevel < requirements.minLevel) {
            return res.status(400).json({ error: `Level ${requirements.minLevel} required to unlock this avatar` });
        }
        
        if (requirements.premiumRequired && !isPremium) {
            return res.status(400).json({ error: 'Premium membership required to unlock this avatar' });
        }
        
        // Unlock the avatar
        await pool.query(
            `INSERT INTO user_avatars (user_id, avatar_id, unlocked_at)
             VALUES ($1, $2, NOW())`,
            [userId, avatarId]
        );
        
        res.json({ success: true, message: 'Avatar unlocked successfully!' });
        
    } catch (err) {
        console.error('Error unlocking avatar:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Set active avatar
app.post('/api/avatars/select', isAuthenticated, async (req, res) => {
    const { avatarId } = req.body;
    
    try {
        const userId = req.session.userId;
        
        // Check if user owns this avatar
        const owned = await pool.query(
            'SELECT id FROM user_avatars WHERE user_id = $1 AND avatar_id = $2',
            [userId, avatarId]
        );
        
        if (owned.rows.length === 0) {
            return res.status(400).json({ error: 'You do not own this avatar' });
        }
        
        // Deactivate all avatars for this user
        await pool.query(
            'UPDATE user_avatars SET is_active = false WHERE user_id = $1',
            [userId]
        );
        
        // Activate selected avatar
        await pool.query(
            'UPDATE user_avatars SET is_active = true WHERE user_id = $1 AND avatar_id = $2',
            [userId, avatarId]
        );
        
        // Also update the user's avatar style
        await pool.query(
            'UPDATE users SET avatar_style = $1 WHERE id = $2',
            [avatarId, userId]
        );
        
        res.json({ success: true, message: 'Avatar selected!' });
        
    } catch (err) {
        console.error('Error selecting avatar:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user's current avatar
app.get('/api/avatars/current', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        
        const result = await pool.query(
            'SELECT avatar_url, avatar_style FROM users WHERE id = $1',
            [userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = result.rows[0];
        let currentAvatar = null;
        
        // Check if user has an active gallery avatar
        if (user.avatar_style && user.avatar_style !== 'default' && user.avatar_style !== 'uploaded') {
            const active = await pool.query(
                'SELECT avatar_id FROM user_avatars WHERE user_id = $1 AND is_active = true',
                [userId]
            );
            
            if (active.rows.length > 0) {
                currentAvatar = {
                    type: 'gallery',
                    id: active.rows[0].avatar_id
                };
            }
        }
        
        res.json({
            avatarUrl: user.avatar_url || null,
            avatarStyle: user.avatar_style || 'default',
            currentAvatar: currentAvatar
        });
        
    } catch (err) {
        console.error('Error getting current avatar:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== TOOL SUBMISSION & APPROVAL ====================
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

app.get('/api/admin/tools/pending', isAdminOrModerator, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT t.*, u.username as submitted_by, u.email as submitter_email
             FROM tools t LEFT JOIN users u ON t.user_id = u.id
             WHERE t.approved = false OR t.approved IS NULL
             ORDER BY t.submitted_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/tools', isAdminOrModerator, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT t.*, u.username as submitted_by,
                    (SELECT COUNT(*) FROM tool_usage WHERE tool_name = t.name) as usage_count,
                    COALESCE(t.is_featured, false) as is_featured
             FROM tools t LEFT JOIN users u ON t.user_id = u.id
             ORDER BY t.id DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/admin/tools/:id/approve', isAdmin, async (req, res) => {
    const toolId = req.params.id;
    try {
        const toolResult = await pool.query(
            `SELECT t.*, u.email as submitter_email, u.username as submitter_name
             FROM tools t LEFT JOIN users u ON t.user_id = u.id WHERE t.id = $1`,
            [toolId]
        );
        if (toolResult.rows.length === 0) return res.status(404).json({ error: 'Tool not found' });
        const tool = toolResult.rows[0];
 
        await pool.query('UPDATE tools SET approved = true WHERE id = $1', [toolId]);
 
        if (tool.user_id) {
            const approvalBonus = 25;
            await pool.query(
                `UPDATE user_credits SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
                 WHERE user_id = $2`,
                [approvalBonus, tool.user_id]
            );
            await pool.query(
                `INSERT INTO credit_transactions (user_id, amount, type, description)
                 VALUES ($1, $2, 'earn', $3)`,
                [tool.user_id, approvalBonus, `Tool approved: ${tool.name}`]
            );
            if (tool.submitter_email) {
                await sendToolApprovalEmail(tool.submitter_email, tool.submitter_name, tool.name);
            }
        }
        res.json({ success: true, message: 'Tool approved! User awarded 25 credits.' });
    } catch (err) {
        console.error('Approval error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/users/:id/credits', isAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    let { amount, reason } = req.body;
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    try {
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
        if (userCheck.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        await ensureUserCredits(userId);
        await pool.query(
            `UPDATE user_credits SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
             WHERE user_id = $2`,
            [numericAmount, userId]
        );
        await pool.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'earn', $3)`,
            [userId, numericAmount, reason?.trim() || `Admin added ${numericAmount} credits`]
        );
        res.json({ success: true, message: `Added ${numericAmount} credits to user ${userId}` });
    } catch (err) {
        console.error('Error giving credits:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/bulk-email', isAdmin, async (req, res) => {
    const { userIds, subject, htmlContent } = req.body;
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'No users selected' });
    }
    if (!subject || !htmlContent) {
        return res.status(400).json({ error: 'Subject and content are required' });
    }
    try {
        const placeholders = userIds.map((_, i) => `$${i+1}`).join(',');
        const users = await pool.query(`SELECT id, email, username FROM users WHERE id IN (${placeholders})`, userIds);
        let successCount = 0, failCount = 0;
        for (const user of users.rows) {
            const ok = await sendEmail(user.email, subject, htmlContent);
            if (ok.success) successCount++;
            else failCount++;
        }
        await pool.query(
            `INSERT INTO moderator_activity (moderator_id, moderator_name, action, target, details)
             VALUES ($1, $2, $3, $4, $5)`,
            [req.session.userId, req.session.username, 'Bulk email', `${successCount} users`, `Subject: ${subject}`]
        );
        res.json({ success: true, successCount, failCount });
    } catch (err) {
        console.error('Bulk email error:', err);
        res.status(500).json({ error: 'Failed to send emails' });
    }
});

app.delete('/api/admin/tools/:id/reject', isAdmin, async (req, res) => {
    const toolId = req.params.id;
    const { reason } = req.body;
    try {
        const toolResult = await pool.query(
            `SELECT t.name, t.user_id, u.email as submitter_email, u.username as submitter_name
             FROM tools t LEFT JOIN users u ON t.user_id = u.id WHERE t.id = $1`,
            [toolId]
        );
        if (toolResult.rows.length === 0) return res.status(404).json({ error: 'Tool not found' });
        const tool = toolResult.rows[0];
        if (tool.submitter_email) {
            await sendToolRejectionEmail(tool.submitter_email, tool.submitter_name || 'User', tool.name, reason);
        }
        await pool.query('DELETE FROM tools WHERE id = $1', [toolId]);
        res.json({ success: true, message: 'Tool rejected and removed.' });
    } catch (err) {
        console.error('Rejection error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

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

app.get('/api/tools/recent', isAuthenticated, async (req, res) => {
    const { limit = 50, page } = req.query;
    try {
        let query = `
            SELECT t.*, u.username as submitted_by
            FROM tools t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.approved = true
        `;
        const params = [];
        let paramIdx = 1;
        if (page && page !== 'all') {
            query += ` AND t.page_type = $${paramIdx}`;
            params.push(page);
            paramIdx++;
        }
        query += ` ORDER BY t.created_at DESC LIMIT $${paramIdx}`;
        params.push(parseInt(limit));
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/tools', isAdmin, async (req, res) => {
    const { name, url, description, category, approved, pageType, is_premium, is_featured } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL are required' });
    try {
        const result = await pool.query(
            `INSERT INTO tools (name, url, description, category, approved, page_type, is_premium, is_featured, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
            [name, url, description || '', category || 'study',
             approved === undefined ? true : approved,
             pageType || 'student', is_premium || false, is_featured || false]
        );
        res.status(201).json({ success: true, toolId: result.rows[0].id });
    } catch (err) {
        console.error('Add tool error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/admin/tools/:id', isAdmin, async (req, res) => {
    const { name, url, description, category, approved, pageType, is_premium, is_featured } = req.body;
    try {
        await pool.query(
            `UPDATE tools SET name=$1, url=$2, description=$3, category=$4,
             approved=$5, page_type=$6, is_premium=$7, is_featured=$8
             WHERE id=$9`,
            [name, url, description || '', category || 'study',
             approved, pageType || 'student', is_premium || false, is_featured || false,
             req.params.id]
        );
        res.json({ success: true, message: 'Tool updated' });
    } catch (err) {
        console.error('Update tool error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/admin/tools/:id', isAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM tools WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== BUSINESS DIRECTORY ENDPOINTS ====================

app.get('/api/businesses', async (req, res) => {
    const { category, city, search, verifiedOnly, featured, limit = 50, offset = 0 } = req.query;

    let query = `
        SELECT id, name, type, category, description, address, city, state,
               phone, email, website, whatsapp, maps, instagram, facebook,
               hours, amenities, verified, featured, created_at,
               COALESCE(views, 0) as views, 
               COALESCE(avg_rating, 0) as avg_rating,
               COALESCE(total_reviews, 0) as total_reviews,
               lat, lng, delivery_radius, is_delivery_enabled
        FROM businesses
        WHERE approved = true
    `;
    const params = [];
    let paramIndex = 1;

    if (category && category !== 'all') {
        query += ` AND category = $${paramIndex++}`;
        params.push(category);
    }
    if (city && city !== 'all') {
        query += ` AND city = $${paramIndex++}`;
        params.push(city);
    }
    if (verifiedOnly === 'true') {
        query += ` AND verified = true`;
    }
    if (featured === 'true') {
        query += ` AND featured = true`;
    }
    if (search) {
        query += ` AND (name ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR address ILIKE $${paramIndex} OR city ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
    }

    query += ` ORDER BY featured DESC, created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    try {
        const result = await pool.query(query, params);
        
        let countQuery = `SELECT COUNT(*) as total FROM businesses WHERE approved = true`;
        const countParams = [];
        let countIndex = 1;
        if (category && category !== 'all') {
            countQuery += ` AND category = $${countIndex++}`;
            countParams.push(category);
        }
        if (city && city !== 'all') {
            countQuery += ` AND city = $${countIndex++}`;
            countParams.push(city);
        }
        if (verifiedOnly === 'true') {
            countQuery += ` AND verified = true`;
        }
        if (search) {
            countQuery += ` AND (name ILIKE $${countIndex} OR description ILIKE $${countIndex})`;
            countParams.push(`%${search}%`);
        }
        
        const countResult = await pool.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0]?.total || 0);
        
        console.log(`✅ Found ${result.rows.length} businesses (Total: ${total})`);
        
        res.json({
            businesses: result.rows,
            total: total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (err) {
        console.error('Error fetching businesses:', err);
        res.json({ businesses: [], total: 0, limit: parseInt(limit), offset: parseInt(offset) });
    }
});

app.get('/api/businesses/:id', async (req, res) => {
    const businessId = req.params.id;
    
    if (isNaN(businessId) || businessId === 'cities' || businessId === 'categories') {
        return res.status(400).json({ error: 'Invalid business ID format' });
    }
    
    try {
        const result = await pool.query(
            `SELECT b.*, u.username as owner_name, u.email as owner_email
             FROM businesses b
             LEFT JOIN users u ON b.user_id = u.id
             WHERE b.id = $1 AND b.approved = true`,
            [businessId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }
        
        await pool.query(
            `UPDATE businesses SET views = COALESCE(views, 0) + 1 WHERE id = $1`,
            [businessId]
        );
        
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching business:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/businesses/:id/reviews', async (req, res) => {
    const businessId = req.params.id;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    
    try {
        const result = await pool.query(
            `SELECT r.*, u.username, u.avatar_url
             FROM business_reviews r
             LEFT JOIN users u ON r.user_id = u.id
             WHERE r.business_id = $1 AND (r.is_approved = true OR r.is_approved IS NULL)
             ORDER BY r.created_at DESC
             LIMIT $2 OFFSET $3`,
            [businessId, limit, offset]
        );
        
        const countResult = await pool.query(
            `SELECT COUNT(*) FROM business_reviews WHERE business_id = $1 AND (is_approved = true OR is_approved IS NULL)`,
            [businessId]
        );
        
        res.json({
            reviews: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit,
            offset
        });
    } catch (err) {
        console.error('Error fetching business reviews:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/businesses/:id/ratings', async (req, res) => {
    const businessId = req.params.id;
    try {
        const result = await pool.query(
            `SELECT 
                COALESCE(AVG(rating), 0) as average_rating,
                COUNT(*) as total_reviews
             FROM business_reviews
             WHERE business_id = $1 AND (is_approved = true OR is_approved IS NULL)`,
            [businessId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching business ratings:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/businesses/states', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT state FROM businesses 
            WHERE approved = true AND state IS NOT NULL AND state != ''
            ORDER BY state
        `);
        res.json(result.rows.map(r => r.state));
    } catch (err) {
        console.error('Error fetching states:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/businesses/districts', async (req, res) => {
    const { state } = req.query;
    if (!state) return res.status(400).json({ error: 'State parameter is required' });
    try {
        const result = await pool.query(`
            SELECT DISTINCT district FROM businesses 
            WHERE approved = true AND state = $1 AND district IS NOT NULL AND district != ''
            ORDER BY district
        `, [state]);
        res.json(result.rows.map(r => r.district));
    } catch (err) {
        console.error('Error fetching districts:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/businesses/categories', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT category, COUNT(*) as count 
            FROM businesses 
            WHERE approved = true AND category IS NOT NULL
            GROUP BY category 
            ORDER BY count DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching categories:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/businesses/submit', isAuthenticated, async (req, res) => {
    const {
        name, type, category, description, address, city, state, phone, email,
        website, whatsapp, maps, instagram, facebook, hours, amenities,
        lat, lng, delivery_radius
    } = req.body;

    if (!name || !type || !address || !city || !phone || !email) {
        return res.status(400).json({ error: 'Missing required fields: name, type, address, city, phone, email are required' });
    }

    try {
        const columnsCheck = await pool.query(`
            SELECT column_name FROM information_schema.columns WHERE table_name = 'businesses'
        `);
        const existingColumns = columnsCheck.rows.map(c => c.column_name);
        
        const insertColumns = ['name', 'type', 'category', 'description', 'address', 'city', 'state', 'phone', 'email', 'website', 'whatsapp', 'hours', 'amenities', 'user_id', 'approved', 'created_at', 'updated_at', 'lat', 'lng', 'delivery_radius', 'is_delivery_enabled'];
        const insertValues = [
            name, type, category || 'other', description || '', address, city, state || null, phone, email,
            website || null, whatsapp || null,
            hours ? JSON.stringify(hours) : null,
            amenities ? JSON.stringify(amenities) : null,
            req.session.userId, false, new Date(), new Date(),
            lat || null, lng || null, delivery_radius || 10, true
        ];
        
        let colIndex = insertColumns.length;
        if (existingColumns.includes('maps')) {
            insertColumns.push('maps');
            insertValues.push(maps || null);
        }
        if (existingColumns.includes('instagram')) {
            insertColumns.push('instagram');
            insertValues.push(instagram || null);
        }
        if (existingColumns.includes('facebook')) {
            insertColumns.push('facebook');
            insertValues.push(facebook || null);
        }
        
        const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
        const query = `INSERT INTO businesses (${insertColumns.join(', ')}) VALUES (${placeholders}) RETURNING id`;
        
        const result = await pool.query(query, insertValues);
        const businessId = result.rows[0].id;

        io.to('admin_room').emit('new_business_pending', {
            id: businessId,
            name: name,
            submittedBy: req.session.username
        });

        res.status(201).json({
            success: true,
            message: 'Business submitted for review. You will earn 15 credits upon approval!',
            id: businessId
        });
    } catch (err) {
        console.error('Business submission error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.post('/api/businesses/:id/reviews', isAuthenticated, async (req, res) => {
    const businessId = req.params.id;
    const { rating, comment, title } = req.body;
    
    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    
    try {
        const business = await pool.query(
            `SELECT id FROM businesses WHERE id = $1 AND approved = true`,
            [businessId]
        );
        if (business.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }
        
        const existingReview = await pool.query(
            `SELECT id FROM business_reviews WHERE business_id = $1 AND user_id = $2`,
            [businessId, req.session.userId]
        );
        
        if (existingReview.rows.length > 0) {
            return res.status(400).json({ error: 'You have already reviewed this business' });
        }
        
        await pool.query(`
            INSERT INTO business_reviews (business_id, user_id, rating, comment, title, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
        `, [businessId, req.session.userId, rating, comment || null, title || null]);
        
        await pool.query(`
            UPDATE businesses 
            SET avg_rating = (
                SELECT COALESCE(AVG(rating), 0) FROM business_reviews 
                WHERE business_id = $1 AND (is_approved = true OR is_approved IS NULL)
            ),
            total_reviews = (
                SELECT COUNT(*) FROM business_reviews 
                WHERE business_id = $1 AND (is_approved = true OR is_approved IS NULL)
            )
            WHERE id = $1
        `, [businessId]);
        
        res.json({ success: true, message: 'Review submitted successfully!' });
    } catch (err) {
        console.error('Review submission error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/businesses/:id/favorite', isAuthenticated, async (req, res) => {
    const businessId = req.params.id;
    
    try {
        const existing = await pool.query(
            `SELECT id FROM business_favorites WHERE business_id = $1 AND user_id = $2`,
            [businessId, req.session.userId]
        );
        
        if (existing.rows.length > 0) {
            await pool.query(
                `DELETE FROM business_favorites WHERE business_id = $1 AND user_id = $2`,
                [businessId, req.session.userId]
            );
            res.json({ success: true, favorited: false });
        } else {
            await pool.query(
                `INSERT INTO business_favorites (business_id, user_id, created_at)
                 VALUES ($1, $2, NOW())`,
                [businessId, req.session.userId]
            );
            res.json({ success: true, favorited: true });
        }
    } catch (err) {
        console.error('Favorite toggle error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/user/favorites', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.* 
            FROM businesses b
            JOIN business_favorites f ON b.id = f.business_id
            WHERE f.user_id = $1 AND b.approved = true
            ORDER BY f.created_at DESC
        `, [req.session.userId]);
        
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch favorites error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/businesses/pending', isAdminOrModerator, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, u.username as submitter_name, u.email as submitter_email
            FROM businesses b
            LEFT JOIN users u ON b.user_id = u.id
            WHERE b.approved = false OR b.approved IS NULL
            ORDER BY b.created_at DESC
        `);
        res.json({ businesses: result.rows });
    } catch (err) {
        console.error('Error fetching pending businesses:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/businesses/approved', isAdminOrModerator, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, u.username as submitter_name, u.email as submitter_email
            FROM businesses b
            LEFT JOIN users u ON b.user_id = u.id
            WHERE b.approved = true
            ORDER BY b.created_at DESC
        `);
        res.json({ businesses: result.rows });
    } catch (err) {
        console.error('Error fetching approved businesses:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/businesses/:id/approve', isAdmin, async (req, res) => {
    const businessId = req.params.id;
    
    try {
        console.log(`📝 Approving business ID: ${businessId}`);
        
        const bizResult = await pool.query(
            `SELECT b.*, u.email as submitter_email, u.username as submitter_name, u.id as user_id
             FROM businesses b
             LEFT JOIN users u ON b.user_id = u.id
             WHERE b.id = $1`,
            [businessId]
        );
        
        if (bizResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }
        
        const biz = bizResult.rows[0];
        
        if (biz.approved === true) {
            return res.status(400).json({ error: 'Business already approved' });
        }

        const updateResult = await pool.query(
            `UPDATE businesses 
             SET approved = true, 
                 updated_at = NOW(),
                 approved_at = NOW()
             WHERE id = $1 
             RETURNING id, approved`,
            [businessId]
        );
        
        if (updateResult.rowCount === 0) {
            return res.status(500).json({ error: 'Failed to update business approval status' });
        }

        console.log(`✅ Business ${businessId} (${biz.name}) approved in database`);

        if (biz.user_id) {
            await awardCreditsForBusinessApproval(biz.user_id, biz.name);
            
            if (biz.submitter_email) {
                await sendBusinessApprovalEmail(biz.submitter_email, biz.submitter_name || biz.name, biz.name, 15);
            }
        }

        await pool.query(
            `INSERT INTO moderator_activity (moderator_id, moderator_name, action, target, details, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [req.session.userId, req.session.username, 'Approve business', `Business ID ${businessId}`, `Approved ${biz.name} - User earned 15 credits`]
        );

        if (biz.user_id) {
            const userSocket = onlineUsers.get(biz.user_id);
            if (userSocket && userSocket.socketId) {
                io.to(userSocket.socketId).emit('business_approved', {
                    id: businessId,
                    name: biz.name,
                    credits: 15
                });
            }
        }

        res.json({ 
            success: true, 
            message: 'Business approved and user awarded 15 credits.',
            business: { id: businessId, name: biz.name, approved: true }
        });
        
    } catch (err) {
        console.error('Business approval error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.delete('/api/admin/businesses/:id/reject', isAdmin, async (req, res) => {
    const businessId = req.params.id;
    const { reason } = req.body;
    
    try {
        const bizResult = await pool.query(
            `SELECT b.*, u.email as submitter_email, u.username as submitter_name
             FROM businesses b
             LEFT JOIN users u ON b.user_id = u.id
             WHERE b.id = $1`,
            [businessId]
        );
        
        if (bizResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }
        
        const biz = bizResult.rows[0];

        if (biz.submitter_email) {
            await sendBusinessRejectionEmail(biz.submitter_email, biz.submitter_name, biz.name, reason);
        }

        await pool.query(`DELETE FROM businesses WHERE id = $1`, [businessId]);

        res.json({ success: true, message: 'Business rejected and removed.' });
    } catch (err) {
        console.error('Business rejection error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/admin/businesses/:id', isAdminOrModerator, async (req, res) => {
    const businessId = req.params.id;
    const {
        name, type, category, description, address, city, state, phone, email,
        website, whatsapp, maps, instagram, facebook, verified, featured
    } = req.body;
    
    try {
        const existing = await pool.query('SELECT id FROM businesses WHERE id = $1', [businessId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        await pool.query(`
            UPDATE businesses SET
                name = $1, type = $2, category = $3, description = $4,
                address = $5, city = $6, state = $7, phone = $8, email = $9,
                website = $10, whatsapp = $11, maps = $12, instagram = $13, facebook = $14,
                verified = $15, featured = $16, updated_at = NOW()
            WHERE id = $17
        `, [name, type, category, description, address, city, state, phone, email,
            website, whatsapp, maps, instagram, facebook, 
            verified === true || verified === 'true', 
            featured === true || featured === 'true', 
            businessId]);

        res.json({ success: true, message: 'Business updated' });
    } catch (err) {
        console.error('Business update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/admin/businesses/:id', isAdmin, async (req, res) => {
    const businessId = req.params.id;
    try {
        const biz = await pool.query('SELECT name FROM businesses WHERE id = $1', [businessId]);
        if (biz.rows.length === 0) return res.status(404).json({ error: 'Business not found' });

        await pool.query(`DELETE FROM businesses WHERE id = $1`, [businessId]);

        res.json({ success: true });
    } catch (err) {
        console.error('Business delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/admin/businesses/:id/toggle-verified', isAdminOrModerator, async (req, res) => {
    const businessId = req.params.id;
    try {
        const result = await pool.query(
            `UPDATE businesses SET verified = NOT verified, updated_at = NOW()
             WHERE id = $1 RETURNING verified`,
            [businessId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Business not found' });
        res.json({ success: true, verified: result.rows[0].verified });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/admin/businesses/:id/toggle-featured', isAdminOrModerator, async (req, res) => {
    const businessId = req.params.id;
    try {
        const result = await pool.query(
            `UPDATE businesses SET featured = NOT featured, updated_at = NOW()
             WHERE id = $1 RETURNING featured`,
            [businessId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Business not found' });
        res.json({ success: true, featured: result.rows[0].featured });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/businesses/stats', isAdminOrModerator, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN approved = true THEN 1 END) as approved,
                COUNT(CASE WHEN approved = false THEN 1 END) as pending,
                COUNT(CASE WHEN verified = true THEN 1 END) as verified,
                COUNT(CASE WHEN featured = true THEN 1 END) as featured,
                COALESCE(SUM(views), 0) as total_views
            FROM businesses
        `);
        res.json(stats.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== SPONSORED ADS SYSTEM ====================

app.get('/api/sponsored/packages', async (req, res) => {
    try {
        const packages = await pool.query(`
            SELECT * FROM sponsored_packages ORDER BY price ASC
        `);
        res.json(packages.rows);
    } catch (err) {
        console.error('Error fetching sponsored packages:', err);
        res.json([
            { name: 'Basic Spotlight', duration_days: 30, price: 499, features: 'Sponsored badge, Priority in search' },
            { name: 'Premium Featured', duration_days: 30, price: 999, features: '⭐ Featured badge, Top position, Custom message' },
            { name: 'Enterprise Dominance', duration_days: 30, price: 1499, features: '👑 Partner badge, Homepage banner, WhatsApp broadcast' }
        ]);
    }
});

app.post('/api/business/sponsor', isAuthenticated, async (req, res) => {
    const { businessId, packageType, customMessage } = req.body;
    
    try {
        const bizCheck = await pool.query(
            'SELECT id, name, user_id FROM businesses WHERE id = $1 AND user_id = $2',
            [businessId, req.session.userId]
        );
        
        if (bizCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Not your business' });
        }
        
        const packageData = await pool.query(
            'SELECT * FROM sponsored_packages WHERE name = $1',
            [packageType]
        );
        
        if (packageData.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid package' });
        }
        
        const pkg = packageData.rows[0];
        
        const credits = await pool.query(
            'SELECT balance FROM user_credits WHERE user_id = $1',
            [req.session.userId]
        );
        
        if ((credits.rows[0]?.balance || 0) < pkg.price) {
            return res.status(400).json({ 
                error: `Need ${pkg.price} credits. Current balance: ${credits.rows[0]?.balance || 0}` 
            });
        }
        
        await pool.query(
            'UPDATE user_credits SET balance = balance - $1 WHERE user_id = $2',
            [pkg.price, req.session.userId]
        );
        
        await pool.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'spend', $3)`,
            [req.session.userId, pkg.price, `Sponsored listing: ${packageType} for ${bizCheck.rows[0].name}`]
        );
        
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + pkg.duration_days);
        
        await pool.query(
            `UPDATE sponsored_listings SET is_active = false 
             WHERE business_id = $1 AND is_active = true`,
            [businessId]
        );
        
        const result = await pool.query(
            `INSERT INTO sponsored_listings (business_id, package_type, start_date, end_date, price_paid, custom_message)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [businessId, packageType, startDate, endDate, pkg.price, customMessage || null]
        );
        
        await pool.query(
            `UPDATE businesses SET featured = true, featured_until = $1 WHERE id = $2`,
            [endDate, businessId]
        );
        
        res.json({ 
            success: true, 
            message: `Business is now sponsored until ${endDate.toLocaleDateString()}!`,
            sponsoredId: result.rows[0].id,
            endDate: endDate
        });
        
    } catch (err) {
        console.error('Sponsorship error:', err);
        res.status(500).json({ error: 'Failed to process sponsorship' });
    }
});

app.get('/api/sponsored/list', async (req, res) => {
    const { category, city, limit = 3 } = req.query;
    
    try {
        let query = `
            SELECT s.*, b.id as business_id, b.name, b.type, b.category, b.city, 
                   b.state, b.phone, b.address, b.avg_rating, b.verified,
                   b.description, s.custom_message as sponsor_message,
                   s.package_type, s.clicks, s.views
            FROM sponsored_listings s
            JOIN businesses b ON s.business_id = b.id
            WHERE s.is_active = true 
            AND s.end_date > NOW()
            AND b.approved = true
        `;
        
        const params = [];
        let paramCount = 1;
        
        if (category && category !== 'all') {
            query += ` AND b.category = $${paramCount}`;
            params.push(category);
            paramCount++;
        }
        
        if (city && city !== 'all') {
            query += ` AND b.city ILIKE $${paramCount}`;
            params.push(`%${city}%`);
            paramCount++;
        }
        
        query += ` ORDER BY 
            CASE s.package_type 
                WHEN 'Enterprise Dominance' THEN 1
                WHEN 'Premium Featured' THEN 2
                WHEN 'Basic Spotlight' THEN 3
            END,
            s.created_at DESC
            LIMIT $${paramCount}`;
        params.push(limit);
        
        const result = await pool.query(query, params);
        
        for (const row of result.rows) {
            await pool.query(
                `UPDATE sponsored_listings SET views = views + 1 WHERE id = $1`,
                [row.id]
            );
        }
        
        res.json(result.rows);
        
    } catch (err) {
        console.error('Error fetching sponsored:', err);
        res.json([]);
    }
});

app.post('/api/sponsored/:id/click', async (req, res) => {
    const sponsoredId = req.params.id;
    const userId = req.session?.userId || null;
    
    try {
        await pool.query(
            `UPDATE sponsored_listings SET clicks = clicks + 1 WHERE id = $1`,
            [sponsoredId]
        );
        
        if (userId) {
            await pool.query(
                `INSERT INTO sponsored_clicks (sponsored_id, user_id, clicked_at)
                 VALUES ($1, $2, NOW())`,
                [sponsoredId, userId]
            );
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Click tracking error:', err);
        res.json({ success: false });
    }
});

app.get('/api/business/sponsor/stats', isAuthenticated, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT s.*, 
                   s.views, 
                   s.clicks,
                   ROUND((s.clicks::DECIMAL / NULLIF(s.views, 0)) * 100, 2) as ctr,
                   b.name as business_name
            FROM sponsored_listings s
            JOIN businesses b ON s.business_id = b.id
            WHERE b.user_id = $1 AND s.is_active = true
            ORDER BY s.created_at DESC
        `, [req.session.userId]);
        
        res.json(stats.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== AFFILIATE COMMISSION SYSTEM ====================

function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

app.post('/api/affiliate/create-link', isAuthenticated, async (req, res) => {
    const { productName, productUrl, commissionRate } = req.body;
    
    if (!productName || !productUrl) {
        return res.status(400).json({ error: 'Product name and URL required' });
    }
    
    try {
        const business = await pool.query(
            'SELECT id, name FROM businesses WHERE user_id = $1',
            [req.session.userId]
        );
        
        if (business.rows.length === 0) {
            return res.status(403).json({ error: 'No business found. List your business first.' });
        }
        
        const businessId = business.rows[0].id;
        
        const result = await pool.query(
            `INSERT INTO affiliate_links (business_id, product_name, product_url, commission_rate)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [businessId, productName, productUrl, commissionRate || 7.00]
        );
        
        const linkId = result.rows[0].id;
        
        const affiliateUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/go/${linkId}`;
        
        res.json({
            success: true,
            affiliateUrl: affiliateUrl,
            linkId: linkId,
            productName: productName,
            commissionRate: commissionRate || 7.00,
            trackingPixel: `<img src="${process.env.FRONTEND_URL}/api/affiliate/pixel/${linkId}" width="1" height="1" />`
        });
        
    } catch (err) {
        console.error('Affiliate link creation error:', err);
        res.status(500).json({ error: 'Failed to create affiliate link' });
    }
});

app.get('/go/:linkId', async (req, res) => {
    const linkId = parseInt(req.params.linkId);
    const userId = req.session?.userId || null;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'] || null;
    
    try {
        const linkData = await pool.query(
            `SELECT al.*, b.name as business_name, b.id as business_id
             FROM affiliate_links al
             JOIN businesses b ON al.business_id = b.id
             WHERE al.id = $1 AND al.is_active = true`,
            [linkId]
        );
        
        if (linkData.rows.length === 0) {
            return res.status(404).send('Affiliate link not found');
        }
        
        const link = linkData.rows[0];
        
        let sessionId = req.cookies?.affiliate_session;
        if (!sessionId) {
            sessionId = generateSessionId();
            res.cookie('affiliate_session', sessionId, {
                maxAge: (link.tracking_days || 30) * 24 * 60 * 60 * 1000,
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax'
            });
        }
        
        res.cookie(`affiliate_source_${link.business_id}`, linkId, {
            maxAge: (link.tracking_days || 30) * 24 * 60 * 60 * 1000,
            httpOnly: false,
            sameSite: 'lax'
        });
        
        const clickResult = await pool.query(
            `INSERT INTO affiliate_clicks (affiliate_link_id, user_id, ip_address, user_agent, referrer, session_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [linkId, userId, ipAddress, userAgent, referrer, sessionId]
        );
        
        await pool.query(
            `UPDATE affiliate_links SET click_count = click_count + 1 WHERE id = $1`,
            [linkId]
        );
        
        const redirectUrl = new URL(link.product_url);
        redirectUrl.searchParams.set('ref', 'sarveik');
        redirectUrl.searchParams.set('affiliate_id', linkId);
        
        res.redirect(redirectUrl.toString());
        
    } catch (err) {
        console.error('Affiliate redirect error:', err);
        res.redirect('/businessdirectory.html');
    }
});

app.post('/api/affiliate/conversion-webhook', async (req, res) => {
    const { 
        affiliate_link_id, 
        order_id, 
        sale_amount, 
        customer_email,
        customer_session_id,
        api_key 
    } = req.body;
    
    const validApiKey = process.env.AFFILIATE_API_KEY || 'test_key_123';
    if (api_key !== validApiKey) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    try {
        let clickId = null;
        
        if (customer_session_id) {
            const click = await pool.query(
                `SELECT id FROM affiliate_clicks 
                 WHERE session_id = $1 
                 ORDER BY clicked_at DESC LIMIT 1`,
                [customer_session_id]
            );
            if (click.rows.length > 0) {
                clickId = click.rows[0].id;
            }
        }
        
        const link = await pool.query(
            `SELECT * FROM affiliate_links WHERE id = $1`,
            [affiliate_link_id]
        );
        
        if (link.rows.length === 0) {
            return res.status(404).json({ error: 'Affiliate link not found' });
        }
        
        const commissionRate = link.rows[0].commission_rate;
        const commissionEarned = (sale_amount * commissionRate) / 100;
        
        await pool.query(
            `INSERT INTO affiliate_conversions (
                affiliate_link_id, click_id, order_id, sale_amount, 
                commission_earned, commission_rate, status
             ) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
             RETURNING id`,
            [affiliate_link_id, clickId, order_id, sale_amount, commissionEarned, commissionRate]
        );
        
        await pool.query(
            `UPDATE affiliate_links 
             SET sale_count = sale_count + 1, 
                 total_revenue = total_revenue + $1,
                 total_commission = total_commission + $2
             WHERE id = $3`,
            [sale_amount, commissionEarned, affiliate_link_id]
        );
        
        res.json({
            success: true,
            commissionEarned: commissionEarned,
            message: `Commission recorded: ₹${commissionEarned} (${commissionRate}% of ₹${sale_amount})`
        });
        
    } catch (err) {
        console.error('Conversion webhook error:', err);
        res.status(500).json({ error: 'Failed to record conversion' });
    }
});

app.post('/api/affiliate/conversion/:conversionId/approve', isAuthenticated, async (req, res) => {
    const conversionId = req.params.conversionId;
    const { status, notes } = req.body;
    
    try {
        const conversion = await pool.query(`
            SELECT ac.*, al.business_id
            FROM affiliate_conversions ac
            JOIN affiliate_links al ON ac.affiliate_link_id = al.id
            JOIN businesses b ON al.business_id = b.id
            WHERE ac.id = $1 AND b.user_id = $2
        `, [conversionId, req.session.userId]);
        
        if (conversion.rows.length === 0) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        
        await pool.query(
            `UPDATE affiliate_conversions 
             SET status = $1, business_notes = $2, approved_at = $3
             WHERE id = $4`,
            [status, notes || null, status === 'approved' ? new Date() : null, conversionId]
        );
        
        res.json({ success: true, status: status });
        
    } catch (err) {
        console.error('Conversion approval error:', err);
        res.status(500).json({ error: 'Failed to update conversion' });
    }
});

app.get('/api/affiliate/earnings', isAuthenticated, async (req, res) => {
    try {
        const earnings = await pool.query(`
            SELECT 
                al.id as link_id,
                al.product_name,
                al.click_count,
                al.sale_count,
                al.total_revenue,
                al.total_commission,
                COALESCE(SUM(CASE WHEN ac.status = 'approved' THEN ac.commission_earned ELSE 0 END), 0) as approved_commission,
                COALESCE(SUM(CASE WHEN ac.status = 'pending' THEN ac.commission_earned ELSE 0 END), 0) as pending_commission
            FROM affiliate_links al
            JOIN businesses b ON al.business_id = b.id
            LEFT JOIN affiliate_conversions ac ON al.id = ac.affiliate_link_id
            WHERE b.user_id = $1
            GROUP BY al.id
            ORDER BY al.created_at DESC
        `, [req.session.userId]);
        
        const recentConversions = await pool.query(`
            SELECT ac.*, al.product_name
            FROM affiliate_conversions ac
            JOIN affiliate_links al ON ac.affiliate_link_id = al.id
            JOIN businesses b ON al.business_id = b.id
            WHERE b.user_id = $1
            ORDER BY ac.conversion_date DESC
            LIMIT 20
        `, [req.session.userId]);
        
        res.json({
            earnings: earnings.rows,
            recentConversions: recentConversions.rows
        });
        
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/user/affiliate-earnings', isAuthenticated, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(DISTINCT ac.id) as total_sales,
                COALESCE(SUM(ac.commission_earned), 0) as total_commission,
                COUNT(DISTINCT ac.affiliate_link_id) as unique_businesses
            FROM affiliate_conversions ac
            LEFT JOIN affiliate_clicks ac2 ON ac.click_id = ac2.id
            WHERE ac2.user_id = $1 AND ac.status = 'approved'
        `, [req.session.userId]);
        
        res.json(stats.rows[0] || { total_sales: 0, total_commission: 0, unique_businesses: 0 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/affiliate/links', isAuthenticated, async (req, res) => {
    try {
        const links = await pool.query(`
            SELECT al.*, b.name as business_name
            FROM affiliate_links al
            JOIN businesses b ON al.business_id = b.id
            WHERE b.user_id = $1 AND al.is_active = true
            ORDER BY al.created_at DESC
        `, [req.session.userId]);
        
        res.json(links.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== CARDS MANAGEMENT ====================
app.get('/api/cards', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM cards ORDER BY display_order ASC, id ASC`);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch cards' });
    }
});

app.get('/api/cards/:id', isAdmin, async (req, res) => {
    const cardId = parseInt(req.params.id);
    try {
        const result = await pool.query('SELECT * FROM cards WHERE id = $1', [cardId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Card not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch card' });
    }
});

app.post('/api/cards', isAdmin, async (req, res) => {
    const { title, description, icon, link, category, order } = req.body;
    if (!title || !icon || !link || !category) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO cards (title, description, icon, link, category, display_order, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
            [title, description || '', icon, link, category, order || 0]
        );
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create card' });
    }
});

app.put('/api/cards/:id', isAdmin, async (req, res) => {
    const cardId = parseInt(req.params.id);
    const { title, description, icon, link, category, order } = req.body;
    try {
        await pool.query(
            `UPDATE cards SET
                title = $1, description = $2, icon = $3, link = $4,
                category = $5, display_order = $6, updated_at = NOW()
             WHERE id = $7`,
            [title, description || '', icon, link, category, order || 0, cardId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update card' });
    }
});

app.delete('/api/cards/:id', isAdmin, async (req, res) => {
    const cardId = parseInt(req.params.id);
    try {
        const result = await pool.query('DELETE FROM cards WHERE id = $1', [cardId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Card not found' });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete card' });
    }
});

// ==================== CREDITS SYSTEM ====================
app.get('/api/credits/balance', isAuthenticated, async (req, res) => {
    try {
        await ensureUserCredits(req.session.userId);
        const result = await pool.query(
            `SELECT COALESCE(balance, 0) as balance,
                    COALESCE(lifetime_earned, 0) as lifetime_earned,
                    COALESCE(lifetime_spent, 0) as lifetime_spent
             FROM user_credits WHERE user_id = $1`,
            [req.session.userId]
        );
        if (result.rows.length === 0) {
            await initializeUserCredits(req.session.userId);
            return res.json({ balance: 600, lifetime_earned: 600, lifetime_spent: 0 });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/credits/transactions', isAuthenticated, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    try {
        const result = await pool.query(
            `SELECT id, amount, type, description, created_at,
                    CASE WHEN type IN ('earn','bonus','refund') THEN '+' ELSE '-' END as sign
             FROM credit_transactions
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.session.userId, limit, offset]
        );
        const countResult = await pool.query(
            'SELECT COUNT(*) as total FROM credit_transactions WHERE user_id = $1',
            [req.session.userId]
        );
        res.json({ transactions: result.rows, total: parseInt(countResult.rows[0].total) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/credits/opportunities', isAuthenticated, async (req, res) => {
    const opportunities = [
        { id: 1, title: "Daily Login Bonus", description: "Log in daily to earn credits", amount: 5, icon: "fa-calendar-day", action: "daily_login", frequency: "daily" },
        { id: 2, title: "Use a Tool", description: "Earn credits for each tool you use", amount: 2, icon: "fa-tools", action: "use_tool", frequency: "per_use" },
        { id: 3, title: "Invite a Friend", description: "Get credits when your friends join", amount: 50, icon: "fa-user-plus", action: "invite_friend", frequency: "one_time" },
        { id: 4, title: "Submit a Tool", description: "Earn credits for submitting new tools", amount: 25, icon: "fa-upload", action: "submit_tool", frequency: "per_submission" },
        { id: 5, title: "Complete Profile", description: "Fill out your profile completely", amount: 30, icon: "fa-user-check", action: "complete_profile", frequency: "one_time" },
        { id: 6, title: "Write a Review", description: "Review tools and earn credits", amount: 10, icon: "fa-star", action: "write_review", frequency: "per_review" },
        { id: 7, title: "Submit a Business", description: "Submit a business to the directory", amount: 15, icon: "fa-building", action: "submit_business", frequency: "per_submission" }
    ];
    res.json(opportunities);
});

app.post('/api/credits/claim-daily', isAuthenticated, async (req, res) => {
    try {
        await ensureUserCredits(req.session.userId);
        const lastClaim = await pool.query(
            `SELECT created_at FROM credit_transactions
             WHERE user_id = $1 AND type = 'bonus' AND description LIKE '%Daily login%'
               AND created_at::date = CURRENT_DATE
             ORDER BY created_at DESC LIMIT 1`,
            [req.session.userId]
        );
        if (lastClaim.rows.length > 0) {
            return res.status(400).json({ error: 'Daily bonus already claimed today' });
        }
        const dailyBonus = 5;
        await pool.query(
            `UPDATE user_credits SET balance = balance + $1, lifetime_earned = lifetime_earned + $1
             WHERE user_id = $2`,
            [dailyBonus, req.session.userId]
        );
        await pool.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'bonus', 'Daily login bonus')`,
            [req.session.userId, dailyBonus]
        );
        res.json({ success: true, message: `Claimed ${dailyBonus} credits!` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/credits/spend-options', isAuthenticated, async (req, res) => {
    const options = [
        { id: 1, title: "Premium Tools Access", description: "Unlock all premium AI tools for 30 days", cost: 500, icon: "fa-crown", duration: "30 days", popular: true, feature: "premium" },
        { id: 2, title: "Advanced Analytics", description: "Get detailed insights and analytics", cost: 200, icon: "fa-chart-line", duration: "7 days", popular: false, feature: "analytics" },
        { id: 3, title: "Priority Support", description: "24/7 priority customer support", cost: 100, icon: "fa-headset", duration: "30 days", popular: false, feature: "support" },
        { id: 4, title: "Featured Profile", description: "Your profile appears in featured section", cost: 300, icon: "fa-star", duration: "7 days", popular: false, feature: "featured" },
        { id: 5, title: "Message Boosts", description: "Highlight your messages in chats (10 uses)", cost: 50, icon: "fa-bolt", duration: "10 uses", popular: false, feature: "boost" },
        { id: 6, title: "Featured Business", description: "Feature your business in directory", cost: 200, icon: "fa-store", duration: "30 days", popular: false, feature: "business_featured" }
    ];
    res.json(options);
});

// ==================== REFERRAL SYSTEM ====================
app.get('/api/referrals/stats', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const earningsResult = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as total
             FROM credit_transactions
             WHERE user_id = $1 AND type = 'earn' AND description ILIKE '%Referral%'`,
            [userId]
        );
        const referralsResult = await pool.query(
            `SELECT id, username, email, created_at
             FROM users WHERE referrer_id = $1 ORDER BY created_at DESC`,
            [userId]
        );
        res.json({
            totalEarned: earningsResult.rows[0]?.total || 0,
            referrals: referralsResult.rows
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

app.post('/api/user/use-boost', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query('SELECT message_boosts_remaining FROM users WHERE id = $1', [req.session.userId]);
        const remaining = result.rows[0]?.message_boosts_remaining || 0;
        if (remaining <= 0) {
            return res.status(400).json({ error: 'No boosts remaining' });
        }
        await pool.query('UPDATE users SET message_boosts_remaining = message_boosts_remaining - 1 WHERE id = $1', [req.session.userId]);
        res.json({ success: true, remaining: remaining - 1 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/user/avatar-style', isAuthenticated, async (req, res) => {
    const { style } = req.body;
    if (!style || typeof style !== 'string') {
        return res.status(400).json({ error: 'Avatar style is required' });
    }
    try {
        await pool.query('UPDATE users SET avatar_style = $1 WHERE id = $2', [style, req.session.userId]);
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
        const msg = await pool.query('SELECT sender_id FROM messages WHERE id = $1 AND sender_id = $2', [messageId, userId]);
        if (msg.rows.length === 0) {
            return res.status(404).json({ error: 'Message not found or not yours' });
        }
        
        const boostsResult = await pool.query('SELECT message_boosts_remaining FROM users WHERE id = $1', [userId]);
        let boostsRemaining = boostsResult.rows[0]?.message_boosts_remaining || 0;
        
        if (boostsRemaining > 0) {
            await pool.query('UPDATE users SET message_boosts_remaining = message_boosts_remaining - 1 WHERE id = $1', [userId]);
        } else {
            const balanceCheck = await pool.query('SELECT balance FROM user_credits WHERE user_id = $1', [userId]);
            const balance = balanceCheck.rows[0]?.balance || 0;
            if (balance < 10) {
                return res.status(400).json({ error: 'Insufficient credits (need 10) and no boosts left' });
            }
            await pool.query('UPDATE user_credits SET balance = balance - $1 WHERE user_id = $2', [10, userId]);
            await pool.query(
                `INSERT INTO credit_transactions (user_id, amount, type, description)
                 VALUES ($1, $2, 'spend', 'Message boost')`,
                [userId, 10]
            );
        }
        
        await pool.query('UPDATE messages SET is_boosted = true WHERE id = $1', [messageId]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/referrals/list', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, email, created_at FROM users WHERE referrer_id = $1 ORDER BY created_at DESC', [req.session.userId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/messages/send', isAuthenticated, async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Missing fields' });
    try {
        await pool.query(
            'INSERT INTO messages (sender_id, receiver_id, content) VALUES ($1, $2, $3)',
            [req.session.userId, to, message]
        );
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

// ==================== SUPPORT TICKETS SYSTEM ====================
async function sendTicketNotification(email, subject, html) {
    try {
        await sendEmail(email, subject, html);
    } catch (err) {
        console.error('Ticket notification email failed:', err.message);
    }
}

async function getAvailableModerator() {
    const result = await pool.query(`
        SELECT u.id, u.username, u.email, COALESCE(ms.current_tickets, 0) as current_tickets
        FROM users u
        LEFT JOIN moderator_status ms ON u.id = ms.user_id
        WHERE u.role = 'moderator'
          AND (u.is_banned = false OR u.is_banned IS NULL)
          AND (ms.is_online = true OR ms.is_online IS NULL)
        ORDER BY COALESCE(ms.current_tickets, 0) ASC, ms.last_active DESC NULLS LAST
        LIMIT 1
    `);
    return result.rows[0] || null;
}

async function updateModeratorTicketCount(moderatorId, increment = true) {
    const delta = increment ? 1 : -1;
    await pool.query(`
        INSERT INTO moderator_status (user_id, current_tickets, is_online, last_active)
        VALUES ($1, 1, true, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET current_tickets = GREATEST(0, moderator_status.current_tickets + $2),
            last_active = NOW()
    `, [moderatorId, delta]);
}

app.post('/api/support/tickets', isAuthenticated, async (req, res) => {
    const { subject, message } = req.body;
    if (!subject || !message) {
        return res.status(400).json({ error: 'Subject and message are required' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO support_tickets (user_id, subject, message, replies, status, created_at)
             VALUES ($1, $2, $3, '[]', 'open', NOW())
             RETURNING id`,
            [req.session.userId, subject, message]
        );
        const ticketId = result.rows[0].id;

        const systemReply = {
            id: Date.now(),
            message: 'Your ticket has been submitted. A moderator will respond soon.',
            sender_id: null,
            sender_name: 'System',
            sender_role: 'system',
            created_at: new Date().toISOString()
        };
        await pool.query(
            `UPDATE support_tickets SET replies = $1 WHERE id = $2`,
            [JSON.stringify([systemReply]), ticketId]
        );

        res.status(201).json({ success: true, ticketId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/support/tickets/:id/escalate', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        const ticket = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [ticketId]);
        if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const ticketData = ticket.rows[0];

        if (ticketData.user_id !== req.session.userId && !['admin', 'moderator'].includes(req.session.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (ticketData.assigned_to) {
            return res.json({ success: true, message: 'Ticket already assigned', moderatorName: ticketData.assigned_to });
        }

        const moderator = await getAvailableModerator();
        if (!moderator) {
            return res.status(503).json({ error: 'No moderator available. Please try again later.' });
        }

        await pool.query(
            `UPDATE support_tickets SET assigned_to = $1, escalated_at = NOW(), status = 'in_progress' WHERE id = $2`,
            [moderator.id, ticketId]
        );
        await updateModeratorTicketCount(moderator.id, true);

        const modSocket = onlineUsers.get(moderator.id);
        if (modSocket?.socketId) {
            io.to(modSocket.socketId).emit('new_support_ticket', {
                ticketId,
                fromUser: req.session.username,
                subject: ticketData.subject,
                priority: ticketData.priority
            });
        }

        const user = await pool.query('SELECT email, username FROM users WHERE id = $1', [ticketData.user_id]);
        if (user.rows[0]) {
            await sendTicketNotification(
                user.rows[0].email,
                `[Sarveik] Ticket #${ticketId} is now being handled`,
                `<p>Hello ${user.rows[0].username},</p>
                 <p>Your ticket <strong>#${ticketId}</strong> has been assigned to a moderator. You will receive a reply soon.</p>`
            );
        }

        res.json({ success: true, moderatorName: moderator.username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/support/tickets', isAuthenticated, async (req, res) => {
    try {
        const { status, priority, category, search, limit = 50, offset = 0 } = req.query;
        const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.rows[0]?.role);

        let baseQuery = `
            SELECT t.*, u.username as user_name, u.email as user_email
            FROM support_tickets t
            LEFT JOIN users u ON t.user_id = u.id
        `;
        const conditions = [];
        const params = [];
        let paramIndex = 1;

        if (!isModOrAdmin) {
            conditions.push(`t.user_id = $${paramIndex++}`);
            params.push(req.session.userId);
        }
        if (status && ['new', 'in_progress', 'resolved', 'closed'].includes(status)) {
            conditions.push(`t.status = $${paramIndex++}`);
            params.push(status);
        }
        if (priority && ['low', 'medium', 'high', 'urgent'].includes(priority)) {
            conditions.push(`t.priority = $${paramIndex++}`);
            params.push(priority);
        }
        if (category && ['general', 'bug', 'feature', 'account', 'payment', 'other'].includes(category)) {
            conditions.push(`t.category = $${paramIndex++}`);
            params.push(category);
        }
        if (search) {
            conditions.push(`(t.subject ILIKE $${paramIndex} OR t.message ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (conditions.length) {
            baseQuery += ' WHERE ' + conditions.join(' AND ');
        }

        baseQuery += ` ORDER BY 
            CASE t.priority 
                WHEN 'urgent' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
            END,
            t.created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(baseQuery, params);
        const tickets = result.rows.map(t => {
            let replies = [];
            if (t.replies) {
                try { replies = JSON.parse(t.replies); } catch(e) { replies = []; }
            }
            return { ...t, replies };
        });

        let countQuery = `SELECT COUNT(*) FROM support_tickets t`;
        if (!isModOrAdmin) countQuery += ` WHERE t.user_id = $1`;
        const countRes = await pool.query(countQuery, !isModOrAdmin ? [req.session.userId] : []);
        const total = parseInt(countRes.rows[0].count);

        res.json({ tickets, total, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/support/tickets/:id', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.rows[0]?.role);

        const query = `
            SELECT t.*, u.username as user_name, u.email as user_email
            FROM support_tickets t
            JOIN users u ON t.user_id = u.id
            WHERE t.id = $1
        `;
        const result = await pool.query(query, [ticketId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const ticketData = result.rows[0];

        if (!isModOrAdmin && ticketData.user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        let replies = [];
        if (ticketData.replies) {
            try { replies = JSON.parse(ticketData.replies); } catch(e) { replies = []; }
        }
        ticketData.replies = replies;

        let internalNotes = [];
        if (isModOrAdmin && ticketData.internal_notes) {
            try { internalNotes = JSON.parse(ticketData.internal_notes); } catch(e) { internalNotes = []; }
            ticketData.internal_notes = internalNotes;
        } else {
            delete ticketData.internal_notes;
        }

        res.json(ticketData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/support/tickets/:id/reply', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    const { message, changeStatusTo } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    try {
        const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.rows[0]?.role);

        const ticket = await pool.query(
            'SELECT user_id, status, replies, assigned_to, priority FROM support_tickets WHERE id = $1',
            [ticketId]
        );
        if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const ticketData = ticket.rows[0];

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
            sender_role: isModOrAdmin ? (userRole.rows[0]?.role || 'moderator') : 'user',
            created_at: new Date().toISOString()
        };
        replies.push(newReply);

        let newStatus = ticketData.status;
        if (isModOrAdmin && changeStatusTo && ['new', 'in_progress', 'resolved', 'closed'].includes(changeStatusTo)) {
            newStatus = changeStatusTo;
        } else if (!isModOrAdmin && ticketData.status === 'new') {
            newStatus = 'in_progress';
        }

        let assignMod = null;
        if (isModOrAdmin && !ticketData.assigned_to) {
            assignMod = req.session.userId;
            await updateModeratorTicketCount(assignMod, true);
        }

        await pool.query(
            `UPDATE support_tickets 
             SET replies = $1, 
                 status = $2,
                 assigned_to = COALESCE(assigned_to, $3),
                 last_reminder_sent = NULL,
                 updated_at = NOW()
             WHERE id = $4`,
            [JSON.stringify(replies), newStatus, assignMod, ticketId]
        );

        if (isModOrAdmin) {
            const userSocket = onlineUsers.get(ticketData.user_id);
            if (userSocket?.socketId) {
                io.to(userSocket.socketId).emit('ticket_reply', { ticketId, message });
            }
            const user = await pool.query('SELECT email, username FROM users WHERE id = $1', [ticketData.user_id]);
            if (user.rows[0]) {
                await sendTicketNotification(
                    user.rows[0].email,
                    `[Sarveik] New reply on ticket #${ticketId}`,
                    `<p>Hello ${user.rows[0].username},</p>
                     <p>A moderator has replied to your ticket <strong>#${ticketId}</strong>.</p>
                     <a href="${process.env.FRONTEND_URL}/profile.html?tab=support">View reply</a>`
                );
            }
        } else {
            const modId = ticketData.assigned_to || assignMod;
            if (modId) {
                const modSocket = onlineUsers.get(modId);
                if (modSocket?.socketId) {
                    io.to(modSocket.socketId).emit('ticket_reply', { ticketId, message });
                }
            }
        }

        res.json({ success: true, reply: newReply });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/support/tickets/:id/note', isAdminOrModerator, async (req, res) => {
    const ticketId = req.params.id;
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: 'Note is required' });

    try {
        const ticket = await pool.query('SELECT internal_notes FROM support_tickets WHERE id = $1', [ticketId]);
        if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });

        let notes = [];
        if (ticket.rows[0].internal_notes) {
            try { notes = JSON.parse(ticket.rows[0].internal_notes); } catch(e) { notes = []; }
        }
        notes.push({
            id: notes.length + 1,
            note: note,
            created_by: req.session.userId,
            created_by_name: req.session.username,
            created_at: new Date().toISOString()
        });

        await pool.query(
            'UPDATE support_tickets SET internal_notes = $1, updated_at = NOW() WHERE id = $2',
            [JSON.stringify(notes), ticketId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.patch('/api/support/tickets/:id/status', isAdminOrModerator, async (req, res) => {
    const ticketId = req.params.id;
    const { status } = req.body;
    const validStatuses = ['new', 'in_progress', 'resolved', 'closed'];
    if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        const result = await pool.query(
            'UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
            [status, ticketId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
        res.json({ success: true, status });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/support/tickets/:id', isAdminOrModerator, async (req, res) => {
    const ticketId = req.params.id;
    try {
        const result = await pool.query('DELETE FROM support_tickets WHERE id = $1', [ticketId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/support/stats', isAdminOrModerator, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'new') AS new,
                COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
                COUNT(*) FILTER (WHERE status = 'resolved') AS resolved,
                COUNT(*) FILTER (WHERE status = 'closed') AS closed,
                AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE status IN ('resolved','closed')) AS avg_response_hours
            FROM support_tickets
        `);
        const priorityStats = await pool.query(`
            SELECT priority, COUNT(*) FROM support_tickets WHERE status NOT IN ('resolved','closed') GROUP BY priority
        `);
        const categoryStats = await pool.query(`
            SELECT category, COUNT(*) FROM support_tickets WHERE status NOT IN ('resolved','closed') GROUP BY category
        `);
        res.json({
            overview: stats.rows[0],
            by_priority: priorityStats.rows,
            by_category: categoryStats.rows
        });
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
                const moderatorEntry = onlineUsers.get(ticket.assigned_to);
                if (moderatorEntry && moderatorEntry.socketId) {
                    io.to(moderatorEntry.socketId).emit('support_reminder', {
                        ticketId: ticket.id,
                        subject: ticket.subject,
                        minutesSince: Math.floor((Date.now() - new Date(ticket.escalated_at).getTime()) / 60000)
                    });
                }

                await sendEmail(
                    ticket.moderator_email,
                    `Support Ticket Reminder #${ticket.id}`,
                    `<p>You have a pending support ticket <strong>#${ticket.id}: "${escapeHtml(ticket.subject)}"</strong> that was escalated ${Math.floor((Date.now() - new Date(ticket.escalated_at).getTime()) / 60000)} minutes ago.</p><p>Please respond soon.</p>`
                );

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
        const userId = req.session.userId;
        const toolsResult = await pool.query(
            'SELECT COUNT(*) as count FROM tool_usage WHERE user_id = $1',
            [userId]
        );
        const friendsResult = await pool.query(
            `SELECT COUNT(*) as count FROM friendships
             WHERE (user_id = $1 OR friend_id = $1) AND status = 'accepted'`,
            [userId]
        );
        const creditsResult = await pool.query(
            'SELECT balance FROM user_credits WHERE user_id = $1',
            [userId]
        );
        const streakResult = await pool.query(
            'SELECT current_streak FROM user_streak WHERE user_id = $1',
            [userId]
        );
        res.json({
            toolsUsed: parseInt(toolsResult.rows[0].count),
            friendsCount: parseInt(friendsResult.rows[0].count),
            streak: streakResult.rows[0]?.current_streak || 0,
            aiCredits: creditsResult.rows[0]?.balance || 0
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/user-status', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT status FROM users WHERE id = $1',
            [req.session.userId]
        );
        res.json({ status: result.rows[0]?.status || 'online' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/usage/analytics', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const result = await pool.query(
            `SELECT 
                tool_name as name,
                COUNT(*) as count
             FROM tool_usage
             WHERE user_id = $1
             GROUP BY tool_name
             ORDER BY count DESC`,
            [userId]
        );
        const tools = result.rows.map(t => ({
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
        const friendResult = await pool.query(
            'SELECT id, email FROM users WHERE username = $1',
            [friendUsername]
        );
        if (friendResult.rows.length === 0) return res.status(404).send('User not found');
        const friendId = friendResult.rows[0].id;
        const friendEmail = friendResult.rows[0].email;
        if (friendId === req.session.userId) return res.status(400).send('Cannot add yourself');
 
        const existing = await pool.query(
            `SELECT * FROM friendships
             WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
            [req.session.userId, friendId]
        );
        if (existing.rows.length > 0) {
            const row = existing.rows[0];
            if (row.status === 'accepted') return res.status(409).send('Already friends');
            if (row.status === 'pending') return res.status(409).send('Friend request already pending');
        }
 
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await pool.query(
            `INSERT INTO friendships (user_id, friend_id, status, expires_at)
             VALUES ($1, $2, 'pending', $3)`,
            [req.session.userId, friendId, expiresAt]
        );
 
        sendFriendRequestEmail(friendEmail, req.session.username)
            .catch(err => console.error('Friend request email failed:', err));
 
        const friendEntry = onlineUsers.get(friendId);
        if (friendEntry?.socketId) {
            io.to(friendEntry.socketId).emit('friend_request_notification', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }
 
        await updateQuestProgress(req.session.userId, 'friend_request');
        await checkAchievements(req.session.userId);
        res.send('Friend request sent');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.put('/api/friends/accept/:requestId', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE friendships SET status = 'accepted'
             WHERE id = $1 AND friend_id = $2 AND status = 'pending'`,
            [req.params.requestId, req.session.userId]
        );
        if (result.rowCount === 0) return res.status(404).send('Request not found');
        res.send('Friend request accepted');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.put('/api/friends/decline/:requestId', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE friendships SET status = 'declined'
             WHERE id = $1 AND friend_id = $2 AND status = 'pending'`,
            [req.params.requestId, req.session.userId]
        );
        if (result.rowCount === 0) return res.status(404).send('Request not found');
        res.send('Friend request declined');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/api/friends', isAuthenticated, async (req, res) => {
    try {
        const { search } = req.query;
        let query = `
            SELECT u.id, u.username, u.display_name, u.avatar_url, u.status
            FROM friendships f
            JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
            WHERE (f.user_id = $1 OR f.friend_id = $1)
              AND f.status = 'accepted' AND u.id != $1
        `;
        const params = [req.session.userId];
        if (search) {
            query += ` AND (u.username ILIKE $2 OR u.display_name ILIKE $2)`;
            params.push(`%${search}%`);
        }
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends/requests', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT f.id, u.id as sender_id, u.username, u.display_name, u.avatar_url
             FROM friendships f JOIN users u ON f.user_id = u.id
             WHERE f.friend_id = $1 AND f.status = 'pending'`,
            [req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends/outgoing-requests', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const result = await pool.query(
            `SELECT f.id, u.id as friend_id, u.username, u.display_name, u.avatar_url
             FROM friendships f
             JOIN users u ON f.friend_id = u.id
             WHERE f.user_id = $1 AND f.status = 'pending'`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/messages/:friendId', isAuthenticated, async (req, res) => {
    const friendId = req.params.friendId;
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 30;
    try {
        const result = await pool.query(
            `SELECT * FROM messages
             WHERE (sender_id = $1 AND receiver_id = $2)
                OR (sender_id = $2 AND receiver_id = $1)
             ORDER BY created_at DESC
             LIMIT $3 OFFSET $4`,
            [req.session.userId, friendId, limit, offset]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/friends/:friendId', isAuthenticated, async (req, res) => {
    const friendId = parseInt(req.params.friendId);
    if (isNaN(friendId)) return res.status(400).send('Invalid friend ID');
    try {
        await pool.query(
            `DELETE FROM friendships
             WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
            [req.session.userId, friendId]
        );
        res.send('Friend removed');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/messages/read/:friendId', isAuthenticated, async (req, res) => {
    const friendId = req.params.friendId;
    try {
        await pool.query(
            `UPDATE messages SET is_read = true
             WHERE receiver_id = $1 AND sender_id = $2 AND is_read = false`,
            [req.session.userId, friendId]
        );
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/api/network/stats', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const total = await pool.query(
            `SELECT COUNT(*) as count FROM friendships
             WHERE (user_id = $1 OR friend_id = $1) AND status = 'accepted'`,
            [userId]
        );
        const pending = await pool.query(
            `SELECT COUNT(*) as count FROM friendships
             WHERE friend_id = $1 AND status = 'pending'`,
            [userId]
        );
        res.json({
            total: parseInt(total.rows[0].count),
            online: 0,
            requests: parseInt(pending.rows[0].count)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/network/requests', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const result = await pool.query(
            `SELECT f.id, u.id as user_id, u.username, u.display_name, u.avatar_url, f.created_at
             FROM friendships f
             JOIN users u ON f.user_id = u.id
             WHERE f.friend_id = $1 AND f.status = 'pending'
             ORDER BY f.created_at DESC`,
            [userId]
        );
        res.json(result.rows);
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
        const unread = await pool.query('SELECT COUNT(*) as count FROM messages WHERE receiver_id = $1 AND is_read = false', [userId]);
        const pending = await pool.query('SELECT COUNT(*) as count FROM friendships WHERE friend_id = $1 AND status = $2', [userId, 'pending']);
        const total = (unread.rows[0]?.count || 0) + (pending.rows[0]?.count || 0);
        res.json({ total });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/network/export', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const result = await pool.query(
            `SELECT u.username, u.display_name, u.email, u.status
             FROM friendships f
             JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id)
             WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = 'accepted' AND u.id != $1`,
            [userId]
        );
        const csvRows = [['Username', 'Display Name', 'Email', 'Status']];
        result.rows.forEach(row => {
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
        const result = await pool.query(
            `DELETE FROM friendships
             WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
            [req.session.userId, friendId]
        );
        if (result.rowCount === 0) return res.status(404).send('Connection not found');
        res.send('Connection removed');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/network/accept/:requestId', isAuthenticated, async (req, res) => {
    const requestId = req.params.requestId;
    try {
        const result = await pool.query(
            `UPDATE friendships SET status = 'accepted' WHERE id = $1 AND friend_id = $2 AND status = 'pending'`,
            [requestId, req.session.userId]
        );
        if (result.rowCount === 0) return res.status(404).send('Request not found');
        const request = await pool.query('SELECT user_id FROM friendships WHERE id = $1', [requestId]);
        const otherUserId = request.rows[0]?.user_id;
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
        const result = await pool.query(
            `UPDATE friendships SET status = 'declined' WHERE id = $1 AND friend_id = $2 AND status = 'pending'`,
            [requestId, req.session.userId]
        );
        if (result.rowCount === 0) return res.status(404).send('Request not found');
        res.send('Request declined');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/update-status', isAuthenticated, async (req, res) => {
    const { status } = req.body;
    if (!['online', 'away', 'busy', 'offline'].includes(status)) {
        return res.status(400).send('Invalid status');
    }
    try {
        await pool.query(
            'UPDATE users SET status = $1 WHERE id = $2',
            [status, req.session.userId]
        );
        res.send('Status updated');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// ==================== ADMIN ROUTES ====================
app.get('/admin/users', isAdminOrModerator, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, username, email, role, created_at, is_banned, display_name, avatar_url
             FROM users ORDER BY id`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/admin/users/:id', isAdmin, async (req, res) => {
    const userId = req.params.id;
    if (userId == req.session.userId) return res.status(400).send('Cannot delete yourself');
    try {
        await pool.query('DELETE FROM user_streak WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM user_daily_quests WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM user_achievements WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM credit_transactions WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM user_credits WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM tool_usage WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1', [userId]);
        await pool.query('DELETE FROM friendships WHERE user_id = $1 OR friend_id = $1', [userId]);
        await pool.query('DELETE FROM group_members WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM group_messages WHERE sender_id = $1', [userId]);
        await pool.query('DELETE FROM support_tickets WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM user_feedback WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM moderator_activity WHERE moderator_id = $1', [userId]);
        await pool.query('DELETE FROM tools WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM password_resets WHERE email IN (SELECT email FROM users WHERE id = $1)', [userId]);
        await pool.query('DELETE FROM otp_store WHERE email IN (SELECT email FROM users WHERE id = $1)', [userId]);
        await pool.query('DELETE FROM category_reviews WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM tool_reviews WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM user_events WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM credit_purchases WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM announcements WHERE created_by = $1', [userId]);
        await pool.query('DELETE FROM user_notes WHERE user_id = $1 OR updated_by = $1', [userId]);
        await pool.query('DELETE FROM business_favorites WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM business_reviews WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM businesses WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM user_avatars WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM avatar_uploads WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);

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
            values.push(is_banned === true || is_banned === 1 ? true : false);
            paramIndex++;
        }
        if (updateFields.length === 0) {
            return res.status(400).send('No fields to update');
        }
        values.push(userId);
        const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
        await pool.query(query, values);

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
        const newBanned = !currentBanned;
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
 
        await pool.query('DELETE FROM password_resets WHERE email = $1', [email]);
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
        console.error('Forgot password error:', err);
        res.status(500).send('Server error');
    }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).send('All fields are required');
    try {
        const result = await pool.query(
            `SELECT * FROM password_resets
             WHERE LOWER(email) = LOWER($1) AND otp = $2 AND expires_at > NOW()`,
            [email, otp]
        );
        if (result.rows.length === 0) return res.status(400).send('Invalid or expired OTP');
 
        const strength = validatePasswordStrength(newPassword);
        if (!strength.valid) return res.status(400).send(strength.message);
 
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password = $1 WHERE LOWER(email) = LOWER($2)',
            [hashedPassword, email]
        );
        await pool.query('DELETE FROM password_resets WHERE LOWER(email) = LOWER($1)', [email]);
        res.send('Password reset successfully');
    } catch (err) {
        console.error('Reset error:', err);
        res.status(500).send('Server error');
    }
});

// ==================== USER SEARCH, PROFILE ====================
app.get('/api/users/search', isAuthenticated, async (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 2) return res.json([]);
    try {
        const result = await pool.query(
            `SELECT id, username, display_name, avatar_url
             FROM users
             WHERE (username ILIKE $1 OR display_name ILIKE $1) AND id != $2
             ORDER BY username LIMIT 10`,
            [`%${query}%`, req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/profile', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, username, email, role, display_name, 
                    bio, phone, github, twitter, linkedin,
                    avatar_url, created_at, updated_at,
                    email_verified, avatar_style
             FROM users WHERE id = $1`,
            [req.session.userId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/profile/update', isAuthenticated, async (req, res) => {
    const { display_name, bio, phone, github, twitter, linkedin } = req.body;
    try {
        await pool.query(
            `UPDATE users SET
                display_name = $1, bio = $2, phone = $3,
                github = $4, twitter = $5, linkedin = $6,
                updated_at = NOW()
             WHERE id = $7`,
            [
                display_name ? escapeHtml(display_name) : null,
                bio ? escapeHtml(bio) : null,
                phone ? escapeHtml(phone) : null,
                github ? escapeHtml(github) : null,
                twitter ? escapeHtml(twitter) : null,
                linkedin ? escapeHtml(linkedin) : null,
                req.session.userId
            ]
        );
        const updated = await pool.query(
            `SELECT id, username, display_name, email, bio, phone,
                    github, twitter, linkedin, email_verified,
                    two_factor_enabled, created_at, updated_at, avatar_url, avatar_style
             FROM users WHERE id = $1`,
            [req.session.userId]
        );
        res.json(updated.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

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
        await pool.query(
            'UPDATE users SET avatar_url = $1 WHERE id = $2',
            [avatarUrl, req.session.userId]
        );
        
        // Also update avatar_style to 'uploaded' when user uploads
        await pool.query(
            'UPDATE users SET avatar_style = $1 WHERE id = $2',
            ['uploaded', req.session.userId]
        );
        
        res.send('Avatar uploaded successfully');
    } catch (err) {
        console.error(err);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).send('Server error');
    }
});

app.put('/profile/password', isAuthenticated, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).send('All fields required');
    try {
        const result = await pool.query(
            'SELECT password FROM users WHERE id = $1',
            [req.session.userId]
        );
        if (result.rows.length === 0) return res.status(404).send('User not found');
        const match = await bcrypt.compare(currentPassword, result.rows[0].password);
        if (!match) return res.status(401).send('Current password incorrect');
        const hashedNew = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password = $1 WHERE id = $2',
            [hashedNew, req.session.userId]
        );
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
        await pool.query(
            'UPDATE users SET two_factor_enabled = NOT two_factor_enabled WHERE id = $1',
            [req.session.userId]
        );
        res.send('2FA setting toggled');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.delete('/profile/delete', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.userId;
        const userEmail = req.session.email;
        const username = req.session.username;

        const tables = [
            'DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1',
            'DELETE FROM friendships WHERE user_id = $1 OR friend_id = $1',
            'DELETE FROM user_credits WHERE user_id = $1',
            'DELETE FROM credit_transactions WHERE user_id = $1',
            'DELETE FROM tool_usage WHERE user_id = $1',
            'DELETE FROM user_achievements WHERE user_id = $1',
            'DELETE FROM user_daily_quests WHERE user_id = $1',
            'DELETE FROM user_streak WHERE user_id = $1',
            'DELETE FROM support_tickets WHERE user_id = $1',
            'DELETE FROM user_feedback WHERE user_id = $1',
            'DELETE FROM group_messages WHERE sender_id = $1',
            'DELETE FROM group_members WHERE user_id = $1',
            'DELETE FROM tool_reviews WHERE user_id = $1',
            'DELETE FROM category_reviews WHERE user_id = $1',
            'DELETE FROM credit_purchases WHERE user_id = $1',
            'DELETE FROM business_favorites WHERE user_id = $1',
            'DELETE FROM business_reviews WHERE user_id = $1',
            'DELETE FROM businesses WHERE user_id = $1',
            'DELETE FROM user_avatars WHERE user_id = $1',
            'DELETE FROM avatar_uploads WHERE user_id = $1',
            'DELETE FROM users WHERE id = $1'
        ];

        for (const query of tables) {
            await pool.query(query, [userId]);
        }

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

app.put('/api/admin/users/:id/ban', isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [userId]);
        res.send('User banned');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.put('/api/admin/users/:id/unban', isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        await pool.query('UPDATE users SET is_banned = false WHERE id = $1', [userId]);
        res.send('User unbanned');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.delete('/api/messages/:messageId', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM messages WHERE id = $1 AND sender_id = $2',
            [req.params.messageId, req.session.userId]
        );
        if (result.rowCount === 0) return res.status(404).send('Message not found or not yours');
        res.send('Message deleted');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.delete('/api/messages/clear/:friendId', isAuthenticated, async (req, res) => {
    try {
        await pool.query(
            `DELETE FROM messages
             WHERE (sender_id = $1 AND receiver_id = $2)
                OR (sender_id = $2 AND receiver_id = $1)`,
            [req.session.userId, req.params.friendId]
        );
        res.send('Conversation cleared');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/api/unread', isAuthenticated, async (req, res) => {
    try {
        const unread = await pool.query(
            `SELECT sender_id as friend_id, COUNT(*) as count
             FROM messages WHERE receiver_id = $1 AND is_read = false
             GROUP BY sender_id`,
            [req.session.userId]
        );
        const requests = await pool.query(
            `SELECT COUNT(*) as count FROM friendships
             WHERE friend_id = $1 AND status = 'pending'`,
            [req.session.userId]
        );
        res.json({
            unread: unread.rows,
            pendingRequests: parseInt(requests.rows[0].count)
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

// ==================== REMAINING ENDPOINTS ====================
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
        const credits = await pool.query(
            `SELECT 
                COALESCE(balance, 0) as current_balance,
                COALESCE(lifetime_earned, 0) as total_earned,
                COALESCE(lifetime_spent, 0) as total_spent
             FROM user_credits WHERE user_id = $1`,
            [userId]
        );
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
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Error fetching top users by level:', err);
        res.status(200).json([]);
    }
});

app.get('/api/recommendations/:toolName', isAuthenticated, async (req, res) => {
    const { toolName } = req.params;
    const limit = parseInt(req.query.limit) || 5;
    try {
        const result = await pool.query(`
            SELECT t2.tool_name, COUNT(*) as affinity
            FROM tool_usage t1
            JOIN tool_usage t2 ON t1.user_id = t2.user_id AND t1.tool_name != t2.tool_name
            WHERE t1.tool_name = $1
            GROUP BY t2.tool_name
            ORDER BY affinity DESC
            LIMIT $2
        `, [toolName, limit]);
        res.json(result.rows);
    } catch (err) {
        console.error('Recommendations error:', err);
        res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
});

// ==================== ACTIVITY LOG ====================
app.post('/api/activity-log', isAuthenticated, async (req, res) => {
    const { action, target, details } = req.body;
    try {
        await pool.query(
            `INSERT INTO moderator_activity (moderator_id, moderator_name, action, target, details, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [req.session.userId, req.session.username, action, target || '', details || '']
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

// ==================== USER NOTES ====================
app.get('/api/user-notes/:userId', isAdminOrModerator, async (req, res) => {
    try {
        const result = await pool.query('SELECT notes FROM user_notes WHERE user_id = $1', [req.params.userId]);
        res.json(result.rows[0]?.notes || '');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user-notes/:userId', isAdminOrModerator, async (req, res) => {
    const { notes } = req.body;
    try {
        await pool.query(
            `INSERT INTO user_notes (user_id, notes, updated_by, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (user_id) DO UPDATE SET notes = $2, updated_by = $3, updated_at = NOW()`,
            [req.params.userId, notes, req.session.userId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
            'INSERT INTO announcements (title, content, created_by, created_at) VALUES ($1, $2, $3, NOW())',
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
        const placeholders = ticketIds.map((_, i) => `$${i+1}`).join(',');
        await pool.query(`UPDATE support_tickets SET status = 'closed' WHERE id IN (${placeholders})`, ticketIds);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/support/tickets/bulk-delete', isAdminOrModerator, async (req, res) => {
    const { ticketIds } = req.body;
    if (!ticketIds || !ticketIds.length) return res.status(400).json({ error: 'No tickets selected' });
    try {
        const placeholders = ticketIds.map((_, i) => `$${i+1}`).join(',');
        await pool.query(`DELETE FROM support_tickets WHERE id IN (${placeholders})`, ticketIds);
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

// ==================== GAMIFICATION API ====================
app.get('/api/gamification/status', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    try {
        const user = await pool.query(
            'SELECT level, xp, total_xp_earned FROM users WHERE id = $1',
            [userId]
        );
        if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
 
        const { level, xp, total_xp_earned } = user.rows[0];
        const nextLevelXP = xpForLevel(level + 1);
        const currentLevelXP = xpForLevel(level);
        const progress = nextLevelXP > currentLevelXP
            ? Math.min(100, Math.max(0, ((xp - currentLevelXP) / (nextLevelXP - currentLevelXP)) * 100))
            : 100;
 
        const streak = await pool.query(
            'SELECT current_streak, longest_streak, multiplier FROM user_streak WHERE user_id = $1',
            [userId]
        );
 
        const achievements = await pool.query(
            `SELECT a.id, a.name, a.description, a.icon, a.xp_reward, ua.earned_at
             FROM achievements a
             LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = $1`,
            [userId]
        );
 
        const today = new Date().toISOString().slice(0, 10);
        const quests = await pool.query(
            `SELECT q.id, q.name, q.description, q.target_count, q.xp_reward, q.credits_reward,
                    COALESCE(uqd.progress, 0) as progress,
                    COALESCE(uqd.completed, false) as completed,
                    COALESCE(uqd.claimed, false) as claimed
             FROM daily_quests q
             LEFT JOIN user_daily_quests uqd ON q.id = uqd.quest_id
               AND uqd.user_id = $1 AND uqd.date = $2`,
            [userId, today]
        );
 
        res.json({
            level,
            xp,
            totalXP: total_xp_earned,
            nextLevelXP,
            progress,
            streak: streak.rows[0] || { current_streak: 0, longest_streak: 0, multiplier: 1 },
            dailyQuests: quests.rows.map(q => ({
                id: q.id,
                name: q.name,
                description: q.description,
                progress: q.progress,
                target: q.target_count,
                completed: q.completed,
                xpReward: q.xp_reward,
                creditsReward: q.credits_reward
            })),
            achievements: achievements.rows.map(a => ({
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

        await addXP(userId, quest.xp_reward, `Daily quest: ${quest.name}`);

        await pool.query(
            'UPDATE user_credits SET balance = balance + $1 WHERE user_id = $2',
            [quest.credits_reward, userId]
        );
        await pool.query(
            `INSERT INTO credit_transactions (user_id, amount, type, description)
             VALUES ($1, $2, 'earn', $3)`,
            [userId, quest.credits_reward, `Claimed quest: ${quest.name}`]
        );

        await pool.query(
            `UPDATE user_daily_quests SET claimed = true 
             WHERE user_id = $1 AND quest_id = $2 AND date = $3`,
            [userId, questId, today]
        );

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

// ==================== USER FEEDBACK ====================
app.post('/api/feedback', isAuthenticated, async (req, res) => {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    try {
        await pool.query(
            'INSERT INTO user_feedback (user_id, rating, comment, created_at) VALUES ($1, $2, $3, NOW())',
            [req.session.userId, rating, comment || null]
        );
        res.json({ success: true, message: 'Thank you for your feedback!' });
    } catch (err) {
        console.error('Feedback error:', err);
        res.status(500).json({ error: 'Failed to save feedback' });
    }
});

app.get('/api/admin/feedback', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT f.id, f.rating, f.comment, f.created_at,
                    u.id as user_id, u.username, u.email
             FROM user_feedback f JOIN users u ON f.user_id = u.id
             ORDER BY f.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching feedback:', err);
        res.status(500).json({ error: 'Failed to fetch feedback' });
    }
});

// ==================== CSRF TOKEN ENDPOINT ====================
app.get('/api/csrf-token', (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    req.session.csrfToken = token;
    res.json({ csrfToken: token });
});

// ==================== DATABASE CONNECTION TEST ====================
(async () => {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ Database connection verified');
        await ensureStaffLoungeGroup();
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        process.exit(1);
    }
})();

// ==================== START SERVER ====================
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
    console.log(`🎫 Support ticket system active`);
    console.log(`📝 Moderator features active`);
    console.log(`🏅 Custom badge system active`);
    console.log(`💳 Real-money credit purchases enabled (PhonePe)`);
    console.log(`🤖 AI tool recommendations active`);
    console.log(`👥 Group chat endpoints active`);
    console.log(`📈 Real-time admin stats via Socket.IO active`);
    console.log(`🎮 Gamification system active (XP, levels, streaks, daily quests, achievements)`);
    console.log(`⭐ Leaderboard endpoint available at /api/gamification/leaderboard`);
    console.log(`✅ Admin can add featured tools (is_featured flag)`);
    console.log(`✅ Username uniqueness check fixed during registration`);
    console.log(`✅ Account deletion fully fixed with cascade deletion of all related data`);
    console.log(`✅ CSRF token endpoint added for state‑changing requests`);
    console.log(`🏢 Business directory management endpoints active`);
    console.log(`💰 Sponsored Ads System active`);
    console.log(`💰 Affiliate Commission System active`);
    console.log(`💰 Users earn 15 CREDITS when their submitted business gets approved`);
    console.log(`👤 Avatar gallery system active with 100+ themed avatars`);
    console.log(`🌍 Business states & districts endpoints added`);
    console.log(`🛵 DELIVERY SYSTEM FULLY INTEGRATED with COD and email confirmation`);
    console.log(`📦 Product image upload active`);
    console.log(`👔 Business Owner Dashboard endpoints active (update, orders, analytics)`);
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
        const users = await pool.query('SELECT id, username, email FROM users');
        for (const user of users.rows) {
            let newToolsCount = 0;
            try {
                const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                const newToolsResult = await pool.query('SELECT COUNT(*) as count FROM tools WHERE created_at >= $1', [weekAgo]);
                newToolsCount = newToolsResult.rows[0].count;
            } catch (err) { }

            const pendingResult = await pool.query('SELECT COUNT(*) as count FROM friendships WHERE friend_id = $1 AND status = $2', [user.id, 'pending']);
            const pendingRequestsCount = pendingResult.rows[0]?.count || 0;

            const unreadResult = await pool.query('SELECT COUNT(*) as count FROM messages WHERE receiver_id = $1 AND is_read = false', [user.id]);
            const unreadMessagesCount = unreadResult.rows[0]?.count || 0;

            await sendWeeklyDigest(user.email, user.username, newToolsCount, pendingRequestsCount, unreadMessagesCount);
        }
        console.log('✅ Weekly digest cron job finished');
    } catch (err) {
        console.error('❌ Error in weekly digest cron job:', err);
    }
});

// ============================================================================
// NEW DELIVERY SYSTEM – PRODUCTS, ORDERS, PARTNERS, PROMOS, RATINGS, ETC.
// ============================================================================

// ------------------------ DATABASE SETUP (new tables) ------------------------
async function setupDeliveryTables() {
    const client = await pool.connect();
    try {
        // Products table
        await client.query(`
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
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP,
                delivery_radius INT DEFAULT 10
            )
        `);

        // User addresses
        await client.query(`
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
            )
        `);

        // Orders
        await client.query(`
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
            )
        `);

        // Order items
        await client.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
                product_id INT REFERENCES products(id) ON DELETE CASCADE NOT NULL,
                quantity INT NOT NULL,
                price_at_time DECIMAL(10,2) NOT NULL
            )
        `);

        // Delivery requests
        await client.query(`
            CREATE TABLE IF NOT EXISTS delivery_requests (
                id SERIAL PRIMARY KEY,
                order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
                partner_id INT REFERENCES users(id) NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                expires_at TIMESTAMP
            )
        `);

        // Promo codes
        await client.query(`
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
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS promo_usage (
                id SERIAL PRIMARY KEY,
                promo_code_id INT REFERENCES promo_codes(id),
                user_id INT REFERENCES users(id),
                order_id INT REFERENCES orders(id),
                used_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Order ratings
        await client.query(`
            CREATE TABLE IF NOT EXISTS order_ratings (
                id SERIAL PRIMARY KEY,
                order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
                rating INT CHECK (rating BETWEEN 1 AND 5),
                comment TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Partner reviews
        await client.query(`
            CREATE TABLE IF NOT EXISTS partner_reviews (
                id SERIAL PRIMARY KEY,
                order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
                partner_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
                rating INT CHECK (rating BETWEEN 1 AND 5),
                comment TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // Partner earnings
        await client.query(`
            CREATE TABLE IF NOT EXISTS partner_earnings (
                id SERIAL PRIMARY KEY,
                partner_id INT REFERENCES users(id) ON DELETE CASCADE NOT NULL,
                order_id INT REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                paid_at TIMESTAMP
            )
        `);

        // Disputes
        await client.query(`
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
            )
        `);

        // Add columns to businesses if not exist
        await client.query(`
            ALTER TABLE businesses 
            ADD COLUMN IF NOT EXISTS delivery_radius INT DEFAULT 10,
            ADD COLUMN IF NOT EXISTS is_delivery_enabled BOOLEAN DEFAULT true,
            ADD COLUMN IF NOT EXISTS delivery_slots JSONB DEFAULT '{"start": "09:00", "end": "21:00"}'::jsonb
        `);

        // Add columns to users if not exist
        await client.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS last_latitude DECIMAL(10,8),
            ADD COLUMN IF NOT EXISTS last_longitude DECIMAL(11,8),
            ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS total_deliveries INT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS earnings DECIMAL(10,2) DEFAULT 0
        `);

        console.log('✅ Delivery tables setup complete');
    } catch (err) {
        console.error('Error setting up delivery tables:', err);
    } finally {
        client.release();
    }
}

// Call setup
setupDeliveryTables();

// ------------------------ HELPER: Distance calculation (Haversine) ------------------------
function haversineDistance(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ------------------------ PRODUCTS ENDPOINTS ------------------------
app.get('/api/products', async (req, res) => {
    const { lat, lng, radius = 10, category, search, business_id } = req.query;
    try {
        let query = `
            SELECT p.*, b.id as business_id, b.name as business_name, b.lat, b.lng,
                   b.address, b.city, b.state, b.phone as business_phone,
                   b.avg_rating as business_rating, b.verified as business_verified
            FROM products p
            JOIN businesses b ON p.business_id = b.id
            WHERE p.is_available = true AND b.approved = true AND b.is_delivery_enabled = true
        `;
        const params = [];
        let paramCount = 1;

        if (business_id) {
            query += ` AND p.business_id = $${paramCount}`;
            params.push(business_id);
            paramCount++;
        }
        if (category) {
            query += ` AND p.category = $${paramCount}`;
            params.push(category);
            paramCount++;
        }
        if (search) {
            query += ` AND (p.name ILIKE $${paramCount} OR p.description ILIKE $${paramCount})`;
            params.push(`%${search}%`);
            paramCount++;
        }

        query += ` ORDER BY p.created_at DESC`;
        const result = await pool.query(query, params);

        let products = result.rows;
        if (lat && lng) {
            const rad = parseFloat(radius) || 10;
            products = products.filter(p => {
                if (p.lat == null || p.lng == null) return false;
                const dist = haversineDistance(parseFloat(lat), parseFloat(lng), parseFloat(p.lat), parseFloat(p.lng));
                return dist !== null && dist <= rad;
            });
            products = products.map(p => ({
                ...p,
                distance: haversineDistance(parseFloat(lat), parseFloat(lng), parseFloat(p.lat), parseFloat(p.lng))
            }));
        }

        res.json(products);
    } catch (err) {
        console.error('Error fetching products:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

app.post('/api/products', isAuthenticated, async (req, res) => {
    const { business_id, name, description, price, category, image_url, stock_quantity, delivery_radius } = req.body;
    if (!business_id || !name || price == null) {
        return res.status(400).json({ error: 'Business ID, name, and price are required' });
    }
    try {
        const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [business_id, req.session.userId]);
        if (biz.rows.length === 0) {
            return res.status(403).json({ error: 'You do not own this business' });
        }
        const result = await pool.query(
            `INSERT INTO products (business_id, name, description, price, category, image_url, stock_quantity, delivery_radius, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
            [business_id, name, description || '', price, category || 'other', image_url || null, stock_quantity || 0, delivery_radius || 10]
        );
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error('Product creation error:', err);
        res.status(500).json({ error: 'Failed to create product' });
    }
});

app.put('/api/products/:id', isAuthenticated, async (req, res) => {
    const productId = req.params.id;
    const { name, description, price, category, image_url, stock_quantity, is_available, delivery_radius } = req.body;
    try {
        const prod = await pool.query(`
            SELECT p.id, b.user_id FROM products p
            JOIN businesses b ON p.business_id = b.id
            WHERE p.id = $1
        `, [productId]);
        if (prod.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
        if (prod.rows[0].user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Not your product' });
        }
        await pool.query(
            `UPDATE products SET
                name = COALESCE($1, name),
                description = COALESCE($2, description),
                price = COALESCE($3, price),
                category = COALESCE($4, category),
                image_url = COALESCE($5, image_url),
                stock_quantity = COALESCE($6, stock_quantity),
                is_available = COALESCE($7, is_available),
                delivery_radius = COALESCE($8, delivery_radius),
                updated_at = NOW()
             WHERE id = $9`,
            [name, description, price, category, image_url, stock_quantity, is_available, delivery_radius, productId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update product' });
    }
});

app.delete('/api/products/:id', isAuthenticated, async (req, res) => {
    const productId = req.params.id;
    try {
        const prod = await pool.query(`
            SELECT p.id, b.user_id FROM products p
            JOIN businesses b ON p.business_id = b.id
            WHERE p.id = $1
        `, [productId]);
        if (prod.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
        if (prod.rows[0].user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Not your product' });
        }
        await pool.query('DELETE FROM products WHERE id = $1', [productId]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete product' });
    }
});

// ------------------------ PRODUCT IMAGE UPLOAD ------------------------
app.post('/api/products/:id/image', isAuthenticated, uploadProductImage.single('image'), async (req, res) => {
    const productId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const prod = await pool.query(`
            SELECT p.id, b.user_id FROM products p
            JOIN businesses b ON p.business_id = b.id
            WHERE p.id = $1
        `, [productId]);
        if (prod.rows.length === 0) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Product not found' });
        }
        if (prod.rows[0].user_id !== req.session.userId) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: 'Not your product' });
        }

        const imageUrl = '/uploads/products/' + req.file.filename;
        await pool.query(
            'UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2',
            [imageUrl, productId]
        );

        res.json({ success: true, imageUrl });
    } catch (err) {
        console.error(err);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

// Get products for a business (for owner dashboard)
app.get('/api/business/:id/products', isAuthenticated, async (req, res) => {
    const businessId = req.params.id;
    try {
        const biz = await pool.query('SELECT user_id FROM businesses WHERE id = $1', [businessId]);
        if (biz.rows.length === 0) return res.status(404).json({ error: 'Business not found' });
        if (biz.rows[0].user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Not your business' });
        }
        const result = await pool.query(
            'SELECT * FROM products WHERE business_id = $1 ORDER BY created_at DESC',
            [businessId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// ------------------------ USER ADDRESSES ------------------------
app.get('/api/user/addresses', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM user_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
            [req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch addresses' });
    }
});

app.post('/api/user/addresses', isAuthenticated, async (req, res) => {
    const { label, address, latitude, longitude, instructions, is_default } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });
    try {
        if (is_default) {
            await pool.query('UPDATE user_addresses SET is_default = false WHERE user_id = $1', [req.session.userId]);
        }
        const result = await pool.query(
            `INSERT INTO user_addresses (user_id, label, address, latitude, longitude, instructions, is_default)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [req.session.userId, label || 'Home', address, latitude || null, longitude || null, instructions || null, is_default || false]
        );
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add address' });
    }
});

app.delete('/api/user/addresses/:id', isAuthenticated, async (req, res) => {
    const addrId = req.params.id;
    try {
        const addr = await pool.query('SELECT id FROM user_addresses WHERE id = $1 AND user_id = $2', [addrId, req.session.userId]);
        if (addr.rows.length === 0) return res.status(404).json({ error: 'Address not found' });
        await pool.query('DELETE FROM user_addresses WHERE id = $1', [addrId]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete address' });
    }
});

app.put('/api/user/addresses/:id/default', isAuthenticated, async (req, res) => {
    const addrId = req.params.id;
    try {
        const addr = await pool.query('SELECT id FROM user_addresses WHERE id = $1 AND user_id = $2', [addrId, req.session.userId]);
        if (addr.rows.length === 0) return res.status(404).json({ error: 'Address not found' });
        await pool.query('UPDATE user_addresses SET is_default = false WHERE user_id = $1', [req.session.userId]);
        await pool.query('UPDATE user_addresses SET is_default = true WHERE id = $1', [addrId]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to set default' });
    }
});

// ------------------------ PROMO CODES ------------------------
app.get('/api/promos/validate', isAuthenticated, async (req, res) => {
    const { code, order_total } = req.query;
    if (!code || !order_total) return res.status(400).json({ error: 'Code and order total required' });
    try {
        const promo = await pool.query(`
            SELECT * FROM promo_codes
            WHERE code = $1 AND is_active = true
              AND (valid_from IS NULL OR valid_from <= NOW())
              AND (valid_until IS NULL OR valid_until >= NOW())
              AND (usage_limit IS NULL OR used_count < usage_limit)
        `, [code.toUpperCase()]);
        if (promo.rows.length === 0) {
            return res.status(404).json({ error: 'Invalid or expired promo code' });
        }
        const p = promo.rows[0];
        const total = parseFloat(order_total);
        if (total < p.min_order_value) {
            return res.status(400).json({ error: `Minimum order value ₹${p.min_order_value} required` });
        }
        let discount = 0;
        if (p.discount_type === 'percentage') {
            discount = total * (p.discount_value / 100);
            if (p.max_discount && discount > p.max_discount) discount = p.max_discount;
        } else {
            discount = p.discount_value;
        }
        discount = Math.min(discount, total);
        res.json({
            code: p.code,
            discount: Math.round(discount * 100) / 100,
            description: p.description
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to validate promo' });
    }
});

// Admin: create promo
app.post('/api/admin/promos', isAdmin, async (req, res) => {
    const { code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, valid_until } = req.body;
    if (!code || !discount_value) return res.status(400).json({ error: 'Code and value required' });
    try {
        await pool.query(
            `INSERT INTO promo_codes (code, description, discount_type, discount_value, min_order_value, max_discount, usage_limit, valid_until, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [code.toUpperCase(), description || '', discount_type || 'percentage', discount_value, min_order_value || 0, max_discount || null, usage_limit || null, valid_until || null, req.session.userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create promo' });
    }
});

// ------------------------ ORDER PLACEMENT (with COD + confirmation) ------------------------
app.post('/api/orders/place', isAuthenticated, async (req, res) => {
    const { 
        business_id, 
        items,
        address, 
        instructions, 
        latitude, 
        longitude, 
        promo_code, 
        scheduled_at,
        paid_with_credits,
        payment_method = 'cod'
    } = req.body;

    if (!business_id || !items || !items.length || !address) {
        return res.status(400).json({ error: 'Business, items, and address are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const bizResult = await client.query(
            'SELECT id, name, delivery_radius FROM businesses WHERE id = $1 AND approved = true AND is_delivery_enabled = true',
            [business_id]
        );
        if (bizResult.rows.length === 0) {
            throw new Error('Business not found or delivery not enabled');
        }
        const business = bizResult.rows[0];

        let total = 0;
        const orderItems = [];
        for (const item of items) {
            const prod = await client.query(
                'SELECT * FROM products WHERE id = $1 AND business_id = $2 AND is_available = true',
                [item.product_id, business_id]
            );
            if (prod.rows.length === 0) {
                throw new Error(`Product ${item.product_id} not available`);
            }
            const p = prod.rows[0];
            if (p.stock_quantity < item.quantity) {
                throw new Error(`Insufficient stock for ${p.name}`);
            }
            const subtotal = p.price * item.quantity;
            total += subtotal;
            orderItems.push({
                product_id: p.id,
                quantity: item.quantity,
                price_at_time: p.price
            });
        }

        if (total < 199) {
            throw new Error('Minimum order value is ₹199');
        }

        let discount = 0;
        let promoId = null;
        if (promo_code) {
            const promoRes = await client.query(
                'SELECT * FROM promo_codes WHERE code = $1 AND is_active = true AND (valid_until IS NULL OR valid_until >= NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)',
                [promo_code.toUpperCase()]
            );
            if (promoRes.rows.length > 0) {
                const p = promoRes.rows[0];
                if (total >= p.min_order_value) {
                    if (p.discount_type === 'percentage') {
                        discount = total * (p.discount_value / 100);
                        if (p.max_discount && discount > p.max_discount) discount = p.max_discount;
                    } else {
                        discount = p.discount_value;
                    }
                    discount = Math.min(discount, total);
                    promoId = p.id;
                }
            }
        }

        const finalTotal = Math.round((total - discount) * 100) / 100;

        let paidWithCredits = paid_with_credits || false;
        if (paidWithCredits) {
            const credits = await client.query('SELECT balance FROM user_credits WHERE user_id = $1', [req.session.userId]);
            if (credits.rows.length === 0 || credits.rows[0].balance < finalTotal) {
                throw new Error('Insufficient credits to pay for this order');
            }
        }

        const baseTime = 30;
        let extraTime = 0;
        if (latitude && longitude && business.lat && business.lng) {
            const dist = haversineDistance(latitude, longitude, business.lat, business.lng);
            if (dist !== null) {
                extraTime = Math.floor(dist / 5) * 10;
            }
        }
        const estimatedMinutes = Math.min(120, baseTime + extraTime);

        const confirmationToken = crypto.randomBytes(32).toString('hex');

        const orderResult = await client.query(
            `INSERT INTO orders (
                user_id, business_id, total_amount, delivery_address, delivery_instructions,
                latitude, longitude, status, placed_at, estimated_delivery_minutes,
                scheduled_at, promo_code, discount_amount, delivery_fee, paid_with_credits, paid_amount,
                payment_method, confirmation_token
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_confirmation', NOW(), $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING id`,
            [req.session.userId, business_id, finalTotal, address, instructions || null,
             latitude || null, longitude || null, estimatedMinutes,
             scheduled_at || null, promo_code || null, discount, 0,
             paidWithCredits, finalTotal, payment_method, confirmationToken]
        );
        const orderId = orderResult.rows[0].id;

        for (const item of orderItems) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_time)
                 VALUES ($1, $2, $3, $4)`,
                [orderId, item.product_id, item.quantity, item.price_at_time]
            );
            await client.query(
                'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
                [item.quantity, item.product_id]
            );
        }

        if (promoId) {
            await client.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1', [promoId]);
            await client.query(
                'INSERT INTO promo_usage (promo_code_id, user_id, order_id) VALUES ($1, $2, $3)',
                [promoId, req.session.userId, orderId]
            );
        }

        if (paidWithCredits) {
            await client.query(
                'UPDATE user_credits SET balance = balance - $1 WHERE user_id = $2',
                [finalTotal, req.session.userId]
            );
            await client.query(
                `INSERT INTO credit_transactions (user_id, amount, type, description)
                 VALUES ($1, $2, 'spend', $3)`,
                [req.session.userId, finalTotal, `Order #${orderId} payment`]
            );
        }

        await client.query('COMMIT');

        const user = await client.query('SELECT email, username FROM users WHERE id = $1', [req.session.userId]);
        const userEmail = user.rows[0]?.email;
        const userName = user.rows[0]?.username || 'User';

        if (userEmail) {
            const confirmLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/businessdirectory.html?token=${confirmationToken}`;
            const subject = `Confirm your order #${orderId}`;
            const html = `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f4f4f4;border-radius:10px;">
                    <h2 style="color:#7c6cf0;">Order Confirmation</h2>
                    <p>Hello ${userName},</p>
                    <p>You placed an order #${orderId} on Sarveik for ₹${finalTotal}.</p>
                    <p>Please confirm your order by clicking the button below:</p>
                    <a href="${confirmLink}" style="display:inline-block;padding:12px 28px;background:#7c6cf0;color:#fff;text-decoration:none;border-radius:8px;margin:16px 0;">Confirm Order</a>
                    <p>If you did not place this order, you can ignore this email.</p>
                    <p style="font-size:0.8rem;color:#888;">This link expires in 24 hours.</p>
                </div>
            `;
            await sendEmail(userEmail, subject, html);
        }

        const bizOwner = await client.query('SELECT user_id FROM businesses WHERE id = $1', [business_id]);
        if (bizOwner.rows.length > 0) {
            const ownerId = bizOwner.rows[0].user_id;
            const ownerSocket = onlineUsers.get(ownerId);
            if (ownerSocket && ownerSocket.socketId) {
                io.to(ownerSocket.socketId).emit('new_order', {
                    orderId,
                    business_id,
                    total: finalTotal,
                    user: req.session.username,
                    placed_at: new Date().toISOString()
                });
            }
        }

        res.status(201).json({
            success: true,
            orderId,
            estimatedMinutes,
            message: `Order placed! Please check your email to confirm.`
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Order placement error:', err);
        res.status(400).json({ error: err.message || 'Failed to place order' });
    } finally {
        client.release();
    }
});

// ------------------------ ORDER CONFIRMATION (email link) ------------------------
app.get('/api/orders/confirm', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    try {
        const order = await pool.query(
            `SELECT id, user_id, status, confirmation_token FROM orders 
             WHERE confirmation_token = $1 AND status = 'pending_confirmation'`,
            [token]
        );
        if (order.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }
        const orderData = order.rows[0];

        await pool.query(
            `UPDATE orders SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [orderData.id]
        );

        const userSocket = onlineUsers.get(orderData.user_id);
        if (userSocket && userSocket.socketId) {
            io.to(userSocket.socketId).emit('order_status_update', {
                orderId: orderData.id,
                status: 'confirmed',
                message: 'Order confirmed by customer.'
            });
        }

        res.json({ success: true, message: 'Order confirmed successfully.' });
    } catch (err) {
        console.error('Confirmation error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ------------------------ ORDER CANCELLATION ------------------------
app.post('/api/orders/:id/cancel', isAuthenticated, async (req, res) => {
    const orderId = req.params.id;
    try {
        const order = await pool.query(
            'SELECT id, status, user_id FROM orders WHERE id = $1',
            [orderId]
        );
        if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
        if (order.rows[0].user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Not your order' });
        }
        if (!['pending_confirmation', 'confirmed'].includes(order.rows[0].status)) {
            return res.status(400).json({ error: 'Cannot cancel at this stage' });
        }
        await pool.query(
            'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
            ['cancelled', orderId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to cancel' });
    }
});

// ------------------------ GET ORDER DETAILS ------------------------
app.get('/api/orders/:id', isAuthenticated, async (req, res) => {
    const orderId = req.params.id;
    try {
        const order = await pool.query(`
            SELECT o.*, b.name as business_name, b.phone as business_phone,
                   u.username as customer_name, u.phone as customer_phone,
                   (SELECT json_agg(order_items) FROM order_items WHERE order_id = o.id) as items
            FROM orders o
            JOIN businesses b ON o.business_id = b.id
            JOIN users u ON o.user_id = u.id
            WHERE o.id = $1 AND (o.user_id = $2 OR $2 IN (SELECT user_id FROM businesses WHERE id = o.business_id))
        `, [orderId, req.session.userId]);
        if (order.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found or access denied' });
        }
        res.json(order.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch order' });
    }
});

// ------------------------ USER ORDERS ------------------------
app.get('/api/orders/user', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.*, b.name as business_name,
                   (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
            FROM orders o
            JOIN businesses b ON o.business_id = b.id
            WHERE o.user_id = $1
            ORDER BY o.placed_at DESC
        `, [req.session.userId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// ------------------------ ORDER RATINGS ------------------------
app.post('/api/orders/:id/rate', isAuthenticated, async (req, res) => {
    const orderId = req.params.id;
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    try {
        const order = await pool.query(
            'SELECT id, user_id, delivery_partner_id FROM orders WHERE id = $1 AND status = $2',
            [orderId, 'delivered']
        );
        if (order.rows.length === 0 || order.rows[0].user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Not allowed' });
        }
        await pool.query(
            `INSERT INTO order_ratings (order_id, rating, comment)
             VALUES ($1, $2, $3)`,
            [orderId, rating, comment || '']
        );
        if (order.rows[0].delivery_partner_id) {
            await pool.query(
                `INSERT INTO partner_reviews (order_id, partner_id, rating, comment)
                 VALUES ($1, $2, $3, $4)`,
                [orderId, order.rows[0].delivery_partner_id, rating, comment || '']
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to rate' });
    }
});

// ------------------------ BUSINESS ORDERS (for owner) ------------------------
app.get('/api/business/orders', isAuthenticated, async (req, res) => {
    const { business_id, limit = 50, offset = 0, status } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    try {
        const biz = await pool.query('SELECT user_id FROM businesses WHERE id = $1', [business_id]);
        if (biz.rows.length === 0) return res.status(404).json({ error: 'Business not found' });
        if (biz.rows[0].user_id !== req.session.userId && !['admin', 'moderator'].includes(req.session.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        let query = `
            SELECT o.*, u.username as customer_name, u.phone as customer_phone,
                   (SELECT json_agg(row_to_json(oi)) FROM order_items oi WHERE oi.order_id = o.id) as items
            FROM orders o
            JOIN users u ON o.user_id = u.id
            WHERE o.business_id = $1
        `;
        const params = [business_id];
        let paramCount = 2;
        if (status && status !== 'all') {
            query += ` AND o.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }
        query += ` ORDER BY o.placed_at DESC LIMIT $${paramCount} OFFSET $${paramCount+1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);
        const count = await pool.query('SELECT COUNT(*) as total FROM orders WHERE business_id = $1', [business_id]);

        res.json({
            orders: result.rows,
            total: parseInt(count.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// ------------------------ BUSINESS ANALYTICS ------------------------
app.get('/api/business/analytics', isAuthenticated, async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    try {
        const biz = await pool.query('SELECT user_id FROM businesses WHERE id = $1', [business_id]);
        if (biz.rows.length === 0) return res.status(404).json({ error: 'Business not found' });
        if (biz.rows[0].user_id !== req.session.userId && !['admin', 'moderator'].includes(req.session.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_orders,
                COALESCE(SUM(total_amount), 0) as total_revenue,
                COALESCE(AVG(total_amount), 0) as avg_order_value,
                COUNT(CASE WHEN status = 'delivered' THEN 1 END) as completed_orders,
                COUNT(CASE WHEN status = 'pending_confirmation' THEN 1 END) as pending_confirmation,
                COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
                COUNT(CASE WHEN status = 'preparing' THEN 1 END) as preparing,
                COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready,
                COUNT(CASE WHEN status = 'picked_up' THEN 1 END) as picked_up,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
            FROM orders
            WHERE business_id = $1
        `, [business_id]);

        const topProducts = await pool.query(`
            SELECT p.name, SUM(oi.quantity) as total_sold, SUM(oi.quantity * oi.price_at_time) as revenue
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            JOIN orders o ON oi.order_id = o.id
            WHERE o.business_id = $1 AND o.status != 'cancelled'
            GROUP BY p.id, p.name
            ORDER BY total_sold DESC
            LIMIT 10
        `, [business_id]);

        res.json({
            stats: stats.rows[0] || { total_orders: 0, total_revenue: 0, avg_order_value: 0 },
            topProducts: topProducts.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to get analytics' });
    }
});

// ------------------------ UPDATE BUSINESS (owner allowed) ------------------------
app.put('/api/admin/businesses/:id', isAuthenticated, async (req, res) => {
    const businessId = req.params.id;
    const {
        name, type, category, description, address, city, state, phone, email,
        website, whatsapp, maps, instagram, facebook, hours, amenities,
        lat, lng, delivery_radius, is_delivery_enabled
    } = req.body;

    try {
        const biz = await pool.query('SELECT user_id FROM businesses WHERE id = $1', [businessId]);
        if (biz.rows.length === 0) return res.status(404).json({ error: 'Business not found' });
        
        const isOwner = biz.rows[0].user_id === req.session.userId;
        const isAdminMod = ['admin', 'moderator'].includes(req.session.role);
        
        if (!isOwner && !isAdminMod) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await pool.query(`
            UPDATE businesses SET
                name = $1, type = $2, category = $3, description = $4,
                address = $5, city = $6, state = $7, phone = $8, email = $9,
                website = $10, whatsapp = $11, maps = $12, instagram = $13, facebook = $14,
                hours = $15, amenities = $16, lat = $17, lng = $18,
                delivery_radius = $19, is_delivery_enabled = $20, updated_at = NOW()
            WHERE id = $21
        `, [
            name, type, category, description, address, city, state, phone, email,
            website, whatsapp, maps, instagram, facebook,
            hours ? JSON.stringify(hours) : null,
            amenities ? JSON.stringify(amenities) : null,
            lat || null, lng || null,
            delivery_radius || 10, is_delivery_enabled !== undefined ? is_delivery_enabled : true,
            businessId
        ]);

        res.json({ success: true, message: 'Business updated' });
    } catch (err) {
        console.error('Business update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ------------------------ DELIVERY PARTNER ENDPOINTS ------------------------
app.post('/api/delivery-partner/register', isAuthenticated, async (req, res) => {
    try {
        const user = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        if (user.rows[0].role === 'delivery_partner') {
            return res.status(400).json({ error: 'Already a delivery partner' });
        }
        await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['delivery_partner', req.session.userId]);
        res.json({ success: true, message: 'Registered as delivery partner' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.patch('/api/delivery-partner/status', isDeliveryPartner, async (req, res) => {
    const { is_online, lat, lng } = req.body;
    try {
        await pool.query(
            `UPDATE users SET is_online = $1, last_latitude = COALESCE($2, last_latitude), last_longitude = COALESCE($3, last_longitude)
             WHERE id = $4`,
            [is_online !== undefined ? is_online : true, lat || null, lng || null, req.session.userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

app.get('/api/delivery-partner/orders', isDeliveryPartner, async (req, res) => {
    const partnerId = req.session.userId;
    try {
        const active = await pool.query(`
            SELECT o.*, b.name as business_name, b.address as business_address,
                   b.lat as business_lat, b.lng as business_lng,
                   u.username as customer_name, u.phone as customer_phone
            FROM orders o
            JOIN businesses b ON o.business_id = b.id
            JOIN users u ON o.user_id = u.id
            WHERE o.delivery_partner_id = $1
              AND o.status NOT IN ('delivered', 'cancelled')
            ORDER BY o.placed_at DESC
        `, [partnerId]);

        const completed = await pool.query(`
            SELECT o.*, b.name as business_name,
                   u.username as customer_name,
                   o.placed_at, o.updated_at
            FROM orders o
            JOIN businesses b ON o.business_id = b.id
            JOIN users u ON o.user_id = u.id
            WHERE o.delivery_partner_id = $1
              AND o.status IN ('delivered', 'cancelled')
            ORDER BY o.updated_at DESC
            LIMIT 20
        `, [partnerId]);

        const requests = await pool.query(`
            SELECT dr.*, o.*, b.name as business_name, b.address as business_address,
                   b.lat as business_lat, b.lng as business_lng,
                   u.username as customer_name
            FROM delivery_requests dr
            JOIN orders o ON dr.order_id = o.id
            JOIN businesses b ON o.business_id = b.id
            JOIN users u ON o.user_id = u.id
            WHERE dr.partner_id = $1 AND dr.status = 'pending' AND dr.expires_at > NOW()
        `, [partnerId]);

        res.json({
            active: active.rows,
            completed: completed.rows,
            requests: requests.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

app.patch('/api/delivery-partner/order/:id/accept', isDeliveryPartner, async (req, res) => {
    const orderId = req.params.id;
    const partnerId = req.session.userId;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const reqResult = await client.query(`
            SELECT id FROM delivery_requests
            WHERE order_id = $1 AND partner_id = $2 AND status = 'pending' AND expires_at > NOW()
        `, [orderId, partnerId]);
        if (reqResult.rows.length === 0) {
            throw new Error('No pending request found or expired');
        }

        await client.query(
            'UPDATE delivery_requests SET status = $1 WHERE order_id = $2 AND partner_id = $3',
            ['accepted', orderId, partnerId]
        );

        await client.query(
            'UPDATE orders SET delivery_partner_id = $1, status = $2, updated_at = NOW() WHERE id = $3',
            [partnerId, 'confirmed', orderId]
        );

        const others = await client.query(
            'SELECT partner_id FROM delivery_requests WHERE order_id = $1 AND status = $2 AND partner_id != $3',
            [orderId, 'pending', partnerId]
        );
        for (const row of others.rows) {
            const socket = onlineUsers.get(row.partner_id);
            if (socket && socket.socketId) {
                io.to(socket.socketId).emit('delivery_request_taken', { orderId });
            }
        }

        const order = await client.query('SELECT user_id FROM orders WHERE id = $1', [orderId]);
        if (order.rows.length > 0) {
            const userSocket = onlineUsers.get(order.rows[0].user_id);
            if (userSocket && userSocket.socketId) {
                io.to(userSocket.socketId).emit('order_status_update', {
                    orderId,
                    status: 'confirmed',
                    message: 'A delivery partner has accepted your order!'
                });
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Order accepted' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(400).json({ error: err.message || 'Failed to accept' });
    } finally {
        client.release();
    }
});

app.patch('/api/delivery-partner/order/:id/pickup', isDeliveryPartner, async (req, res) => {
    const orderId = req.params.id;
    const partnerId = req.session.userId;
    try {
        const order = await pool.query(
            'SELECT id FROM orders WHERE id = $1 AND delivery_partner_id = $2 AND status = $3',
            [orderId, partnerId, 'ready']
        );
        if (order.rows.length === 0) {
            return res.status(400).json({ error: 'Order not in ready state or not assigned' });
        }
        await pool.query(
            'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
            ['picked_up', orderId]
        );
        const orderData = await pool.query('SELECT user_id FROM orders WHERE id = $1', [orderId]);
        if (orderData.rows.length > 0) {
            const userSocket = onlineUsers.get(orderData.rows[0].user_id);
            if (userSocket && userSocket.socketId) {
                io.to(userSocket.socketId).emit('order_status_update', {
                    orderId,
                    status: 'picked_up',
                    message: 'Your order has been picked up and is on the way!'
                });
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update pickup' });
    }
});

app.patch('/api/delivery-partner/order/:id/deliver', isDeliveryPartner, async (req, res) => {
    const orderId = req.params.id;
    const partnerId = req.session.userId;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const order = await client.query(
            'SELECT id, user_id, placed_at FROM orders WHERE id = $1 AND delivery_partner_id = $2 AND status = $3',
            [orderId, partnerId, 'picked_up']
        );
        if (order.rows.length === 0) {
            throw new Error('Order not in picked_up state or not assigned');
        }
        const now = new Date();
        const placed = new Date(order.rows[0].placed_at);
        const actualMinutes = Math.round((now - placed) / 60000);
        await client.query(
            'UPDATE orders SET status = $1, updated_at = NOW(), actual_delivery_minutes = $2 WHERE id = $3',
            ['delivered', actualMinutes, orderId]
        );

        await client.query(
            'UPDATE users SET total_deliveries = total_deliveries + 1, earnings = earnings + 50 WHERE id = $1',
            [partnerId]
        );

        await client.query(
            `INSERT INTO partner_earnings (partner_id, order_id, amount, status)
             VALUES ($1, $2, 50, 'completed')`,
            [partnerId, orderId]
        );

        const userSocket = onlineUsers.get(order.rows[0].user_id);
        if (userSocket && userSocket.socketId) {
            io.to(userSocket.socketId).emit('order_status_update', {
                orderId,
                status: 'delivered',
                message: 'Your order has been delivered!'
            });
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(400).json({ error: err.message || 'Failed to deliver' });
    } finally {
        client.release();
    }
});

// ------------------------ ORDER STATUS UPDATE (Business side) ------------------------
app.patch('/api/orders/:id/status', isAuthenticated, async (req, res) => {
    const orderId = req.params.id;
    const { status } = req.body;
    const validStatuses = ['confirmed', 'preparing', 'ready', 'cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    try {
        const order = await pool.query(`
            SELECT o.id, o.user_id, b.user_id as owner_id, o.status as current_status
            FROM orders o
            JOIN businesses b ON o.business_id = b.id
            WHERE o.id = $1
        `, [orderId]);
        if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
        if (order.rows[0].owner_id !== req.session.userId) {
            return res.status(403).json({ error: 'Not your order' });
        }
        const current = order.rows[0].current_status;
        if (status === 'confirmed' && current !== 'pending_confirmation') {
            return res.status(400).json({ error: 'Can only confirm orders pending confirmation' });
        }
        if (status === 'preparing' && !['confirmed', 'preparing'].includes(current)) {
            return res.status(400).json({ error: 'Can only prepare confirmed orders' });
        }
        if (status === 'ready' && current !== 'preparing') {
            return res.status(400).json({ error: 'Can only mark ready after preparing' });
        }
        if (status === 'cancelled' && !['pending_confirmation', 'confirmed'].includes(current)) {
            return res.status(400).json({ error: 'Can only cancel pending or confirmed orders' });
        }

        await pool.query(
            'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
            [status, orderId]
        );

        const orderData = await pool.query('SELECT user_id, delivery_partner_id FROM orders WHERE id = $1', [orderId]);
        if (orderData.rows.length > 0) {
            const userId = orderData.rows[0].user_id;
            const partnerId = orderData.rows[0].delivery_partner_id;
            const userSocket = onlineUsers.get(userId);
            if (userSocket && userSocket.socketId) {
                io.to(userSocket.socketId).emit('order_status_update', {
                    orderId,
                    status,
                    message: `Order status updated to ${status}`
                });
            }
            if (partnerId) {
                const partnerSocket = onlineUsers.get(partnerId);
                if (partnerSocket && partnerSocket.socketId) {
                    io.to(partnerSocket.socketId).emit('order_status_update', {
                        orderId,
                        status,
                        message: `Order status updated to ${status}`
                    });
                }
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// ------------------------ DISPATCH HELPER (called after order placement) ------------------------
async function createDeliveryRequest(orderId, businessId, userLat, userLng) {
    try {
        const business = await pool.query('SELECT delivery_radius, lat, lng FROM businesses WHERE id = $1', [businessId]);
        if (business.rows.length === 0) return;
        const radius = business.rows[0].delivery_radius || 10;
        const bLat = business.rows[0].lat;
        const bLng = business.rows[0].lng;

        const partners = await pool.query(`
            SELECT id, last_latitude, last_longitude FROM users
            WHERE role = 'delivery_partner' AND is_online = true
              AND last_latitude IS NOT NULL AND last_longitude IS NOT NULL
        `);

        const nearby = [];
        for (const p of partners.rows) {
            const dist = haversineDistance(bLat, bLng, p.last_latitude, p.last_longitude);
            if (dist !== null && dist <= radius) {
                nearby.push({ ...p, distance: dist });
            }
        }
        nearby.sort((a,b) => a.distance - b.distance);

        const limit = Math.min(nearby.length, 5);
        for (let i = 0; i < limit; i++) {
            const partner = nearby[i];
            const expires = new Date(Date.now() + 5 * 60 * 1000);
            const req = await pool.query(
                `INSERT INTO delivery_requests (order_id, partner_id, status, expires_at)
                 VALUES ($1, $2, 'pending', $3) RETURNING id`,
                [orderId, partner.id, expires]
            );
            const partnerSocket = onlineUsers.get(partner.id);
            if (partnerSocket && partnerSocket.socketId) {
                const order = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
                const orderData = order.rows[0];
                io.to(partnerSocket.socketId).emit('new_delivery_request', {
                    requestId: req.rows[0].id,
                    orderId,
                    businessId,
                    distance: partner.distance,
                    total: orderData.total_amount,
                    address: orderData.delivery_address,
                    estimatedMinutes: orderData.estimated_delivery_minutes,
                    expiresAt: expires
                });
            }
        }
    } catch (err) {
        console.error('Dispatch error:', err);
    }
}

// ------------------------ PARTNER EARNINGS ------------------------
app.get('/api/delivery-partner/earnings', isDeliveryPartner, async (req, res) => {
    const partnerId = req.session.userId;
    try {
        const earnings = await pool.query(`
            SELECT id, order_id, amount, status, created_at, paid_at
            FROM partner_earnings
            WHERE partner_id = $1
            ORDER BY created_at DESC
        `, [partnerId]);
        const summary = await pool.query(`
            SELECT 
                COALESCE(SUM(amount), 0) as total_earned,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) as paid
            FROM partner_earnings
            WHERE partner_id = $1
        `, [partnerId]);
        res.json({
            earnings: earnings.rows,
            summary: summary.rows[0] || { total_earned: 0, pending: 0, paid: 0 }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch earnings' });
    }
});

// ------------------------ USER'S OWN BUSINESSES ------------------------
app.get('/api/user/businesses', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, city, state, approved FROM businesses WHERE user_id = $1 ORDER BY name',
            [req.session.userId]
        );
        res.json({ businesses: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch businesses' });
    }
});

// ------------------------ GOOGLE RATING PROXY ------------------------
app.get('/api/google-rating', async (req, res) => {
    const { place_id } = req.query;
    if (!place_id) return res.status(400).json({ error: 'place_id required' });
    try {
        if (process.env.GOOGLE_PLACES_API_KEY) {
            const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=rating,user_ratings_total&key=${process.env.GOOGLE_PLACES_API_KEY}`;
            const response = await fetch(url);
            const data = await response.json();
            if (data.status === 'OK' && data.result) {
                return res.json({
                    rating: data.result.rating || null,
                    user_ratings_total: data.result.user_ratings_total || 0
                });
            }
        }
        res.json({ rating: null, user_ratings_total: 0 });
    } catch (err) {
        console.error('Google rating fetch error:', err);
        res.json({ rating: null, user_ratings_total: 0 });
    }
});

// ------------------------ AFFILIATE LINKS FOR BUSINESS (detail modal) ------------------------
app.get('/api/affiliate/business/:businessId/links', isAuthenticated, async (req, res) => {
    const businessId = req.params.businessId;
    try {
        const result = await pool.query(`
            SELECT id, product_name, product_url, commission_rate, click_count, sale_count
            FROM affiliate_links
            WHERE business_id = $1 AND is_active = true
        `, [businessId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch affiliate links' });
    }
});

module.exports = app;