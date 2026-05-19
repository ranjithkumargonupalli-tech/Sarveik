// utils/emailService.js - Resend version (drop-in replacement)
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

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

// ========== CORE SEND FUNCTION (using Resend) ==========
const sendEmail = async (to, subject, html) => {
    if (!process.env.RESEND_API_KEY) {
        console.error('❌ RESEND_API_KEY missing. Emails will not be sent.');
        return { success: false, error: 'Email service not configured' };
    }
    const from = process.env.EMAIL_FROM || 'Acme <onboarding@resend.dev>';
    try {
        const { data, error } = await resend.emails.send({
            from,
            to: [to],
            subject,
            html,
        });
        if (error) throw error;
        console.log(`📧 Email sent to ${to} [${data?.id}]`);
        return { success: true, messageId: data?.id };
    } catch (err) {
        console.error('Resend error:', err);
        return { success: false, error: err.message };
    }
};

// ========== EXPORTED FUNCTIONS (exactly as original) ==========

const sendWelcomeEmail = async (userEmail, username) => {
    const safeUsername = escapeHtml(username);
    const html = `
        <div style="font-family: Arial, sans-serif;">
            <h1 style="color: #667eea;">Welcome, ${safeUsername}!</h1>
            <p>Thank you for registering. We're excited to have you on board!</p>
            <p><small>If you didn't create this account, please contact support.</small></p>
        </div>
    `;
    return sendEmail(userEmail, 'Welcome to Our Platform! 🎉', html);
};

const sendPasswordChangeNotification = async (userEmail, username) => {
    const safeUsername = escapeHtml(username);
    const html = `
        <div style="font-family: Arial, sans-serif;">
            <h2 style="color: #dc3545;">Password Changed</h2>
            <p>Hello ${safeUsername},</p>
            <p>Your password was successfully changed on ${escapeHtml(new Date().toLocaleString())}.</p>
            <p>If you did not make this change, please reset your password immediately.</p>
        </div>
    `;
    return sendEmail(userEmail, 'Your Password Was Changed', html);
};

const sendAdminAlert = async (newUser) => {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
        console.warn('ADMIN_EMAIL not set, skipping admin alert');
        return { success: false, error: 'ADMIN_EMAIL not configured' };
    }
    const safeUsername = escapeHtml(newUser.username);
    const safeEmail = escapeHtml(newUser.email);
    const html = `
        <h3>New user registered:</h3>
        <ul>
            <li>Username: ${safeUsername}</li>
            <li>Email: ${safeEmail}</li>
            <li>Time: ${escapeHtml(new Date().toLocaleString())}</li>
        </ul>
    `;
    return sendEmail(adminEmail, '🔔 New User Registered', html);
};

const sendOtpEmail = async (userEmail, otp) => {
    const safeOtp = escapeHtml(String(otp));
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #667eea;">Email Verification</h2>
            <p style="font-size: 16px;">Your One-Time Password (OTP) is:</p>
            <div style="background: #f0f0f0; padding: 15px; text-align: center; font-size: 32px; letter-spacing: 5px; font-weight: bold; border-radius: 8px;">
                ${safeOtp}
            </div>
            <p style="margin-top: 20px;">This OTP is valid for <strong>10 minutes</strong>.</p>
            <p>If you didn't request this, please ignore this email.</p>
        </div>
    `;
    return sendEmail(userEmail, 'Your OTP for Registration', html);
};

const sendPasswordResetOtp = async (userEmail, otp) => {
    const safeOtp = escapeHtml(String(otp));
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #667eea;">Reset Your Password</h2>
            <p>You requested to reset your password. Use the following OTP:</p>
            <div style="background: #f0f0f0; padding: 15px; text-align: center; font-size: 32px; letter-spacing: 5px; font-weight: bold; border-radius: 8px;">
                ${safeOtp}
            </div>
            <p style="margin-top: 20px;">This OTP is valid for <strong>10 minutes</strong>.</p>
            <p>If you didn't request this, please ignore this email.</p>
        </div>
    `;
    return sendEmail(userEmail, 'Password Reset Request', html);
};

const sendFriendRequestEmail = async (userEmail, requesterUsername) => {
    const safeRequester = escapeHtml(requesterUsername);
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #667eea;">New Friend Request!</h2>
            <p><strong>${safeRequester}</strong> has sent you a friend request.</p>
            <p>Log in to your account to accept or decline: <a href="https://sarveik-production.up.railway.app/friends.html">Nova Friends</a></p>
        </div>
    `;
    return sendEmail(userEmail, 'New Friend Request on Nova Platform', html);
};

const sendWeeklyDigest = async (userEmail, username, newToolsCount, pendingRequestsCount, unreadMessagesCount) => {
    const safeUsername = escapeHtml(username);
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <h2 style="color: #667eea;">Hi ${safeUsername},</h2>
            <p>Here's what happened on Nova this week:</p>
            <ul>
                <li>📚 <strong>${escapeHtml(String(newToolsCount))}</strong> new tools added</li>
                <li>👥 <strong>${escapeHtml(String(pendingRequestsCount))}</strong> friend requests waiting</li>
                <li>💬 <strong>${escapeHtml(String(unreadMessagesCount))}</strong> unread messages</li>
            </ul>
            <p style="margin-top: 20px;"><a href="https://sarveik-production.up.railway.app" style="background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Visit Nova</a></p>
            <p style="margin-top: 20px; font-size: 12px; color: #999;">If you no longer wish to receive these emails, you can disable them in your profile settings.</p>
        </div>
    `;
    return sendEmail(userEmail, 'Your Weekly Nova Digest', html);
};

const sendAccountDeletionAlert = async (deletedUser) => {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
        console.warn('ADMIN_EMAIL not set, skipping account deletion alert');
        return { success: false, error: 'ADMIN_EMAIL not configured' };
    }
    const safeUsername = escapeHtml(deletedUser.username);
    const safeEmail = escapeHtml(deletedUser.email);
    const safeUserId = escapeHtml(String(deletedUser.id));
    const html = `
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
    `;
    return sendEmail(adminEmail, '⚠️ User Account Deleted', html);
};

// ========== UTILITY EXPORTS (matching original) ==========
const getEmailQueueStats = () => ({ queueLength: 0, activeJobs: 0, totalResults: 0 });
const isEmailServiceReady = () => true;

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