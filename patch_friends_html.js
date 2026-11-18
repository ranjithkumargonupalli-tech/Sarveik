const fs = require('fs');
const file = 'D:\\RADHAKRIHNA\\nova-platform\\auth-service\\public\\friends.html';
let content = fs.readFileSync(file, 'utf8');

// 1. In notify(): add SarveikNative hook if not present
if (!content.includes('window.SarveikNative.showNotification')) {
  const target = `  const href = groupId ? 'chat.html?group=' + groupId : friendId ? 'chat.html?friend=' + friendId : null;
  playTone(); buzz();`;
  const replacement = `  const href = groupId ? 'chat.html?group=' + groupId : friendId ? 'chat.html?friend=' + friendId : null;
  playTone(); buzz();
  try {
    if (window.SarveikNative && typeof window.SarveikNative.showNotification === 'function') {
      window.SarveikNative.showNotification(title, body, href || 'friends.html');
    }
  } catch(e) {}`;
  if (content.includes(target)) {
    content = content.replace(target, replacement);
    console.log('✅ Added SarveikNative bridge call to notify() in friends.html');
  } else {
    console.warn('⚠️ Target for notify() hook not found directly, checking variations');
  }
}

// 2. Add socket.on('notification') listener if not present
if (!content.includes("socket.on('notification'")) {
  const target = `socket.on('friend_request_notification', data => {`;
  const addition = `socket.on('notification', data => {
  if (!data) return;
  notify({
    key: 'notif-' + (data.id || Date.now()),
    title: data.title || '🔔 Notification',
    body: data.message || '',
    kind: data.type || 'info',
    href: data.actionUrl || 'friends.html'
  });
  if (typeof loadStats === 'function') loadStats();
});
socket.on('friend_request_notification', data => {`;
  if (content.includes(target)) {
    content = content.replace(target, addition);
    console.log("✅ Added socket.on('notification') handler in friends.html");
  } else {
    console.warn("⚠️ Target for socket.on('notification') not found");
  }
}

fs.writeFileSync(file, content, 'utf8');
console.log('🎉 friends.html updated!');
