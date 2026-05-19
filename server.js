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

// ==================== SESSION MIDDLEWARE (PostgreSQL store) ====================
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
// FIXED: Use ipKeyGenerator properly
const otpVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => {
        if (req.body.email) return req.body.email;
        return ipKeyGenerator(req);
    },
    message: 'Too many OTP verification attempts, please try again later.'
});

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

// ==================== FILE UPLOAD ====================
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

app.get('/uploads/avatars/:filename', isAuthenticated, (req, res) => {
    const filepath = path.join(__dirname, 'private_uploads', 'avatars', req.params.filename);
    if (fs.existsSync(filepath)) {
        res.sendFile(filepath);
    } else {
        res.status(404).send('Avatar not found');
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
        else res.redirect('/dashboard.html');
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
             WHERE user_id = $1 AND type = 'earn' AND (description LIKE '%admin%' OR description LIKE '%reward%')
             ORDER BY created_at DESC`,
            [req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
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
        res.send('Avatar uploaded successfully');
    } catch (err) {
        console.error(err);
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).send('Server error');
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
        { id: 6, title: "Write a Review", description: "Review tools and earn credits", amount: 10, icon: "fa-star", action: "write_review", frequency: "per_review" }
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
        { id: 5, title: "Message Boosts", description: "Highlight your messages in chats (10 uses)", cost: 50, icon: "fa-bolt", duration: "10 uses", popular: false, feature: "boost" }
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
async function getAIResponseForSupport(subject, message, conversationHistory = []) {
    try {
        const prompt = `You are a support assistant for Sraveik . 
        User subject: ${subject}
        User message: ${message}
        Previous conversation: ${JSON.stringify(conversationHistory)}
        Provide a helpful, concise answer. If you cannot answer, say "I cannot answer this. A human moderator will assist you shortly."`;
        
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
    const ticket = await pool.query(
        `SELECT t.*, u.username as user_name, u.email as user_email
         FROM support_tickets t
         JOIN users u ON t.user_id = u.id
         WHERE t.id = $1`,
        [ticketId]
    );
    if (ticket.rows.length === 0) return null;
    const ticketData = ticket.rows[0];
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
        const result = await pool.query(
            `INSERT INTO support_tickets (user_id, subject, message, replies, status, created_at)
             VALUES ($1, $2, $3, '[]', 'open', NOW())
             RETURNING id`,
            [req.session.userId, subject, message]
        );
        const ticketId = result.rows[0].id;
        
        const aiReplyText = await getAIResponseForSupport(subject, message);
        const aiReply = {
            id: Date.now(),
            message: aiReplyText,
            sender_id: null,
            sender_name: 'Sraveik AI',
            sender_role: 'ai',
            created_at: new Date().toISOString()
        };
        
        await pool.query(
            `UPDATE support_tickets SET replies = $1, ai_handled = true WHERE id = $2`,
            [JSON.stringify([aiReply]), ticketId]
        );
        
        res.status(201).json({ success: true, ticketId: ticketId, aiReply: aiReplyText });
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
        
        if (ticketData.user_id !== req.session.userId && req.session.role !== 'admin' && req.session.role !== 'moderator') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const moderator = await pool.query(`
            SELECT u.id, u.username, u.email
            FROM users u
            LEFT JOIN moderator_status ms ON u.id = ms.user_id
            WHERE u.role = 'moderator'
            AND (ms.is_online = true OR ms.is_online IS NULL)
            ORDER BY COALESCE(ms.current_tickets, 0) ASC
            LIMIT 1
        `);
        
        if (moderator.rows.length === 0) {
            return res.status(503).json({ error: 'No moderator available. Please try again later.' });
        }
        
        const moderatorId = moderator.rows[0].id;
        const moderatorName = moderator.rows[0].username;
        
        await pool.query(
            `UPDATE support_tickets SET assigned_to = $1, escalated_at = NOW(), ai_handled = false WHERE id = $2`,
            [moderatorId, ticketId]
        );
        
        await pool.query(`
            INSERT INTO moderator_status (user_id, current_tickets, is_online, last_active)
            VALUES ($1, 1, true, NOW())
            ON CONFLICT (user_id) DO UPDATE SET current_tickets = moderator_status.current_tickets + 1, last_active = NOW()
        `, [moderatorId]);
        
        const moderatorEntry = onlineUsers.get(moderatorId);
        if (moderatorEntry && moderatorEntry.socketId) {
            io.to(moderatorEntry.socketId).emit('new_support_ticket', {
                ticketId,
                fromUser: req.session.username,
                subject: ticketData.subject
            });
        }

        io.emit('ticket_escalated', { ticketId, subject: ticketData.subject, userId: req.session.userId, username: req.session.username });
        
        res.json({ success: true, moderatorName });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/support/tickets', isAuthenticated, async (req, res) => {
    try {
        const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.rows[0]?.role);

        let query;
        let params = [];
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
                WHERE t.user_id = $1
                ORDER BY t.created_at DESC
            `;
            params.push(req.session.userId);
        }
        const result = await pool.query(query, params);
        
        const tickets = result.rows.map(t => {
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
        const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.rows[0]?.role);
        
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
        const result = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [ticketId]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/support/tickets/:id/reply', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    
    try {
        const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.rows[0]?.role);
        
        const ticket = await pool.query(
            'SELECT user_id, status, replies, assigned_to FROM support_tickets WHERE id = $1',
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
        
        if (isModOrAdmin && !ticketData.assigned_to) {
            await pool.query(
                `UPDATE support_tickets SET assigned_to = $1, last_reminder_sent = NULL, replies = $2, updated_at = NOW() WHERE id = $3`,
                [req.session.userId, JSON.stringify(replies), ticketId]
            );
        } else {
            await pool.query(
                `UPDATE support_tickets SET replies = $1, last_reminder_sent = NULL, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify(replies), ticketId]
            );
        }
        
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

app.post('/api/support/tickets/:id/forward', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    const { newModeratorId } = req.body;
    if (!newModeratorId) return res.status(400).json({ error: 'New moderator ID required' });
    try {
        const ticket = await pool.query('SELECT assigned_to FROM support_tickets WHERE id = $1', [ticketId]);
        if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const currentAssigned = ticket.rows[0].assigned_to;
        if (currentAssigned !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only assigned moderator can forward this ticket' });
        }
        const newMod = await pool.query('SELECT id FROM users WHERE id = $1 AND role = $2', [newModeratorId, 'moderator']);
        if (newMod.rows.length === 0) return res.status(404).json({ error: 'Moderator not found' });
        
        await pool.query(
            'UPDATE support_tickets SET assigned_to = $1, escalated_at = NOW() WHERE id = $2',
            [newModeratorId, ticketId]
        );
        if (currentAssigned) {
            await pool.query('UPDATE moderator_status SET current_tickets = current_tickets - 1 WHERE user_id = $1', [currentAssigned]);
        }
        await pool.query(`
            INSERT INTO moderator_status (user_id, current_tickets, last_active)
            VALUES ($1, 1, NOW())
            ON CONFLICT (user_id) DO UPDATE SET current_tickets = moderator_status.current_tickets + 1, last_active = NOW()
        `, [newModeratorId]);
        
        const newModEntry = onlineUsers.get(parseInt(newModeratorId));
        if (newModEntry && newModEntry.socketId) {
            io.to(newModEntry.socketId).emit('new_support_ticket', {
                ticketId,
                fromUser: req.session.username,
                subject: ticket.rows[0]?.subject || 'Forwarded ticket'
            });
        }
        res.json({ success: true, message: 'Ticket forwarded' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/support/tickets/:id/unassign', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        const ticket = await pool.query('SELECT assigned_to FROM support_tickets WHERE id = $1', [ticketId]);
        if (ticket.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
        const currentAssigned = ticket.rows[0].assigned_to;
        if (currentAssigned !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Only assigned moderator can unassign this ticket' });
        }
        await pool.query('UPDATE support_tickets SET assigned_to = NULL WHERE id = $1', [ticketId]);
        if (currentAssigned) {
            await pool.query('UPDATE moderator_status SET current_tickets = current_tickets - 1 WHERE user_id = $1', [currentAssigned]);
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
        const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.rows[0]?.role);
        if (!isModOrAdmin) return res.status(403).json({ error: 'Only moderators and admins can close tickets' });
        
        const result = await pool.query('UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2', ['closed', ticketId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
        res.json({ success: true, message: 'Ticket closed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/support/tickets/:id', isAuthenticated, async (req, res) => {
    const ticketId = req.params.id;
    try {
        const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const isModOrAdmin = ['admin', 'moderator'].includes(userRole.rows[0]?.role);
        if (!isModOrAdmin) return res.status(403).json({ error: 'Only moderators and admins can delete tickets' });
        
        const result = await pool.query('DELETE FROM support_tickets WHERE id = $1', [ticketId]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
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
 
        await pool.query(
            `INSERT INTO password_resets (email, otp, expires_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET otp = $2, expires_at = $3`,
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
        await pool.query(
            'DELETE FROM password_resets WHERE LOWER(email) = LOWER($1)',
            [email]
        );
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
                    avatar_url, created_at, updated_at
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