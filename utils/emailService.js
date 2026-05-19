const nodemailer = require('nodemailer');
const EventEmitter = require('events');

// ========== CONFIGURATION & VALIDATION ==========
const REQUIRED_ENV_VARS = ['EMAIL_USER', 'EMAIL_PASS'];
const MISSING_VARS = REQUIRED_ENV_VARS.filter(varName => !process.env[varName]);
if (MISSING_VARS.length > 0) {
    console.error(`❌ Missing required environment variables: ${MISSING_VARS.join(', ')}`);
    if (process.env.NODE_ENV === 'production') {
        throw new Error(`Email service misconfigured: missing ${MISSING_VARS.join(', ')}`);
    }
}

const EMAIL_CONFIG = {
    fromName: process.env.EMAIL_FROM_NAME || 'SARVEIK',
    adminEmail: process.env.ADMIN_EMAIL,
    maxRetries: parseInt(process.env.EMAIL_MAX_RETRIES, 10) || 3,
    retryDelayMs: parseInt(process.env.EMAIL_RETRY_DELAY_MS, 10) || 1000,
    queueConcurrency: parseInt(process.env.EMAIL_QUEUE_CONCURRENCY, 10) || 5,
    rateLimitPerMinute: parseInt(process.env.EMAIL_RATE_LIMIT, 10) || 60,
    poolMaxConnections: parseInt(process.env.EMAIL_POOL_MAX, 10) || 5,
    poolMaxMessages: parseInt(process.env.EMAIL_POOL_MAX_MESSAGES, 10) || 100,
    sendTimeoutMs: parseInt(process.env.EMAIL_SEND_TIMEOUT_MS, 10) || 30000,
};

// ========== HTML ESCAPING (SECURITY) ==========
const escapeHtml = (str) => {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

// ========== EMAIL VALIDATION ==========
const isValidEmail = (email) => {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
    return emailRegex.test(email);
};

// ========== TRANSPORTER WITH CONNECTION POOLING ==========
const transporter = nodemailer.createTransport({
    service: 'gmail',
    pool: true,
    maxConnections: EMAIL_CONFIG.poolMaxConnections,
    maxMessages: EMAIL_CONFIG.poolMaxMessages,
    rateDelta: 60000, // 1 minute
    rateLimit: EMAIL_CONFIG.rateLimitPerMinute,
    connectionTimeout: EMAIL_CONFIG.sendTimeoutMs,
    greetingTimeout: 10000,
    socketTimeout: EMAIL_CONFIG.sendTimeoutMs,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// ========== CONNECTION VERIFICATION WITH RETRY ==========
let transporterReady = false;
let verificationAttempts = 0;
const MAX_VERIFY_ATTEMPTS = 3;

const verifyTransporter = async () => {
    while (verificationAttempts < MAX_VERIFY_ATTEMPTS) {
        try {
            await transporter.verify();
            transporterReady = true;
            console.log('✅ Email server ready');
            return true;
        } catch (error) {
            verificationAttempts++;
            console.error(`Email verification attempt ${verificationAttempts} failed:`, error.message);
            if (verificationAttempts < MAX_VERIFY_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    console.error('❌ Email service unavailable after multiple attempts');
    transporterReady = false;
    return false;
};

verifyTransporter();

// Periodically re-verify every hour to detect connection drops
setInterval(() => {
    if (transporterReady) {
        transporter.verify().catch(() => {
            transporterReady = false;
            console.warn('⚠️ Email connection lost, re-verifying...');
            verifyTransporter();
        });
    }
}, 3600000);

// ========== RETRY & QUEUE SYSTEM ==========
class EmailQueue {
    constructor(concurrency = 5) {
        this.queue = [];
        this.active = 0;
        this.concurrency = concurrency;
        this.results = new Map();
        this.eventEmitter = new EventEmitter();
    }

    async add(task, taskId) {
        return new Promise((resolve, reject) => {
            const wrappedTask = { task, resolve, reject, taskId: taskId || Date.now() + Math.random() };
            this.queue.push(wrappedTask);
            this.eventEmitter.emit('taskAdded');
            this.process();
        });
    }

    async process() {
        if (this.active >= this.concurrency || this.queue.length === 0) return;
        this.active++;
        const { task, resolve, reject, taskId } = this.queue.shift();
        
        try {
            const result = await task();
            this.results.set(taskId, { success: true, result });
            resolve(result);
        } catch (error) {
            this.results.set(taskId, { success: false, error });
            reject(error);
        } finally {
            this.active--;
            this.process();
        }
    }

    getStats() {
        return {
            queueLength: this.queue.length,
            activeJobs: this.active,
            totalResults: this.results.size,
        };
    }
}

const emailQueue = new EmailQueue(EMAIL_CONFIG.queueConcurrency);

// ========== CORE SEND FUNCTION WITH RETRIES ==========
const sendWithRetry = async (mailOptions, context = 'email') => {
    // Validate before queueing
    if (!transporterReady) {
        console.warn(`⚠️ Transporter not ready, attempting re-verify...`);
        await verifyTransporter();
        if (!transporterReady) {
            throw new Error('Email service not available');
        }
    }
    
    if (!mailOptions.to || !isValidEmail(mailOptions.to)) {
        throw new Error(`Invalid recipient email: ${mailOptions.to}`);
    }
    
    if (!mailOptions.from) {
        mailOptions.from = `"${EMAIL_CONFIG.fromName}" <${process.env.EMAIL_USER}>`;
    }

    let lastError;
    for (let attempt = 1; attempt <= EMAIL_CONFIG.maxRetries; attempt++) {
        try {
            const info = await transporter.sendMail(mailOptions);
            console.log(`📧 ${context} sent to ${mailOptions.to} [${info.messageId}]`);
            return { success: true, messageId: info.messageId };
        } catch (error) {
            lastError = error;
            console.error(`Email attempt ${attempt}/${EMAIL_CONFIG.maxRetries} failed for ${mailOptions.to}:`, error.message);
            
            // Don't retry certain errors
            if (error.code === 'EAUTH') {
                console.error('Authentication error - check EMAIL_USER and EMAIL_PASS');
                break;
            }
            if (error.code === 'EENVELOPE' || error.code === 'ECONNREFUSED') {
                break;
            }
            
            if (attempt < EMAIL_CONFIG.maxRetries) {
                const delay = EMAIL_CONFIG.retryDelayMs * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw lastError || new Error(`Failed to send ${context} after ${EMAIL_CONFIG.maxRetries} attempts`);
};

// ========== HELPER: SAFE EMAIL SENDER ==========
const sendEmail = async (mailOptions, context) => {
    try {
        return await emailQueue.add(() => sendWithRetry(mailOptions, context));
    } catch (error) {
        console.error(`Queue send error for ${context}:`, error);
        return { success: false, error: error.message };
    }
};

// ========== EXPORTED FUNCTIONS (PRESERVED SIGNATURES) ==========

const sendWelcomeEmail = async (userEmail, username) => {
    const safeUsername = escapeHtml(username);
    const safeEmail = userEmail;
    
    const mailOptions = {
        from: `"SARVEIK" <${process.env.EMAIL_USER}>`,
        to: safeEmail,
        subject: 'Welcome to Our Platform! 🎉',
        html: `
            <div style="font-family: Arial, sans-serif;">
                <h1 style="color: #667eea;">Welcome, ${safeUsername}!</h1>
                <p>Thank you for registering. We're excited to have you on board!</p>
                <p><small>If you didn't create this account, please contact support.</small></p>
            </div>
        `
    };
    
    const result = await sendEmail(mailOptions, 'welcome email');
    return result.success ? { success: true } : { success: false, error: result.error };
};

const sendPasswordChangeNotification = async (userEmail, username) => {
    const safeUsername = escapeHtml(username);
    const safeEmail = userEmail;
    
    const mailOptions = {
        from: `"SARVEIK" <${process.env.EMAIL_USER}>`,
        to: safeEmail,
        subject: 'Your Password Was Changed',
        html: `
            <div style="font-family: Arial, sans-serif;">
                <h2 style="color: #dc3545;">Password Changed</h2>
                <p>Hello ${safeUsername},</p>
                <p>Your password was successfully changed on ${escapeHtml(new Date().toLocaleString())}.</p>
                <p>If you did not make this change, please reset your password immediately.</p>
            </div>
        `
    };
    
    const result = await sendEmail(mailOptions, 'password change email');
    return result.success ? { success: true } : { success: false, error: result.error };
};

const sendAdminAlert = async (newUser) => {
    if (!EMAIL_CONFIG.adminEmail) {
        console.warn('ADMIN_EMAIL not set, skipping admin alert');
        return { success: false, error: 'ADMIN_EMAIL not configured' };
    }
    
    const safeUsername = escapeHtml(newUser.username);
    const safeEmail = escapeHtml(newUser.email);
    
    const mailOptions = {
        from: `"System Alerts" <${process.env.EMAIL_USER}>`,
        to: EMAIL_CONFIG.adminEmail,
        subject: '🔔 New User Registered',
        html: `
            <h3>New user registered:</h3>
            <ul>
                <li>Username: ${safeUsername}</li>
                <li>Email: ${safeEmail}</li>
                <li>Time: ${escapeHtml(new Date().toLocaleString())}</li>
            </ul>
        `
    };
    
    const result = await sendEmail(mailOptions, 'admin alert');
    return { success: result.success, error: result.error };
};

const sendOtpEmail = async (userEmail, otp) => {
    const safeOtp = escapeHtml(String(otp));
    const safeEmail = userEmail;
    
    const mailOptions = {
        from: `"SARVEIK" <${process.env.EMAIL_USER}>`,
        to: safeEmail,
        subject: 'Your OTP for Registration',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <h2 style="color: #667eea;">Email Verification</h2>
                <p style="font-size: 16px;">Your One-Time Password (OTP) is:</p>
                <div style="background: #f0f0f0; padding: 15px; text-align: center; font-size: 32px; letter-spacing: 5px; font-weight: bold; border-radius: 8px;">
                    ${safeOtp}
                </div>
                <p style="margin-top: 20px;">This OTP is valid for <strong>10 minutes</strong>.</p>
                <p>If you didn't request this, please ignore this email.</p>
            </div>
        `
    };
    
    const result = await sendEmail(mailOptions, 'OTP email');
    return result.success ? { success: true } : { success: false, error: result.error };
};

const sendPasswordResetOtp = async (userEmail, otp) => {
    // Enhanced validation
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.error('EMAIL_USER or EMAIL_PASS missing in .env');
        return { success: false, error: 'Email service not configured' };
    }
    
    const safeOtp = escapeHtml(String(otp));
    const safeEmail = userEmail;
    
    const mailOptions = {
        from: `"Sarveik" <${process.env.EMAIL_USER}>`,
        to: safeEmail,
        subject: 'Password Reset Request',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <h2 style="color: #667eea;">Reset Your Password</h2>
                <p>You requested to reset your password. Use the following OTP:</p>
                <div style="background: #f0f0f0; padding: 15px; text-align: center; font-size: 32px; letter-spacing: 5px; font-weight: bold; border-radius: 8px;">
                    ${safeOtp}
                </div>
                <p style="margin-top: 20px;">This OTP is valid for <strong>10 minutes</strong>.</p>
                <p>If you didn't request this, please ignore this email.</p>
            </div>
        `
    };
    
    const result = await sendEmail(mailOptions, 'password reset OTP');
    return result.success 
        ? { success: true } 
        : { success: false, error: result.error || 'Failed to send reset OTP' };
};

const sendFriendRequestEmail = async (userEmail, requesterUsername) => {
    const safeRequester = escapeHtml(requesterUsername);
    const safeEmail = userEmail;
    
    const mailOptions = {
        from: `"Sarveik" <${process.env.EMAIL_USER}>`,
        to: safeEmail,
        subject: 'New Friend Request on Sarveik',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <h2 style="color: #667eea;">New Friend Request!</h2>
                <p>Hello,</p>
                <p><strong>${safeRequester}</strong> has sent you a friend request.</p>
                <p>Log in to your account to accept or decline: <a href="https://yourdomain.com/friends.html">Sarveik Friends</a></p>
            </div>
        `
    };
    
    const result = await sendEmail(mailOptions, 'friend request email');
    return { success: result.success, error: result.error };
};

const sendWeeklyDigest = async (userEmail, username, newToolsCount, pendingRequestsCount, unreadMessagesCount) => {
    const safeUsername = escapeHtml(username);
    const safeNewTools = escapeHtml(String(newToolsCount));
    const safePending = escapeHtml(String(pendingRequestsCount));
    const safeUnread = escapeHtml(String(unreadMessagesCount));
    const safeEmail = userEmail;
    
    const mailOptions = {
        from: `"Sarveik" <${process.env.EMAIL_USER}>`,
        to: safeEmail,
        subject: 'Your Weekly Sarveik Digest',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <h2 style="color: #667eea;">Hi ${safeUsername},</h2>
                <p>Here's what happened on Sarveik this week:</p>
                <ul>
                    <li>📚 <strong>${safeNewTools}</strong> new tools added</li>
                    <li>👥 <strong>${safePending}</strong> friend requests waiting</li>
                    <li>💬 <strong>${safeUnread}</strong> unread messages</li>
                </ul>
                <p style="margin-top: 20px;"><a href="https://yourdomain.com" style="background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Visit Sarveik</a></p>
                <p style="margin-top: 20px; font-size: 12px; color: #999;">If you no longer wish to receive these emails, you can disable them in your profile settings.</p>
            </div>
        `
    };
    
    const result = await sendEmail(mailOptions, 'weekly digest');
    return { success: result.success, error: result.error };
};

const sendAccountDeletionAlert = async (deletedUser) => {
    if (!EMAIL_CONFIG.adminEmail) {
        console.warn('ADMIN_EMAIL not set, skipping account deletion alert');
        return { success: false, error: 'ADMIN_EMAIL not configured' };
    }
    
    const safeUsername = escapeHtml(deletedUser.username);
    const safeEmail = escapeHtml(deletedUser.email);
    const safeUserId = escapeHtml(String(deletedUser.id));
    
    const mailOptions = {
        from: `"Sarveik" <${process.env.EMAIL_USER}>`,
        to: EMAIL_CONFIG.adminEmail,
        subject: '⚠️ User Account Deleted',
        html: `
            <div style="font-family: Arial, sans-serif;">
                <h2 style="color: #ef4444;">Account Deleted</h2>
                <p>A user has deleted their account:</p>
                <ul>
                    <li><strong>Username:</strong> ${safeUsername}</li>
                    <li><strong>Email:</strong> ${safeEmail}</li>
                    <li><strong>User ID:</strong> ${safeUserId}</li>
                    <li><strong>Deleted at:</strong> ${escapeHtml(new Date().toLocaleString())}</li>
                </ul>
                <p>If this was not intended, please contact support.</p>
            </div>
        `
    };
    
    const result = await sendEmail(mailOptions, 'account deletion alert');
    return { success: result.success, error: result.error };
};

// ========== UTILITY EXPORTS (OPTIONAL) ==========
module.exports = {
    sendWelcomeEmail,
    sendPasswordChangeNotification,
    sendAdminAlert,
    sendOtpEmail,
    sendPasswordResetOtp,
    sendFriendRequestEmail,
    sendWeeklyDigest,
    sendAccountDeletionAlert,
    // Additional utilities for monitoring
    getEmailQueueStats: () => emailQueue.getStats(),
    isEmailServiceReady: () => transporterReady,
};