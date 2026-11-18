$file = 'D:\RADHAKRIHNA\nova-platform\auth-service\server.js'
$lines = [System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8)
$content = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# ─── GUARD: skip if already patched ───────────────────────────────────────────
if ($content -match 'createNotification') {
    Write-Host "ALREADY PATCHED – skipping injection."
    exit 0
}

# ─── INJECTION 1: createNotification helper after onlineUsers declaration ─────
$notifHelper = @'


// ==================== NOTIFICATION HELPER ====================
/**
 * Persists a notification to PostgreSQL and delivers it instantly via Socket.IO.
 * Works even when the recipient is offline – they receive it on next login.
 */
async function createNotification({ recipientId, senderId = null, type, title, message,
    relatedId = null, relatedType = null, actionUrl = null, metadata = {} }) {
    if (!recipientId || !type || !title || !message) return null;
    if (recipientId === senderId) return null;
    try {
        const result = await pool.query(
            `INSERT INTO notifications
               (recipient_id, sender_id, type, title, message, related_id, related_type, action_url, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [recipientId, senderId, type, title, message, relatedId, relatedType, actionUrl, JSON.stringify(metadata)]
        );
        const notif = result.rows[0];
        if (!notif) return null;

        // Real-time push to all recipient sessions
        io.to(`user_${recipientId}`).emit('notification', {
            id:          notif.id,
            type:        notif.type,
            title:       notif.title,
            message:     notif.message,
            actionUrl:   notif.action_url,
            relatedId:   notif.related_id,
            relatedType: notif.related_type,
            createdAt:   notif.created_at,
            isRead:      false,
            metadata:    notif.metadata,
            senderUsername: (metadata && metadata.fromUsername) || null
        });

        // Update unread count badge
        const countRes = await pool.query(
            'SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',
            [recipientId]
        );
        io.to(`user_${recipientId}`).emit('notification_count', { count: parseInt(countRes.rows[0].cnt) });
        return notif;
    } catch (err) {
        if (err.code !== '42P01') console.error('[Notif] createNotification error:', err.message);
        return null;
    }
}

'@

$content = $content -replace '(const onlineUsers = new Map\(\);)', ('$1' + $notifHelper)

# ─── INJECTION 2: createNotification call after friend_request_notification emit ─
$oldFriendReq = @'
        const friendEntry = onlineUsers.get(friendId);
        if (friendEntry?.socketId) {
            io.to(friendEntry.socketId).emit('friend_request_notification', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }
'@
$newFriendReq = @'
        const friendEntry = onlineUsers.get(friendId);
        if (friendEntry?.socketId) {
            io.to(friendEntry.socketId).emit('friend_request_notification', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }

        // Persist notification so offline users receive it on next login
        createNotification({
            recipientId: friendId,
            senderId:    req.session.userId,
            type:        'friend_request',
            title:       '🔔 New Friend Request',
            message:     `${req.session.username} sent you a friend request.`,
            relatedId:   req.session.userId,
            relatedType: 'user',
            actionUrl:   '/friends.html',
            metadata:    { fromUsername: req.session.username }
        }).catch(() => {});
'@
$content = $content -replace [regex]::Escape($oldFriendReq), $newFriendReq

# ─── INJECTION 3: createNotification call after connection_accepted emit ─────
$oldAccept = @'
        if (otherUserId) {
            const otherEntry = onlineUsers.get(otherUserId);
            if (otherEntry && otherEntry.socketId) io.to(otherEntry.socketId).emit('connection_accepted', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }
        res.send('Request accepted');
'@
$newAccept = @'
        if (otherUserId) {
            const otherEntry = onlineUsers.get(otherUserId);
            if (otherEntry && otherEntry.socketId) io.to(otherEntry.socketId).emit('connection_accepted', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
            createNotification({
                recipientId: otherUserId,
                senderId:    req.session.userId,
                type:        'friend_accepted',
                title:       '🎉 Friend Request Accepted',
                message:     `${req.session.username} accepted your friend request!`,
                relatedId:   req.session.userId,
                relatedType: 'user',
                actionUrl:   '/friends.html',
                metadata:    { fromUsername: req.session.username }
            }).catch(() => {});
        }
        res.send('Request accepted');
'@
$content = $content -replace [regex]::Escape($oldAccept), $newAccept

# ─── INJECTION 4: Notification API endpoints + DB migration before module.exports ─
$notifApis = @'

// ==================== NOTIFICATIONS TABLE MIGRATION ====================
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id           SERIAL PRIMARY KEY,
                recipient_id INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                sender_id    INT  REFERENCES users(id) ON DELETE SET NULL,
                type         VARCHAR(60)  NOT NULL,
                title        VARCHAR(255) NOT NULL,
                message      TEXT NOT NULL,
                related_id   INT,
                related_type VARCHAR(60),
                action_url   VARCHAR(500),
                is_read      BOOLEAN  DEFAULT false,
                created_at   TIMESTAMP DEFAULT NOW(),
                read_at      TIMESTAMP,
                metadata     JSONB DEFAULT '{}'
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_id, is_read, created_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_unread    ON notifications(recipient_id) WHERE is_read=false`);
        // Unique constraint prevents duplicate notifications in same hour
        await pool.query(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_dedup'
                ) THEN
                    ALTER TABLE notifications
                    ADD CONSTRAINT notifications_dedup
                    UNIQUE (recipient_id, sender_id, type, related_id);
                END IF;
            END $$;
        `);
        console.log('✅ notifications table ready');
    } catch (e) { console.error('notifications migration error:', e.message); }
})();

// ==================== NOTIFICATION API ENDPOINTS ====================

// Deliver unread count on socket connect (add inside io.on connection handler indirectly via REST)
// GET /api/notifications – paginated history
app.get('/api/notifications', isAuthenticated, async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    try {
        const rows = await pool.query(
            `SELECT n.*, u.username AS sender_username, u.display_name AS sender_display_name, u.avatar_url AS sender_avatar
             FROM notifications n
             LEFT JOIN users u ON n.sender_id = u.id
             WHERE n.recipient_id = $1
             ORDER BY n.created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.session.userId, limit, offset]
        );
        const total = await pool.query(
            'SELECT COUNT(*) AS total FROM notifications WHERE recipient_id=$1',
            [req.session.userId]
        );
        res.json({ notifications: rows.rows, total: parseInt(total.rows[0].total), offset, limit });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/notifications/unread-count
app.get('/api/notifications/unread-count', isAuthenticated, async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',
            [req.session.userId]
        );
        res.json({ count: parseInt(r.rows[0].cnt) });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/notifications/:id/read – mark one as read
app.patch('/api/notifications/:id/read', isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
        await pool.query(
            'UPDATE notifications SET is_read=true, read_at=NOW() WHERE id=$1 AND recipient_id=$2',
            [id, req.session.userId]
        );
        const r = await pool.query(
            'SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',
            [req.session.userId]
        );
        const count = parseInt(r.rows[0].cnt);
        io.to(`user_${req.session.userId}`).emit('notification_count', { count });
        res.json({ success: true, count });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/notifications/read-all – mark all as read
app.patch('/api/notifications/read-all', isAuthenticated, async (req, res) => {
    try {
        await pool.query(
            'UPDATE notifications SET is_read=true, read_at=NOW() WHERE recipient_id=$1 AND is_read=false',
            [req.session.userId]
        );
        io.to(`user_${req.session.userId}`).emit('notification_count', { count: 0 });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/notifications/:id
app.delete('/api/notifications/:id', isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
        await pool.query('DELETE FROM notifications WHERE id=$1 AND recipient_id=$2', [id, req.session.userId]);
        const r = await pool.query(
            'SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',
            [req.session.userId]
        );
        const count = parseInt(r.rows[0].cnt);
        io.to(`user_${req.session.userId}`).emit('notification_count', { count });
        res.json({ success: true, count });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/notifications – clear all
app.delete('/api/notifications', isAuthenticated, async (req, res) => {
    try {
        await pool.query('DELETE FROM notifications WHERE recipient_id=$1', [req.session.userId]);
        io.to(`user_${req.session.userId}`).emit('notification_count', { count: 0 });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

'@

$content = $content -replace '(module\.exports = app;)', ($notifApis + '$1')

# ─── INJECTION 5: Deliver unread count on socket connect ─────────────────────
$oldConnectBroadcast = '        } catch (err) { console.error(''Error broadcasting online status:'', err); }
    })();

  socket.on(''private_message'''
$newConnectBroadcast = '        } catch (err) { console.error(''Error broadcasting online status:'', err); }
    })();

    // Send unread notification count on (re)connect
    (async () => {
        try {
            const r = await pool.query(
                ''SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false'',
                [userId]
            );
            socket.emit(''notification_count'', { count: parseInt(r.rows[0].cnt) });
        } catch (_) {}
    })();

  socket.on(''private_message'''

$content = $content -replace [regex]::Escape($oldConnectBroadcast), $newConnectBroadcast

[System.IO.File]::WriteAllText($file, $content, [System.Text.Encoding]::UTF8)
Write-Host "SUCCESS: server.js patched."
