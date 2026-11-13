// utils/emailService.js - Resend version (Enhanced Light Blue/Green UI)
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

// ========== HTML ESCAPING ==========
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

// ========== CORE SEND FUNCTION ==========
const sendEmail = async (to, subject, html) => {
    if (!process.env.RESEND_API_KEY) {
        console.error('❌ RESEND_API_KEY missing. Emails will not be sent.');
        return { success: false, error: 'Email service not configured' };
    }

    if (!to || !subject || !html) {
        console.error('❌ sendEmail called with missing fields:', { to, subject: !!subject, html: !!html });
        return { success: false, error: 'Missing required email fields (to, subject, html)' };
    }

    const from = process.env.EMAIL_FROM || 'Sarveik <onboarding@resend.dev>';

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

// ========== BASE TEMPLATE WRAPPER ==========
const wrapTemplate = (content) => `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3fbff; background-image: linear-gradient(135deg, #e0f2fe 0%, #d1fae5 100%); padding: 40px 20px; min-height: 100%;">
        <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 40px rgba(14, 116, 144, 0.15);">
            <!-- Header -->
            <div style="background: linear-gradient(135deg, #0ea5e9 0%, #10b981 100%); padding: 30px 40px; text-align: center;">
                <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">Sarveik</h1>
            </div>
            <!-- Content -->
            <div style="padding: 40px;">
                ${content}
            </div>
            <!-- Footer -->
            <div style="background: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
                <p style="margin: 0; font-size: 13px; color: #64748b;">&copy; ${new Date().getFullYear()} Sarveik. All rights reserved.</p>
                <p style="margin: 5px 0 0 0; font-size: 12px; color: #94a3b8;">This is an automated message, please do not reply.</p>
            </div>
        </div>
    </div>
`;

// ========== EXPORTED FUNCTIONS ==========

const sendWelcomeEmail = async (userEmail, username) => {
    if (!userEmail || !username) {
        console.error('❌ sendWelcomeEmail: missing userEmail or username');
        return { success: false, error: 'Missing fields' };
    }
    const safeUsername = escapeHtml(username);
    const frontendUrl = escapeHtml(process.env.FRONTEND_URL || 'http://localhost:3000');
    
    const content = `
        <h2 style="color: #0b2a3a; margin-top: 0; font-size: 24px; font-weight: 700;">Welcome aboard, ${safeUsername}! 🎉</h2>
        <p style="color: #3f6477; font-size: 16px; line-height: 1.6;">Thank you for registering on Sarveik. We are thrilled to have you join our community.</p>
        <p style="color: #3f6477; font-size: 16px; line-height: 1.6;">You can now explore all the AI-powered tools, connect with friends, and boost your productivity.</p>
        <div style="text-align: center; margin: 35px 0;">
            <a href="${frontendUrl}/dashboard.html" style="background: linear-gradient(135deg, #0ea5e9, #10b981); color: white; padding: 16px 32px; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 8px 20px rgba(16, 185, 129, 0.3);">
                Go to Dashboard
            </a>
        </div>
        <div style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 15px; border-radius: 8px; margin-top: 30px;">
            <p style="margin: 0; font-size: 14px; color: #047857;">If you didn't create this account, please contact our support team immediately.</p>
        </div>
    `;
    return sendEmail(userEmail, 'Welcome to Sarveik! 🎉', wrapTemplate(content));
};

const sendPasswordChangeNotification = async (userEmail, username) => {
    if (!userEmail || !username) {
        console.error('❌ sendPasswordChangeNotification: missing fields');
        return { success: false, error: 'Missing fields' };
    }
    const safeUsername = escapeHtml(username);
    const safeTime = escapeHtml(new Date().toLocaleString());
    const frontendUrl = escapeHtml(process.env.FRONTEND_URL || 'http://localhost:3000');
    
    const content = `
        <h2 style="color: #0b2a3a; margin-top: 0; font-size: 24px; font-weight: 700;">🔐 Password Changed</h2>
        <p style="color: #3f6477; font-size: 16px; line-height: 1.6;">Hello <strong>${safeUsername}</strong>,</p>
        <p style="color: #3f6477; font-size: 16px; line-height: 1.6;">Your password was successfully changed on <strong>${safeTime}</strong>.</p>
        
        <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 20px; border-radius: 8px; margin: 25px 0;">
            <p style="margin: 0; color: #991b1b; font-size: 15px; line-height: 1.5;">⚠️ If you did not make this change, please reset your password immediately and contact support to secure your account.</p>
        </div>
        
        <div style="text-align: center; margin-top: 30px;">
            <a href="${frontendUrl}/forgot-password.html" style="background: #ef4444; color: white; padding: 14px 28px; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 15px; display: inline-block;">
                Reset Password
            </a>
        </div>
    `;
    return sendEmail(userEmail, 'Your Sarveik Password Was Changed', wrapTemplate(content));
};

const sendOtpEmail = async (userEmail, otp) => {
    if (!userEmail || !otp) {
        console.error('❌ sendOtpEmail: missing userEmail or otp');
        return { success: false, error: 'Missing fields' };
    }
    const safeOtp = escapeHtml(String(otp));
    
    const content = `
        <h2 style="color: #0b2a3a; margin-top: 0; font-size: 24px; font-weight: 700; text-align: center;">Email Verification</h2>
        <p style="color: #3f6477; font-size: 16px; line-height: 1.6; text-align: center;">Your One-Time Password (OTP) for registration is:</p>
        
        <div style="background: #f0fdf4; border: 2px dashed #10b981; padding: 25px; font-size: 42px; letter-spacing: 12px; font-weight: 800; color: #047857; border-radius: 16px; margin: 30px 0; text-align: center; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.1);">
            ${safeOtp}
        </div>
        
        <p style="color: #3f6477; font-size: 15px; line-height: 1.6; text-align: center;">This OTP is valid for <strong>10 minutes</strong>.</p>
        
        <div style="background: #fffbeb; border: 1px solid #fcd34d; padding: 15px; border-radius: 8px; margin-top: 25px; text-align: center;">
            <p style="margin: 0; font-size: 14px; color: #92400e;">⚠️ Never share this OTP with anyone. Sarveik staff will never ask for it.</p>
        </div>
    `;
    return sendEmail(userEmail, 'Your Sarveik Verification Code', wrapTemplate(content));
};

const sendPasswordResetOtp = async (userEmail, otp) => {
    if (!userEmail || !otp) {
        console.error('❌ sendPasswordResetOtp: missing userEmail or otp');
        return { success: false, error: 'Missing fields' };
    }
    const safeOtp = escapeHtml(String(otp));
    
    const content = `
        <h2 style="color: #0b2a3a; margin-top: 0; font-size: 24px; font-weight: 700; text-align: center;">🔑 Reset Your Password</h2>
        <p style="color: #3f6477; font-size: 16px; line-height: 1.6; text-align: center;">We received a request to reset your password. Use the following OTP to proceed:</p>
        
        <div style="background: #eff6ff; border: 2px dashed #0ea5e9; padding: 25px; font-size: 42px; letter-spacing: 12px; font-weight: 800; color: #0369a1; border-radius: 16px; margin: 30px 0; text-align: center; box-shadow: 0 4px 15px rgba(14, 165, 233, 0.1);">
            ${safeOtp}
        </div>
        
        <p style="color: #3f6477; font-size: 15px; line-height: 1.6; text-align: center;">This OTP is valid for <strong>10 minutes</strong>.</p>
        
        <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; border-radius: 8px; margin-top: 25px;">
            <p style="margin: 0; font-size: 14px; color: #991b1b;">⚠️ If you did not request a password reset, please ignore this email or contact support if you have concerns.</p>
        </div>
    `;
    return sendEmail(userEmail, 'Sarveik Password Reset Request', wrapTemplate(content));
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
    
    const content = `
        <h2 style="color: #ef4444; margin-top: 0; font-size: 24px; font-weight: 700;">⚠️ Account Deleted</h2>
        <p style="color: #3f6477; font-size: 16px; line-height: 1.6;">A user has deleted their account. Here are the details:</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 25px 0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
            <tr style="background: #f3fbff; border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 15px; font-weight: 700; color: #0ea5e9; width: 40%;">Username</td>
                <td style="padding: 15px; color: #0b2a3a;">${safeUsername}</td>
            </tr>
            <tr style="background: #ffffff; border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 15px; font-weight: 700; color: #0ea5e9;">Email</td>
                <td style="padding: 15px; color: #0b2a3a;">${safeEmail}</td>
            </tr>
            <tr style="background: #f3fbff; border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 15px; font-weight: 700; color: #0ea5e9;">User ID</td>
                <td style="padding: 15px; color: #0b2a3a;">${safeUserId}</td>
            </tr>
            <tr style="background: #ffffff;">
                <td style="padding: 15px; font-weight: 700; color: #0ea5e9;">Deleted At</td>
                <td style="padding: 15px; color: #0b2a3a;">${escapeHtml(new Date().toLocaleString())}</td>
            </tr>
        </table>
        
        <p style="color: #64748b; font-size: 14px; text-align: center;">This is an automated notification from the Sarveik system.</p>
    `;
    return sendEmail(adminEmail, '⚠️ Sarveik: User Account Deleted', wrapTemplate(content));
};

// ========== UTILITY EXPORTS ==========
const getEmailQueueStats = () => ({ queueLength: 0, activeJobs: 0, totalResults: 0 });
const isEmailServiceReady = () => !!process.env.RESEND_API_KEY;

module.exports = {
    sendWelcomeEmail,
    sendPasswordChangeNotification,
    sendOtpEmail,
    sendPasswordResetOtp,
    sendAccountDeletionAlert,
    getEmailQueueStats,
    isEmailServiceReady,
};