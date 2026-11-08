/* Sarveik service worker — shows system notifications and opens the chat on tap.
   Place this file at the ROOT of your site (so it is served at /sw.js). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* Real background push (app fully closed) — requires a Web Push server (VAPID).
   When your server sends a push with JSON { title, body, friendId, icon }, this displays it. */
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { title: 'Sarveik', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Sarveik', {
    body: d.body || 'You have a new message',
    icon: d.icon, badge: d.icon,
    tag: d.friendId ? 'msg-' + d.friendId : undefined,
    renotify: true,
    vibrate: [120, 60, 120],
    data: { friendId: d.friendId }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const friendId = event.notification.data && event.notification.data.friendId;
  const url = friendId ? '/chat.html?friend=' + friendId : '/friends.html';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ('focus' in c) { c.focus(); c.postMessage({ type: 'open-chat', friendId }); return; }
    }
    return self.clients.openWindow(url);
  }));
});