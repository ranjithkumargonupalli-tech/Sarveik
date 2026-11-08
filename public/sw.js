/* Sarveik Chat service worker
   - Background/mobile push notifications (needs a Web Push server with VAPID)
   - Skips duplicate alerts when the chat is already open and visible
   - Opens the exact chat (friend or group) when a notification is tapped
   - Fast loading + offline fallback via a small app-shell cache
   Place at the ROOT of your site so it is served as /sw.js */

const VERSION = 'v2';
const CACHE = 'sarveik-' + VERSION;
const SHELL = ['/chat.html'];
const DEFAULT_URL = '/chat.html';

/* ---------- Install / activate ---------- */
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('sarveik-') && k !== CACHE).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    await self.clients.claim();
  })());
});

/* ---------- Fetch: network-first pages, stale-while-revalidate static ---------- */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return; // never cache live data

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = (await e.preloadResponse) || (await fetch(req));
        if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
        return res;
      } catch (_) {
        return (await caches.match(req)) || (await caches.match(DEFAULT_URL)) || Response.error();
      }
    })());
    return;
  }

  if (/\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?)$/i.test(url.pathname)) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const net = fetch(req).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || net;
    })());
  }
});

/* ---------- Helpers ---------- */
function chatUrl(d) {
  if (d.url) return d.url;
  if (d.groupId) return DEFAULT_URL + '?group=' + encodeURIComponent(d.groupId);
  if (d.friendId) return DEFAULT_URL + '?friend=' + encodeURIComponent(d.friendId);
  return DEFAULT_URL;
}
function chatTag(d) {
  if (d.tag) return d.tag;
  if (d.groupId) return 'msg-g' + d.groupId;
  if (d.friendId) return 'msg-f' + d.friendId;
  return 'msg';
}
const ICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#bae6fd"/><text x="32" y="44" font-size="34" text-anchor="middle">💬</text></svg>');

/* ---------- Push ---------- */
/* Payload JSON: { title, body, friendId | groupId, url, icon, image, tag, count, timestamp } */
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; }
    catch (_) { d = { body: event.data ? event.data.text() : '' }; }

    const url = chatUrl(d), tag = chatTag(d);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // Chat already on screen: the live socket shows it, so skip the system alert (no duplicates)
    const watching = wins.some(c => c.visibilityState === 'visible' && c.focused);
    if (watching) return;

    // Replace the old notification for the same chat and keep a running count: "Ravi (3 new messages)"
    const existing = await self.registration.getNotifications({ tag });
    const prev = existing.reduce((n, x) => Math.max(n, (x.data && x.data.count) || 1), 0);
    const count = d.count || (existing.length ? prev + 1 : 1);
    const title = (d.title || 'Sarveik Chat') + (count > 1 ? ` (${count} new messages)` : '');

    const opts = {
      body: d.body || 'You have a new message',
      icon: d.icon || ICON,
      badge: d.badge || d.icon || ICON,
      image: d.image,
      tag,
      renotify: true,
      timestamp: d.timestamp || Date.now(),
      vibrate: [120, 60, 120],
      data: { url, friendId: d.friendId, groupId: d.groupId, count },
      actions: [{ action: 'open', title: 'Open' }, { action: 'dismiss', title: 'Dismiss' }]
    };
    await self.registration.showNotification(title, opts);

    if (navigator.setAppBadge) {
      const all = await self.registration.getNotifications();
      navigator.setAppBadge(all.length).catch(() => {});
    }
  })());
});

/* ---------- Notification click: focus the app and open the right chat ---------- */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const data = event.notification.data || {};
  const url = data.url || chatUrl(data);

  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const msg = { type: 'open-chat', open: url, friendId: data.friendId, groupId: data.groupId };
    for (const c of list) {
      if ('focus' in c) { await c.focus(); c.postMessage(msg); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

/* ---------- Page → SW: clear notifications of a chat once the user opens it ---------- */
self.addEventListener('message', event => {
  const m = event.data || {};
  if (m.type === 'clear-notifications') {
    event.waitUntil((async () => {
      const opts = m.tag ? { tag: m.tag } : {};
      (await self.registration.getNotifications(opts)).forEach(n => n.close());
      if (navigator.setAppBadge) {
        const left = await self.registration.getNotifications();
        left.length ? navigator.setAppBadge(left.length).catch(() => {}) : navigator.clearAppBadge().catch(() => {});
      }
    })());
  }
  if (m.type === 'skip-waiting') self.skipWaiting();
});

/* ---------- Keep the push subscription alive if the browser rotates it ---------- */
function b64u(s) {
  const p = '='.repeat((4 - s.length % 4) % 4), b = (s + p).replace(/-/g, '+').replace(/_/g, '/'), r = atob(b);
  return Uint8Array.from([...r].map(c => c.charCodeAt(0)));
}
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const { key } = await (await fetch('/api/push/public-key', { credentials: 'include' })).json();
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) });
      const { csrfToken } = await (await fetch('/api/csrf-token', { credentials: 'include' })).json();
      await fetch('/api/push/subscribe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(sub)
      });
    } catch (_) {}
  })());
});