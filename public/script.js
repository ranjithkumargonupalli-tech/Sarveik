// ==================== UTILITIES ====================
function showMessage(elementId, message, isSuccess = true) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = message;
        el.className = 'message ' + (isSuccess ? 'success' : 'error');
        el.style.display = 'block';
    }
}

function clearMessages() {
    ['loginMessage', 'otpRequestMessage', 'registerMessage', 
     'aboutMessage', 'socialMessage', 'passwordMessage', 
     '2faMessage', 'deleteMessage', 'usernameMessage'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = '';
            el.style.display = 'none';
        }
    });
}

// ==================== PASSWORD VISIBILITY TOGGLE ====================
document.addEventListener('click', function(e) {
    if (e.target.classList && e.target.classList.contains('toggle-password')) {
        const icon = e.target;
        const targetId = icon.getAttribute('data-target');
        const passwordInput = document.getElementById(targetId);
        if (passwordInput) {
            const type = passwordInput.type === 'password' ? 'text' : 'password';
            passwordInput.type = type;
            icon.classList.toggle('fa-eye');
            icon.classList.toggle('fa-eye-slash');
        }
    }
});

// ==================== SESSION CHECK ====================
async function checkSession() {
    try {
        const res = await fetch('/check-session');
        const data = await res.json();
        if (data.loggedIn) {
            fetchUserRole();
            return data;
        } else {
            const publicPages = ['index.html', 'welcome.html', 'login.html', 'signup.html', 'signup_acc.html'];
            const currentPage = window.location.pathname.split('/').pop();
            if (!publicPages.includes(currentPage) && window.location.pathname !== '/') {
                window.location.href = '/';
            }
            return null;
        }
    } catch (err) {
        console.error(err);
        return null;
    }
}

async function fetchUserRole() {
    try {
        const res = await fetch('/profile');
        if (res.ok) {
            const user = await res.json();
            if (user.role === 'admin') {
                document.getElementById('adminLink')?.classList.remove('hidden');
            }
            localStorage.setItem('userRole', user.role);
        }
    } catch (err) {
        console.error(err);
    }
}

// ==================== LOGOUT ====================
document.addEventListener('click', async (e) => {
    if (e.target.id === 'logoutBtn' || e.target.closest('#logoutBtn')) {
        e.preventDefault();
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/';
    }
});

// ==================== PROFILE PAGE FUNCTIONS ====================
async function loadProfile() {
    try {
        const res = await fetch('/profile/full');
        const user = await res.json();
        if (document.getElementById('profileUsername')) {
            document.getElementById('profileUsername').textContent = user.username;
            document.getElementById('profileEmail').value = user.email || '';
            document.getElementById('displayName').value = user.display_name || '';
            document.getElementById('bio').value = user.bio || '';
            document.getElementById('phone').value = user.phone || '';
            document.getElementById('github').value = user.github || '';
            document.getElementById('twitter').value = user.twitter || '';
            document.getElementById('linkedin').value = user.linkedin || '';
            document.getElementById('profileDisplayName').textContent = user.display_name || user.username;

            const badge = document.getElementById('emailVerifiedBadge');
            if (user.email_verified) {
                badge.className = 'badge verified';
                badge.innerHTML = '<i class="fas fa-check-circle"></i> Email Verified';
            } else {
                badge.className = 'badge unverified';
                badge.innerHTML = '<i class="fas fa-times-circle"></i> Not Verified';
            }

            if (user.avatar_url) {
                document.getElementById('avatarPreview').src = user.avatar_url;
            } else {
                document.getElementById('avatarPreview').src = 'https://via.placeholder.com/120';
            }

            const twofaBtn = document.getElementById('toggle2faBtn');
            if (twofaBtn) twofaBtn.textContent = user.two_factor_enabled ? 'Disable 2FA' : 'Enable 2FA';
        }
    } catch (err) {
        console.error('Error loading profile:', err);
    }
}

// ==================== PAGE-SPECIFIC INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed');

    // ---- COOKIE CONSENT BANNER (GDPR) ----
    if (!localStorage.getItem('cookieConsent')) {
        const banner = document.createElement('div');
        banner.id = 'cookieConsentBanner';
        banner.style.cssText = 'position:fixed; bottom:0; left:0; width:100%; background:rgba(0,0,0,0.9); color:#fff; padding:15px; text-align:center; z-index:10000;';
        banner.innerHTML = `We use cookies to enhance your experience. 
            <button id="acceptCookies" style="margin-left:15px;background:#00e6ff;color:#000;border:none;padding:5px 15px;border-radius:5px;cursor:pointer;">Accept</button>
            <a href="/privacy.html" target="_blank" style="margin-left:15px;color:#00e6ff;">Privacy Policy</a>`;
        document.body.appendChild(banner);
        document.getElementById('acceptCookies').addEventListener('click', () => {
            localStorage.setItem('cookieConsent', 'true');
            banner.remove();
        });
    }

    // ---- LOGIN FORM ----
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearMessages();

            const username = document.getElementById('loginUsername')?.value.trim();
            const password = document.getElementById('loginPassword')?.value;

            if (!username || !password) {
                showMessage('loginMessage', 'Please enter both username and password', false);
                return;
            }

            try {
                const res = await fetch('/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const text = await res.text();
                if (res.ok) {
                    showMessage('loginMessage', 'Login successful! Redirecting...', true);
                    setTimeout(() => window.location.href = '/main.html', 1000);
                } else {
                    showMessage('loginMessage', text, false);
                }
            } catch (err) {
                showMessage('loginMessage', 'Network error. Please try again.', false);
            }
        });
    }

    // ---- OTP REQUEST FORM ----
    const otpRequestForm = document.getElementById('otpRequestForm');
    if (otpRequestForm) {
        otpRequestForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearMessages();

            const email = document.getElementById('otpEmail')?.value;
            if (!email) {
                showMessage('otpRequestMessage', 'Email is required', false);
                return;
            }

            try {
                const res = await fetch('/send-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const text = await res.text();
                if (res.ok) {
                    showMessage('otpRequestMessage', 'OTP sent! Check your email.', true);
                    document.getElementById('otpRequestCard').classList.add('hidden');
                    document.getElementById('registerCard').classList.remove('hidden');
                    document.getElementById('regEmail').value = email;
                } else {
                    showMessage('otpRequestMessage', text, false);
                }
            } catch (err) {
                showMessage('otpRequestMessage', 'Network error', false);
            }
        });
    }

    // ---- REGISTER FORM (with OTP) ----
    const registerForm = document.getElementById('registerForm');
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearMessages();

            const username = document.getElementById('regUsername')?.value;
            const password = document.getElementById('regPassword')?.value;
            const otp = document.getElementById('regOtp')?.value;
            const email = document.getElementById('regEmail')?.value;

            if (!email) {
                showMessage('registerMessage', 'Email missing. Please request OTP again.', false);
                return;
            }
            if (!username || !password || !otp) {
                showMessage('registerMessage', 'All fields are required', false);
                return;
            }

            try {
                const res = await fetch('/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, email, password, otp })
                });
                const text = await res.text();
                if (res.ok) {
                    showMessage('registerMessage', 'Registration successful! Redirecting...', true);
                    setTimeout(() => window.location.href = '/main.html', 1500);
                } else {
                    showMessage('registerMessage', text, false);
                }
            } catch (err) {
                showMessage('registerMessage', 'Network error', false);
            }
        });
    }

    // ---- TOGGLE FORM LINKS (for index page) ----
    const showOtpRequest = document.getElementById('showOtpRequest');
    if (showOtpRequest) {
        showOtpRequest.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('loginCard').classList.add('hidden');
            document.getElementById('otpRequestCard').classList.remove('hidden');
            document.getElementById('otpRequestMessage').textContent = '';
        });
    }

    const backToLoginFromOtp = document.getElementById('backToLoginFromOtp');
    if (backToLoginFromOtp) {
        backToLoginFromOtp.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('otpRequestCard').classList.add('hidden');
            document.getElementById('loginCard').classList.remove('hidden');
            document.getElementById('otpRequestMessage').textContent = '';
        });
    }

    const backToOtpRequest = document.getElementById('backToOtpRequest');
    if (backToOtpRequest) {
        backToOtpRequest.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('registerCard').classList.add('hidden');
            document.getElementById('otpRequestCard').classList.remove('hidden');
            document.getElementById('registerMessage').textContent = '';
        });
    }

    const showRegister = document.getElementById('showRegister');
    if (showRegister) {
        showRegister.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('loginCard').classList.add('hidden');
            document.getElementById('registerCard').classList.remove('hidden');
        });
    }

    const showLogin = document.getElementById('showLogin');
    if (showLogin) {
        showLogin.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('registerCard').classList.add('hidden');
            document.getElementById('loginCard').classList.remove('hidden');
        });
    }

    // ---- DASHBOARD PAGE ----
    if (window.location.pathname.includes('dashboard.html')) {
        (async () => {
            const session = await checkSession();
            if (session) {
                document.getElementById('welcomeMessage').textContent = `Hello, ${session.username}!`;
            }
        })();
    }

    // ---- PROFILE PAGE ----
    if (window.location.pathname.includes('profile.html')) {
        (async () => {
            const session = await checkSession();
            if (!session) return;
            await loadProfile();

            const avatarUpload = document.getElementById('avatarUpload');
            if (avatarUpload) {
                avatarUpload.addEventListener('change', async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const formData = new FormData();
                    formData.append('avatar', file);
                    try {
                        const res = await fetch('/profile/avatar', { method: 'POST', body: formData });
                        const text = await res.text();
                        if (res.ok) {
                            showMessage('aboutMessage', 'Avatar updated successfully', true);
                            loadProfile();
                        } else {
                            showMessage('aboutMessage', text, false);
                        }
                    } catch (err) {
                        showMessage('aboutMessage', 'Upload failed', false);
                    }
                });
            }

            const aboutForm = document.getElementById('aboutForm');
            if (aboutForm) {
                aboutForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const display_name = document.getElementById('displayName').value;
                    const bio = document.getElementById('bio').value;
                    const phone = document.getElementById('phone').value;
                    const res = await fetch('/profile/update', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ display_name, bio, phone })
                    });
                    const text = await res.text();
                    showMessage('aboutMessage', text, res.ok);
                    if (res.ok) loadProfile();
                });
            }

            const socialForm = document.getElementById('socialForm');
            if (socialForm) {
                socialForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const github = document.getElementById('github').value;
                    const twitter = document.getElementById('twitter').value;
                    const linkedin = document.getElementById('linkedin').value;
                    const res = await fetch('/profile/update', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ github, twitter, linkedin })
                    });
                    const text = await res.text();
                    showMessage('socialMessage', text, res.ok);
                    if (res.ok) loadProfile();
                });
            }

            const changePasswordForm = document.getElementById('changePasswordForm');
            if (changePasswordForm) {
                changePasswordForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const currentPassword = document.getElementById('currentPassword').value;
                    const newPassword = document.getElementById('newPassword').value;
                    const res = await fetch('/profile/password', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ currentPassword, newPassword })
                    });
                    const text = await res.text();
                    showMessage('passwordMessage', text, res.ok);
                    if (res.ok) {
                        document.getElementById('currentPassword').value = '';
                        document.getElementById('newPassword').value = '';
                    }
                });
            }

            const toggle2faBtn = document.getElementById('toggle2faBtn');
            if (toggle2faBtn) {
                toggle2faBtn.addEventListener('click', async () => {
                    const res = await fetch('/profile/toggle-2fa', { method: 'POST' });
                    const text = await res.text();
                    showMessage('2faMessage', text, res.ok);
                    loadProfile();
                });
            }

            const deleteAccountBtn = document.getElementById('deleteAccountBtn');
            if (deleteAccountBtn) {
                deleteAccountBtn.addEventListener('click', async () => {
                    if (!confirm('Are you absolutely sure? This will permanently delete your account and all data.')) return;
                    const res = await fetch('/profile/delete', { method: 'DELETE' });
                    const text = await res.text();
                    if (res.ok) {
                        alert('Account deleted. You will be logged out.');
                        window.location.href = '/';
                    } else {
                        showMessage('deleteMessage', text, false);
                    }
                });
            }

            const tabBtns = document.querySelectorAll('.tab-btn');
            tabBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
                    const tabId = btn.getAttribute('data-tab');
                    if (tabId) document.getElementById('tab-' + tabId).classList.add('active');
                });
            });
        })();
    }

    // ---- ADMIN PAGE ----
    if (window.location.pathname.includes('admin.html')) {
        (async () => {
            const session = await checkSession();
            if (!session) return;
            try {
                const res = await fetch('/admin/users');
                if (!res.ok) {
                    if (res.status === 403) {
                        alert('Access denied. Admins only.');
                        window.location.href = '/dashboard.html';
                    }
                    return;
                }
                const users = await res.json();
                const tbody = document.getElementById('userTableBody');
                if (tbody) {
                    tbody.innerHTML = '';
                    users.forEach(user => {
                        const row = document.createElement('tr');
                        row.innerHTML = `
                            <td>${user.id}</td>
                            <td>${user.username}</td>
                            <td>${user.email}</td>
                            <td>${user.role}</td>
                            <td>${new Date(user.created_at).toLocaleString()}</td>
                            <td style="max-width: 200px; overflow: auto;">••••••••</td>
                            <td>
                                <button class="btn small" onclick="deleteUser(${user.id})">Delete</button>
                                <button class="btn small" onclick="banUser(${user.id})">Ban</button>
                                <button class="btn small" onclick="unbanUser(${user.id})">Unban</button>
                            </td>
                        `;
                        tbody.appendChild(row);
                    });
                }
            } catch (err) {
                console.error(err);
            }
        })();
    }

    // ---- GLOBAL DELETE USER FUNCTION (used by admin page) ----
    window.deleteUser = async (userId) => {
        if (!confirm('Are you sure you want to delete this user?')) return;
        try {
            const res = await fetch(`/admin/users/${userId}`, { method: 'DELETE' });
            const text = await res.text();
            alert(text);
            if (res.ok) location.reload();
        } catch (err) {
            alert('Error deleting user');
        }
    };

    // ==================== NEW FEATURES ADDED ====================

    // --- Data Export Button ---
    const exportDataBtn = document.getElementById('exportDataBtn');
    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', async () => {
            window.location.href = '/api/export-data';
        });
    }

    // --- User Status Selector ---
    const statusSelect = document.getElementById('statusSelect');
    if (statusSelect) {
        // Fetch current status
        fetch('/profile/full')
            .then(res => res.json())
            .then(user => {
                if (user.status) statusSelect.value = user.status;
            })
            .catch(console.error);
        statusSelect.addEventListener('change', async () => {
            const status = statusSelect.value;
            try {
                const res = await fetch('/api/update-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status }),
                    credentials: 'include'
                });
                const text = await res.text();
                if (!res.ok) showMessage('statusMessage', text, false);
                else console.log('Status updated');
            } catch (err) {
                console.error(err);
            }
        });
    }

    // --- Admin Tool Moderation Functions ---
    window.approveTool = async (toolId) => {
        if (!confirm('Approve this tool?')) return;
        try {
            const res = await fetch(`/api/admin/tools/${toolId}/approve`, { method: 'PUT', credentials: 'include' });
            const text = await res.text();
            alert(text);
            if (res.ok) location.reload();
        } catch (err) {
            alert('Error approving tool');
        }
    };

    window.rejectTool = async (toolId) => {
        if (!confirm('Reject this tool?')) return;
        try {
            const res = await fetch(`/api/admin/tools/${toolId}`, { method: 'DELETE', credentials: 'include' });
            const text = await res.text();
            alert(text);
            if (res.ok) location.reload();
        } catch (err) {
            alert('Error rejecting tool');
        }
    };

    // Load pending tools if on admin page
    if (window.location.pathname.includes('admin.html')) {
        fetch('/api/admin/tools/pending')
            .then(res => res.json())
            .then(tools => {
                const container = document.getElementById('pendingToolsContainer');
                if (container) {
                    if (tools.length === 0) {
                        container.innerHTML = '<p>No pending tools.</p>';
                    } else {
                        container.innerHTML = '<h3>Pending Tools</h3>';
                        tools.forEach(tool => {
                            const div = document.createElement('div');
                            div.className = 'tool-pending-item';
                            div.innerHTML = `
                                <strong>${tool.name}</strong> (${tool.category}) – ${tool.description}<br>
                                <a href="${tool.url}" target="_blank">${tool.url}</a><br>
                                Submitted by: ${tool.username} (ID: ${tool.user_id})<br>
                                <button onclick="approveTool(${tool.id})">Approve</button>
                                <button onclick="rejectTool(${tool.id})">Reject</button>
                            `;
                            container.appendChild(div);
                        });
                    }
                }
            })
            .catch(console.error);
    }

    // --- Ban/Unban User Functions (already defined in admin page) ---
    window.banUser = async (userId) => {
        if (!confirm('Ban this user? They will be unable to log in.')) return;
        try {
            const res = await fetch(`/api/admin/users/${userId}/ban`, { method: 'PUT', credentials: 'include' });
            const text = await res.text();
            alert(text);
            if (res.ok) location.reload();
        } catch (err) {
            alert('Error banning user');
        }
    };

    window.unbanUser = async (userId) => {
        if (!confirm('Unban this user?')) return;
        try {
            const res = await fetch(`/api/admin/users/${userId}/unban`, { method: 'PUT', credentials: 'include' });
            const text = await res.text();
            alert(text);
            if (res.ok) location.reload();
        } catch (err) {
            alert('Error unbanning user');
        }
    };

    // --- External Widgets: Weather, Quote ---
    if (document.getElementById('weatherWidget')) {
        const apiKey = 'YOUR_OPENWEATHER_API_KEY'; // Replace with your actual key
        const city = 'Mumbai'; // or detect via IP
        fetch(`https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${apiKey}`)
            .then(res => res.json())
            .then(data => {
                const weatherDiv = document.getElementById('weatherWidget');
                if (weatherDiv) {
                    weatherDiv.innerHTML = `<i class="fas fa-cloud-sun"></i> ${data.main.temp}°C, ${data.weather[0].description} in ${city}`;
                }
            })
            .catch(err => console.error('Weather error:', err));
    }

    if (document.getElementById('quoteWidget')) {
        fetch('https://api.quotable.io/random')
            .then(res => res.json())
            .then(data => {
                const quoteDiv = document.getElementById('quoteWidget');
                if (quoteDiv) {
                    quoteDiv.innerHTML = `"${data.content}" – ${data.author}`;
                }
            })
            .catch(err => {
                const quoteDiv = document.getElementById('quoteWidget');
                if (quoteDiv) quoteDiv.innerHTML = "Stay curious!";
            });
    }
});

// ==================== INITIAL SESSION CHECK FOR PROTECTED PAGES ====================
const publicPages = ['index.html', 'welcome.html', 'login.html', 'signup.html', 'signup_acc.html'];
const currentPage = window.location.pathname.split('/').pop();
if (!publicPages.includes(currentPage) && window.location.pathname !== '/') {
    checkSession().catch(console.error);
}

if (localStorage.getItem('userRole') === 'admin') {
    document.getElementById('adminLink')?.classList.remove('hidden');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('Service Worker registered'))
      .catch(err => console.log('SW registration failed:', err));
  });
}