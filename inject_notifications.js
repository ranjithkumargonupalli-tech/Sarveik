const fs = require('fs');
const path = require('path');

const file  = path.join(__dirname, 'server.js');
const tmpFile = path.join(__dirname, 'server.js.tmp');
let content = fs.readFileSync(file, 'utf8');

if (content.includes('createNotification')) {
    console.log('ALREADY PATCHED – nothing to do.');
    process.exit(0);
}

// ══════════════════════════════════════════
// PATCH 1 – createNotification helper
// ══════════════════════════════════════════
const helperCode = `

// ==================== REAL-TIME NOTIFICATION HELPER ====================
async function createNotification({ recipientId, senderId, type, title, message,
    relatedId, relatedType, actionUrl, metadata }) {
    senderId    = senderId    || null;
    relatedId   = relatedId   || null;
    relatedType = relatedType || null;
    actionUrl   = actionUrl   || null;
    metadata    = metadata    || {};
    if (!recipientId || !type || !title || !message) return null;
    if (recipientId === senderId) return null;
    try {
        const result = await pool.query(
            \`INSERT INTO notifications
               (recipient_id,sender_id,type,title,message,related_id,related_type,action_url,metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT DO NOTHING RETURNING *\`,
            [recipientId,senderId,type,title,message,relatedId,relatedType,actionUrl,JSON.stringify(metadata)]
        );
        const notif = result.rows[0];
        if (!notif) return null;
        io.to(\`user_\${recipientId}\`).emit('notification', {
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
        const cr = await pool.query(
            'SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',
            [recipientId]
        );
        io.to(\`user_\${recipientId}\`).emit('notification_count', { count: parseInt(cr.rows[0].cnt) });
        return notif;
    } catch (err) {
        if (err.code !== '42P01') console.error('[Notif]', err.message);
        return null;
    }
}
`;

content = content.replace('const onlineUsers = new Map();',
    'const onlineUsers = new Map();' + helperCode);
console.log('✅ PATCH 1 – createNotification helper injected');

// ══════════════════════════════════════════
// PATCH 2 – friend request notification
// ══════════════════════════════════════════
const p2old = `        const friendEntry = onlineUsers.get(friendId);
        if (friendEntry?.socketId) {
            io.to(friendEntry.socketId).emit('friend_request_notification', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }
 
        await updateQuestProgress`;

const p2new = `        const friendEntry = onlineUsers.get(friendId);
        if (friendEntry?.socketId) {
            io.to(friendEntry.socketId).emit('friend_request_notification', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }

        createNotification({
            recipientId: friendId,
            senderId:    req.session.userId,
            type:        'friend_request',
            title:       '\\uD83D\\uDD14 New Friend Request',
            message:     req.session.username + ' sent you a friend request.',
            relatedId:   req.session.userId,
            relatedType: 'user',
            actionUrl:   '/friends.html',
            metadata:    { fromUsername: req.session.username }
        }).catch(()=>{});

        await updateQuestProgress`;

if (content.includes(p2old)) {
    content = content.replace(p2old, p2new);
    console.log('✅ PATCH 2 – friend_request createNotification applied');
} else {
    console.warn('⚠️  PATCH 2 – string not matched, trying alternate...');
    // Try without the \r
    const p2oldAlt = "        const friendEntry = onlineUsers.get(friendId);\n        if (friendEntry?.socketId) {\n            io.to(friendEntry.socketId).emit('friend_request_notification', {\n                from: req.session.userId,\n                fromUsername: req.session.username\n            });\n        }\n\n        await updateQuestProgress";
    if (content.includes(p2oldAlt)) {
        content = content.replace(p2oldAlt, p2new.replace(' \n\n        await', '\n\n        await'));
        console.log('✅ PATCH 2 alternate applied');
    } else {
        console.error('❌ PATCH 2 FAILED – manual edit required at line ~4531');
    }
}

// ══════════════════════════════════════════
// PATCH 3 – connection accepted notification
// ══════════════════════════════════════════
const p3old = `            if (otherEntry && otherEntry.socketId) io.to(otherEntry.socketId).emit('connection_accepted', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
        }
        res.send('Request accepted');`;

const p3new = `            if (otherEntry && otherEntry.socketId) io.to(otherEntry.socketId).emit('connection_accepted', {
                from: req.session.userId,
                fromUsername: req.session.username
            });
            createNotification({
                recipientId: otherUserId,
                senderId:    req.session.userId,
                type:        'friend_accepted',
                title:       '\\uD83C\\uDF89 Friend Request Accepted',
                message:     req.session.username + ' accepted your friend request!',
                relatedId:   req.session.userId,
                relatedType: 'user',
                actionUrl:   '/friends.html',
                metadata:    { fromUsername: req.session.username }
            }).catch(()=>{});
        }
        res.send('Request accepted');`;

if (content.includes(p3old)) {
    content = content.replace(p3old, p3new);
    console.log('✅ PATCH 3 – friend_accepted createNotification applied');
} else {
    console.error('❌ PATCH 3 FAILED – manual edit required near connection_accepted emit');
}

// ══════════════════════════════════════════
// PATCH 4 – send unread count on reconnect
// ══════════════════════════════════════════
const p4old = `        } catch (err) { console.error('Error broadcasting online status:', err); }
    })();

  socket.on('private_message'`;

const p4new = `        } catch (err) { console.error('Error broadcasting online status:', err); }
    })();

    // Push pending notification count immediately on (re)connect
    (async () => {
        try {
            const r = await pool.query(
                'SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',
                [userId]
            );
            socket.emit('notification_count', { count: parseInt(r.rows[0].cnt) });
        } catch (_) {}
    })();

  socket.on('private_message'`;

if (content.includes(p4old)) {
    content = content.replace(p4old, p4new);
    console.log('✅ PATCH 4 – unread count on reconnect applied');
} else {
    console.error('❌ PATCH 4 FAILED – socket connect block changed');
}

// ══════════════════════════════════════════
// PATCH 5 – DB migration + REST API
// ══════════════════════════════════════════
const apiCode = `
// ==================== NOTIFICATIONS DB MIGRATION ====================
(async () => {
    try {
        await pool.query(\`
            CREATE TABLE IF NOT EXISTS notifications (
                id           SERIAL PRIMARY KEY,
                recipient_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                sender_id    INT REFERENCES users(id) ON DELETE SET NULL,
                type         VARCHAR(60) NOT NULL,
                title        VARCHAR(255) NOT NULL,
                message      TEXT NOT NULL,
                related_id   INT,
                related_type VARCHAR(60),
                action_url   VARCHAR(500),
                is_read      BOOLEAN DEFAULT false,
                created_at   TIMESTAMP DEFAULT NOW(),
                read_at      TIMESTAMP,
                metadata     JSONB DEFAULT '{}'
            )
        \`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_notif_recip  ON notifications(recipient_id,is_read,created_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(recipient_id) WHERE is_read=false');
        console.log('✅ notifications table ready');
    } catch (e) { console.error('notifications migration:', e.message); }
})();

// ---- GET /api/notifications ----
app.get('/api/notifications', isAuthenticated, async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    try {
        const rows = await pool.query(
            \`SELECT n.*, u.username AS sender_username, u.display_name AS sender_display_name, u.avatar_url AS sender_avatar
             FROM notifications n LEFT JOIN users u ON n.sender_id=u.id
             WHERE n.recipient_id=$1 ORDER BY n.created_at DESC LIMIT $2 OFFSET $3\`,
            [req.session.userId, limit, offset]
        );
        const tot = await pool.query('SELECT COUNT(*) AS t FROM notifications WHERE recipient_id=$1',[req.session.userId]);
        res.json({ notifications: rows.rows, total: parseInt(tot.rows[0].t), offset, limit });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ---- GET /api/notifications/unread-count ----
app.get('/api/notifications/unread-count', isAuthenticated, async (req, res) => {
    try {
        const r = await pool.query('SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',[req.session.userId]);
        res.json({ count: parseInt(r.rows[0].cnt) });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ---- PATCH /api/notifications/:id/read ----
app.patch('/api/notifications/:id/read', isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
        await pool.query('UPDATE notifications SET is_read=true,read_at=NOW() WHERE id=$1 AND recipient_id=$2',[id,req.session.userId]);
        const r = await pool.query('SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',[req.session.userId]);
        const count = parseInt(r.rows[0].cnt);
        io.to(\`user_\${req.session.userId}\`).emit('notification_count', { count });
        res.json({ success: true, count });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ---- PATCH /api/notifications/read-all ----
app.patch('/api/notifications/read-all', isAuthenticated, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read=true,read_at=NOW() WHERE recipient_id=$1 AND is_read=false',[req.session.userId]);
        io.to(\`user_\${req.session.userId}\`).emit('notification_count', { count: 0 });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ---- DELETE /api/notifications/:id ----
app.delete('/api/notifications/:id', isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
        await pool.query('DELETE FROM notifications WHERE id=$1 AND recipient_id=$2',[id,req.session.userId]);
        const r = await pool.query('SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',[req.session.userId]);
        const count = parseInt(r.rows[0].cnt);
        io.to(\`user_\${req.session.userId}\`).emit('notification_count', { count });
        res.json({ success: true, count });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ---- DELETE /api/notifications  (clear all) ----
app.delete('/api/notifications', isAuthenticated, async (req, res) => {
    try {
        await pool.query('DELETE FROM notifications WHERE recipient_id=$1',[req.session.userId]);
        io.to(\`user_\${req.session.userId}\`).emit('notification_count', { count: 0 });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

`;

content = content.replace('module.exports = app;', apiCode + 'module.exports = app;');
console.log('✅ PATCH 5 – DB migration + REST API injected');

// Write to tmp then rename
fs.writeFileSync(tmpFile, content, 'utf8');
fs.renameSync(tmpFile, file);
console.log('\n🎉 server.js patched successfully!');
