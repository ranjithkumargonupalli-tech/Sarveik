const fs = require('fs');
const file = 'D:\\RADHAKRIHNA\\nova-platform\\auth-service\\server.js';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');
let total = lines.length;
console.log('Total lines:', total);

// Guard
if (lines.some(l => l.includes('createNotification'))) {
    console.log('Patches 1&5 already applied. Checking 2,3,4...');
}

// Find exact line indices (0-based)
function findLine(pattern, startAt=0) {
    for (let i = startAt; i < lines.length; i++) {
        if (lines[i].includes(pattern)) return i;
    }
    return -1;
}

// PATCH 2: Insert createNotification BEFORE "await updateQuestProgress(req.session.userId, 'friend_request')"
// after the closing "}" of the friendEntry if-block near friend_request_notification
const p2marker = "await updateQuestProgress(req.session.userId, 'friend_request')";
const p2idx = findLine(p2marker);
console.log('PATCH 2 marker at line (0-based):', p2idx);

if (p2idx > 0 && !lines[p2idx-1].includes('createNotification')) {
    const p2insert = [
        '',
        "        // Persistent notification — offline users receive it on reconnect",
        "        createNotification({",
        "            recipientId: friendId,",
        "            senderId:    req.session.userId,",
        "            type:        'friend_request',",
        "            title:       '\\uD83D\\uDD14 New Friend Request',",
        "            message:     req.session.username + ' sent you a friend request.',",
        "            relatedId:   req.session.userId,",
        "            relatedType: 'user',",
        "            actionUrl:   '/friends.html',",
        "            metadata:    { fromUsername: req.session.username }",
        "        }).catch(()=>{});"
    ];
    lines.splice(p2idx, 0, ...p2insert);
    console.log('✅ PATCH 2 inserted at line', p2idx);
} else {
    console.log('⚠️ PATCH 2 already applied or marker not found');
}

// PATCH 3: Insert createNotification BEFORE "        }" that closes "if (otherUserId)" near connection_accepted
const p3marker = "io.to(otherEntry.socketId).emit('connection_accepted'";
const p3startIdx = findLine(p3marker);
console.log('PATCH 3 marker at line (0-based):', p3startIdx);

if (p3startIdx > 0) {
    // find the closing "        }" of the if(otherUserId) block — it's the first line with just "        }" after p3marker
    let p3closeIdx = -1;
    for (let i = p3startIdx; i < lines.length; i++) {
        if (lines[i].trimEnd() === '        }') { p3closeIdx = i; break; }
    }
    console.log('PATCH 3 closing } at line (0-based):', p3closeIdx);

    if (p3closeIdx > 0 && !lines[p3closeIdx-1].includes('createNotification')) {
        const p3insert = [
            "            createNotification({",
            "                recipientId: otherUserId,",
            "                senderId:    req.session.userId,",
            "                type:        'friend_accepted',",
            "                title:       '\\uD83C\\uDF89 Friend Request Accepted',",
            "                message:     req.session.username + ' accepted your friend request!',",
            "                relatedId:   req.session.userId,",
            "                relatedType: 'user',",
            "                actionUrl:   '/friends.html',",
            "                metadata:    { fromUsername: req.session.username }",
            "            }).catch(()=>{});"
        ];
        lines.splice(p3closeIdx, 0, ...p3insert);
        console.log('✅ PATCH 3 inserted before line', p3closeIdx);
    } else {
        console.log('⚠️ PATCH 3 already applied or close not found');
    }
}

// PATCH 4: Insert unread count delivery after "    })();" that closes the online status broadcast block
// which follows "Error broadcasting online status"
const p4marker = "Error broadcasting online status";
const p4idx = findLine(p4marker);
console.log('PATCH 4 marker at line (0-based):', p4idx);

if (p4idx > 0) {
    // The structure is:  ...catch line, then "    })();" on p4idx+1
    let p4closeIdx = -1;
    for (let i = p4idx; i < p4idx + 5; i++) {
        if (lines[i].trimEnd() === '    })();') { p4closeIdx = i; break; }
    }
    console.log('PATCH 4 closing })(); at line (0-based):', p4closeIdx);

    if (p4closeIdx > 0 && !lines[p4closeIdx+2].includes('notification_count')) {
        const p4insert = [
            '',
            "    // Push pending notification count to client on (re)connect",
            "    (async () => {",
            "        try {",
            "            const r = await pool.query(",
            "                'SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id=$1 AND is_read=false',",
            "                [userId]",
            "            );",
            "            socket.emit('notification_count', { count: parseInt(r.rows[0].cnt) });",
            "        } catch (_) {}",
            "    })();"
        ];
        lines.splice(p4closeIdx + 1, 0, ...p4insert);
        console.log('✅ PATCH 4 inserted after line', p4closeIdx);
    } else {
        console.log('⚠️ PATCH 4 already applied or structure changed');
    }
}

fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
console.log('\n🎉 Done! Total lines now:', lines.length);
