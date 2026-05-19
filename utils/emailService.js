// utils/emailService.js - Resend version (drop-in replacement) - Enhanced
const { Resend } = require('resend');

// ========== RESEND CLIENT (lazy init) ==========
let resend = null;
function getResendClient() {
    if (!resend) {
        if (!process.env.RESEND_API_KEY) {
            throw new Error('RESEND_API_KEY is not set in environment variables');
        }
        resend = new Resend(process.env.RESEND_API_KEY);
    }
    return resend;
}

// ========== HTML ESCAPING (same as original) ==========
const escapeHtml = (str) => {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

// ========== RETRY HELPER ==========
async function withRetry(fn, retries = 3, delayMs = 500) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLastAttempt = attempt === retries;
            const isRetryable = err?.statusCode >= 500 || err?.message?.includes('network');
            if (isLastAttempt || !isRetryable) throw err;
            console.warn(`📧 Retry attempt ${attempt}/${retries} after error: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        }
    }
}

// ========== CORE SEND FUNCTION (using Resend) ==========
const sendEmail = async (to, subject, html) => {
    if (!process.env.RESEND_API_KEY) {
        console.error('❌ RESEND_API_KEY missing. Emails will not be sent.');
        return { success: false, error: 'Email service not configured' };
    }

    if (!to || !subject || !html) {
        console.error('❌ sendEmail called with missing fields:', { to, subject: !!subject, html: !!html });
        return { success: false, error: 'Missing required email fields (to, subject, html)' };
    }

    const from = process.env.EMAIL_FROM || 'Acme <onboarding@resend.dev>';

    try {
        const client = getResendClient();
        const { data, error } = await withRetry(() =>
            client.emails.send({ from, to: [to], subject, html })
        );

        if (error) {
            console.error(`❌ Resend API error sending to ${to}:`, error);
            return { success: false, error: error.message || JSON.stringify(error) };
        }

        console.log(`✅ Email sent to ${to} | Subject: "${subject}" | ID: ${data?.id}`);
        return { success: true, messageId: data?.id };
    } catch (err) {
        console.error(`❌ Failed to send email to ${to} after retries:`, err.message || err);
        return { success: false, error: err.message };
    }
};

// ========== EXPORTED FUNCTIONS (exactly as original, enhanced internals) ==========

const sendWelcomeEmail = async (userEmail, username) => {
    if (!userEmail || !username) {
        console.error('❌ sendWelcomeEmail: missing userEmail or username');
        return { success: false, error: 'Missing fields' };
    }
    const safeUsername = escapeHtml(username);
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px;">
            <div style="background: white; padding: 30px; border-radius: 10px;">
                <h1 style="color: #667eea; margin-top: 0;">Welcome, ${safeUsername}! 🎉</h1>
                <p style="color: #444; font-size: 16px;">Thank you for registering. We're excited to have you on board!</p>
                <p style="color: #444;">You can now log in and explore all the features available to you.</p>
                <div style="margin: 24px 0;">
                    <a href="${escapeHtml(process.env.FRONTEND_URL || 'http://localhost:3000')}/dashboard.html"
                       style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                        Go to Dashboard
                    </a>
                </div>
                <p style="font-size: 12px; color: #999; margin-top: 20px;">If you didn't create this account, please contact support immediately.</p>
            </div>
        </div>
    `;
    return sendEmail(userEmail, 'Welcome to Our Platform! 🎉', html);
};

const sendPasswordChangeNotification = async (userEmail, username) => {
    if (!userEmail || !username) {
        console.error('❌ sendPasswordChangeNotification: missing fields');
        return { success: false, error: 'Missing fields' };
    }
    const safeUsername = escapeHtml(username);
    const safeTime = escapeHtml(new Date().toLocaleString());
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: #f4f4f4; border-radius: 12px;">
            <div style="background: white; padding: 30px; border-radius: 10px;">
                <h2 style="color: #dc3545; margin-top: 0;">🔐 Password Changed</h2>
                <p style="color: #444;">Hello <strong>${safeUsername}</strong>,</p>
                <p style="color: #444;">Your password was successfully changed on <strong>${safeTime}</strong>.</p>
                <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 0; color: #856404;">⚠️ If you did not make this change, please reset your password immediately and contact support.</p>
                </div>
                <a href="${escapeHtml(process.env.FRONTEND_URL || 'http://localhost:3000')}/forgot-password.html"
                   style="display: inline-block; background: #dc3545; color: white; padding: 10px 20px; text-decoration: none; border-radius: 8px; margin-top: 10px;">
                    Reset Password
                </a>
                <p style="font-size: 12px; color: #999; margin-top: 20px;">This is an automated security notification.</p>
            </div>
        </div>
    `;
    return sendEmail(userEmail, 'Your Password Was Changed', html);
};

const sendAdminAlert = async (newUser) => {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
        console.warn('⚠️ ADMIN_EMAIL not set, skipping admin alert');
        return { success: false, error: 'ADMIN_EMAIL not configured' };
    }
    if (!newUser) {
        console.error('❌ sendAdminAlert: missing newUser object');
        return { success: false, error: 'Missing newUser' };
    }

    // Support both { subject, message } and { username, email } shapes
    if (newUser.subject && newUser.message) {
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f4f4f4; border-radius: 10px;">
                <div style="background: white; padding: 20px; border-radius: 10px;">
                    <h2 style="color: #667eea; margin-top: 0;">🔔 Admin Alert</h2>
                    <p style="color: #444;"><strong>${escapeHtml(newUser.subject)}</strong></p>
                    <p style="color: #444;">${escapeHtml(newUser.message)}</p>
                    <p style="font-size: 12px; color: #999;">Time: ${escapeHtml(new Date().toLocaleString())}</p>
                </div>
            </div>
        `;
        return sendEmail(adminEmail, `🔔 ${escapeHtml(newUser.subject)}`, html);
    }

    const safeUsername = escapeHtml(newUser.username || 'Unknown');
    const safeEmail = escapeHtml(newUser.email || 'Unknown');
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f4f4f4; border-radius: 10px;">
            <div style="background: white; padding: 20px; border-radius: 10px;">
                <h2 style="color: #667eea; margin-top: 0;">🔔 New User Registered</h2>
                <ul style="color: #444;">
                    <li><strong>Username:</strong> ${safeUsername}</li>
                    <li><strong>Email:</strong> ${safeEmail}</li>
                    <li><strong>Time:</strong> ${escapeHtml(new Date().toLocaleString())}</li>
                </ul>
                <a href="${escapeHtml(process.env.FRONTEND_URL || 'http://localhost:3000')}/admin-dashboard.html"
                   style="display: inline-block; background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 8px;">
                    View Admin Panel
                </a>
            </div>
        </div>
    `;
    return sendEmail(adminEmail, '🔔 New User Registered', html);
};

const sendOtpEmail = async (userEmail, otp) => {
    if (!userEmail || !otp) {
        console.error('❌ sendOtpEmail: missing userEmail or otp');
        return { success: false, error: 'Missing fields' };
    }
    const safeOtp = escapeHtml(String(otp));
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px;">
            <div style="background: white; padding: 30px; border-radius: 10px; text-align: center;">
                <h2 style="color: #667eea; margin-top: 0;">Email Verification</h2>
                <p style="color: #444; font-size: 16px;">Your One-Time Password (OTP) is:</p>
                <div style="background: #f0f4ff; padding: 20px; font-size: 36px; letter-spacing: 8px; font-weight: bold; color: #667eea; border-radius: 8px; border: 2px dashed #667eea; margin: 20px 0;">
                    ${safeOtp}
                </div>
                <p style="color: #444;">This OTP is valid for <strong>10 minutes</strong>.</p>
                <div style="background: #fff3cd; padding: 12px; border-radius: 8px; margin-top: 16px;">
                    <p style="margin: 0; font-size: 13px; color: #856404;">⚠️ Never share this OTP with anyone. We will never ask for it.</p>
                </div>
                <p style="font-size: 12px; color: #999; margin-top: 20px;">If you didn't request this, please ignore this email.</p>
            </div>
        </div>
    `;
    return sendEmail(userEmail, 'Your OTP for Registration', html);
};

const sendPasswordResetOtp = async (userEmail, otp) => {
    if (!userEmail || !otp) {
        console.error('❌ sendPasswordResetOtp: missing userEmail or otp');
        return { success: false, error: 'Missing fields' };
    }
    const safeOtp = escapeHtml(String(otp));
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px;">
            <div style="background: white; padding: 30px; border-radius: 10px; text-align: center;">
                <h2 style="color: #667eea; margin-top: 0;">🔑 Reset Your Password</h2>
                <p style="color: #444; font-size: 16px;">You requested to reset your password. Use the following OTP:</p>
                <div style="background: #f0f4ff; padding: 20px; font-size: 36px; letter-spacing: 8px; font-weight: bold; color: #667eea; border-radius: 8px; border: 2px dashed #667eea; margin: 20px 0;">
                    ${safeOtp}
                </div>
                <p style="color: #444;">This OTP is valid for <strong>10 minutes</strong>.</p>
                <div style="background: #fff3cd; padding: 12px; border-radius: 8px; margin-top: 16px;">
                    <p style="margin: 0; font-size: 13px; color: #856404;">⚠️ If you did not request a password reset, please secure your account immediately.</p>
                </div>
                <p style="font-size: 12px; color: #999; margin-top: 20px;">If you didn't request this, please ignore this email.</p>
            </div>
        </div>
    `;
    return sendEmail(userEmail, 'Password Reset Request', html);
};

const sendFriendRequestEmail = async (userEmail, requesterUsername) => {
    if (!userEmail || !requesterUsername) {
        console.error('❌ sendFriendRequestEmail: missing fields');
        return { success: false, error: 'Missing fields' };
    }
    const safeRequester = escapeHtml(requesterUsername);
    const frontendUrl = escapeHtml(process.env.FRONTEND_URL || 'http://localhost:3000');
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px;">
            <div style="background: white; padding: 30px; border-radius: 10px; text-align: center;">
                <h2 style="color: #667eea; margin-top: 0;">👥 New Friend Request!</h2>
                <p style="color: #444; font-size: 16px;"><strong>${safeRequester}</strong> has sent you a friend request.</p>
                <p style="color: #666;">Log in to your account to accept or decline.</p>
                <a href="${frontendUrl}/friends.html"
                   style="display: inline-block; background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 16px;">
                    View Friend Request
                </a>
                <p style="font-size: 12px; color: #999; margin-top: 20px;">You're receiving this because someone sent you a friend request.</p>
            </div>
        </div>
    `;
    return sendEmail(userEmail, 'New Friend Request', html);
};

const sendWeeklyDigest = async (userEmail, username, newToolsCount, pendingRequestsCount, unreadMessagesCount) => {
    if (!userEmail || !username) {
        console.error('❌ sendWeeklyDigest: missing userEmail or username');
        return { success: false, error: 'Missing fields' };
    }
    const safeUsername = escapeHtml(username);
    const safeTools = escapeHtml(String(newToolsCount || 0));
    const safePending = escapeHtml(String(pendingRequestsCount || 0));
    const safeUnread = escapeHtml(String(unreadMessagesCount || 0));
    const frontendUrl = escapeHtml(process.env.FRONTEND_URL || 'http://localhost:3000');
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px;">
            <div style="background: white; padding: 30px; border-radius: 10px;">
                <h2 style="color: #667eea; margin-top: 0;">📊 Your Weekly Digest</h2>
                <p style="color: #444;">Hi <strong>${safeUsername}</strong>, here's what happened this week:</p>
                <div style="display: flex; gap: 12px; margin: 20px 0; flex-wrap: wrap;">
                    <div style="flex: 1; min-width: 140px; background: #f0f4ff; padding: 16px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 28px; font-weight: bold; color: #667eea;">${safeTools}</div>
                        <div style="color: #666; font-size: 13px; margin-top: 4px;">📚 New Tools Added</div>
                    </div>
                    <div style="flex: 1; min-width: 140px; background: #f0fff4; padding: 16px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 28px; font-weight: bold; color: #10b981;">${safePending}</div>
                        <div style="color: #666; font-size: 13px; margin-top: 4px;">👥 Friend Requests</div>
                    </div>
                    <div style="flex: 1; min-width: 140px; background: #fff5f5; padding: 16px; border-radius: 8px; text-align: center;">
                        <div style="font-size: 28px; font-weight: bold; color: #ef4444;">${safeUnread}</div>
                        <div style="color: #666; font-size: 13px; margin-top: 4px;">💬 Unread Messages</div>
                    </div>
                </div>
                <div style="text-align: center; margin-top: 24px;">
                    <a href="${frontendUrl}"
                       style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                        Visit Platform
                    </a>
                </div>
                <p style="margin-top: 24px; font-size: 12px; color: #999; text-align: center;">
                    If you no longer wish to receive these emails, you can disable them in your profile settings.
                </p>
            </div>
        </div>
    `;
    return sendEmail(userEmail, 'Your Weekly Digest 📊', html);
};

const sendAccountDeletionAlert = async (deletedUser) => {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
        console.warn('⚠️ ADMIN_EMAIL not set, skipping account deletion alert');
        return { success: false, error: 'ADMIN_EMAIL not configured' };
    }
    if (!deletedUser) {
        console.error('❌ sendAccountDeletionAlert: missing deletedUser object');
        return { success: false, error: 'Missing deletedUser' };
    }
    const safeUsername = escapeHtml(deletedUser.username || 'Unknown');
    const safeEmail = escapeHtml(deletedUser.email || 'Unknown');
    const safeUserId = escapeHtml(String(deletedUser.id || 'Unknown'));
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f4f4f4; border-radius: 12px;">
            <div style="background: white; padding: 30px; border-radius: 10px;">
                <h2 style="color: #ef4444; margin-top: 0;">⚠️ Account Deleted</h2>
                <p style="color: #444;">A user has deleted their account:</p>
                <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                    <tr style="background: #f9f9f9;">
                        <td style="padding: 10px; border: 1px solid #e0e0e0; font-weight: bold; color: #555; width: 40%;">Username</td>
                        <td style="padding: 10px; border: 1px solid #e0e0e0; color: #333;">${safeUsername}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e0e0e0; font-weight: bold; color: #555;">Email</td>
                        <td style="padding: 10px; border: 1px solid #e0e0e0; color: #333;">${safeEmail}</td>
                    </tr>
                    <tr style="background: #f9f9f9;">
                        <td style="padding: 10px; border: 1px solid #e0e0e0; font-weight: bold; color: #555;">User ID</td>
                        <td style="padding: 10px; border: 1px solid #e0e0e0; color: #333;">${safeUserId}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e0e0e0; font-weight: bold; color: #555;">Deleted At</td>
                        <td style="padding: 10px; border: 1px solid #e0e0e0; color: #333;">${escapeHtml(new Date().toLocaleString())}</td>
                    </tr>
                </table>
                <p style="color: #666; font-size: 13px;">If this was not intended, please review your admin logs.</p>
            </div>
        </div>
    `;
    return sendEmail(adminEmail, '⚠️ User Account Deleted', html);
};

// ========== UTILITY EXPORTS (matching original) ==========
const getEmailQueueStats = () => ({ queueLength: 0, activeJobs: 0, totalResults: 0 });
const isEmailServiceReady = () => !!process.env.RESEND_API_KEY;

module.exports = {
    sendWelcomeEmail,
    sendPasswordChangeNotification,
    sendAdminAlert,
    sendOtpEmail,
    sendPasswordResetOtp,
    sendFriendRequestEmail,
    sendWeeklyDigest,
    sendAccountDeletionAlert,
    getEmailQueueStats,
    isEmailServiceReady,
};