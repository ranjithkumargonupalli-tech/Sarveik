/* Sarveik Chat service worker  (v3)
   - Background / mobile push notifications (Web Push + VAPID)
   - No duplicate alerts while the chat is open, focused and visible
   - Per-chat grouping: "Ravi (3 new messages)" + app-icon badge = total unread
   - Notification actions: Open / Mark read (friend chats) / Dismiss
   - Taps open the exact chat; payload URLs are validated (same-origin only)
   - App-shell cache with offline fallback, size-capped, never caches live data
   Serve from the ROOT of the site:  /sw.js  */

const VERSION = 'v3';
const CACHE = 'sarveik-' + VERSION;
const SHELL = ['/chat.html'];
const DEFAULT_URL = '/chat.html';
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-72.png';       // optional: monochrome white-on-transparent PNG (Android status bar)
const MAX_PAGES = 30;

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0c0d14;color:#f1f3ff;font-family:system-ui,sans-serif;text-align:center">
<div><div style="font-size:3rem">📡</div><h2>You're offline</h2><p style="color:#9ba3c0">Messages will load when you're back online.</p>
<button onclick="location.reload()" style="margin-top:12px;padding:9px 20px;border:0;border-radius:10px;background:#7c6dfa;color:#fff;font-weight:600">Retry</button></div>`;

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

/* ---------- Fetch ---------- */
async function trim(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/sw.js' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // Pages: network-first (always fresh), cached copy when offline
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = (await e.preloadResponse) || (await fetch(req));
        if (res.ok && res.type === 'basic') {
          const c = await caches.open(CACHE);
          await c.put(req, res.clone());
          trim(c, MAX_PAGES);
        }
        return res;
      } catch (_) {
        return (await caches.match(req, { ignoreSearch: true })) || (await caches.match(DEFAULT_URL)) ||
          new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 });
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate
  if (/\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?)$/i.test(url.pathname)) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const net = fetch(req).then(res => {
        if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => cached || Response.error());
      if (cached) { e.waitUntil(net); return cached; }
      return net;
    })());
  }
});

/* ---------- Helpers ---------- */
const sameOrigin = u => { try { return new URL(u, location.origin).origin === location.origin; } catch (_) { return false; } };
function chatUrl(d) {
  if (d.url && sameOrigin(d.url)) return d.url;
  if (d.groupId) return DEFAULT_URL + '?group=' + encodeURIComponent(d.groupId);
  if (d.friendId) return DEFAULT_URL + '?friend=' + encodeURIComponent(d.friendId);
  return DEFAULT_URL;
}
function chatTag(d) {
  if (d.tag) return String(d.tag);
  if (d.groupId) return 'msg-g' + d.groupId;
  if (d.friendId) return 'msg-f' + d.friendId;
  return 'msg';
}
async function updateBadge() {
  if (!navigator.setAppBadge) return;
  try {
    const list = await self.registration.getNotifications();
    const total = list.reduce((n, x) => n + ((x.data && x.data.count) || 1), 0);
    total ? await navigator.setAppBadge(total) : await navigator.clearAppBadge();
  } catch (_) {}
}
async function csrf() {
  const r = await fetch('/api/csrf-token', { credentials: 'include' });
  return (await r.json()).csrfToken;
}
async function markRead(friendId) {
  try {
    await fetch('/api/messages/read/' + encodeURIComponent(friendId), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() }
    });
  } catch (_) {}
}

/* ---------- Push ----------
   Payload JSON: { title, body, friendId | groupId, url, icon, badge, image, tag, count, timestamp } */
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; }
    catch (_) { d = { body: event.data ? event.data.text() : '' }; }

    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!d.force && wins.some(c => c.visibilityState === 'visible' && c.focused)) return; // live socket already shows it

    const url = chatUrl(d), tag = chatTag(d);
    const existing = await self.registration.getNotifications({ tag });
    const prev = existing.reduce((n, x) => Math.max(n, (x.data && x.data.count) || 1), 0);
    const count = d.count || (existing.length ? prev + 1 : 1);
    const baseTitle = d.title || (existing[0] && existing[0].data && existing[0].data.baseTitle) || 'Sarveik Chat';

    const actions = d.groupId
      ? [{ action: 'open', title: 'Open' }, { action: 'dismiss', title: 'Dismiss' }]
      : [{ action: 'open', title: 'Open' }, { action: 'read', title: 'Mark read' }];

    await self.registration.showNotification(count > 1 ? `${baseTitle} (${count} new messages)` : baseTitle, {
      body: d.body || 'You have a new message',
      icon: d.icon || ICON,
      badge: d.badge || BADGE,
      image: d.image,
      tag, renotify: true,
      timestamp: d.timestamp || Date.now(),
      vibrate: [120, 60, 120],
      data: { url, friendId: d.friendId, groupId: d.groupId, count, baseTitle },
      actions
    });
    await updateBadge();
  })());
});

/* ---------- Click / close ---------- */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === 'dismiss') { event.waitUntil(updateBadge()); return; }
  if (event.action === 'read') { event.waitUntil((async () => { if (data.friendId) await markRead(data.friendId); await updateBadge(); })()); return; }

  const url = chatUrl(data);
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // prefer a window that is already on the chat page, then any visible one
    const target = list.find(c => c.url.includes(DEFAULT_URL)) || list.find(c => c.visibilityState === 'visible') || list[0];
    if (target && 'focus' in target) {
      await target.focus();
      target.postMessage({ type: 'open-chat', open: url, friendId: data.friendId, groupId: data.groupId });
    } else if (self.clients.openWindow) {
      await self.clients.openWindow(url);
    }
    await updateBadge();
  })());
});
self.addEventListener('notificationclose', e => e.waitUntil(updateBadge()));

/* ---------- Page → SW ---------- */
self.addEventListener('message', event => {
  const m = event.data || {};
  if (m.type === 'clear-notifications') {
    event.waitUntil((async () => {
      (await self.registration.getNotifications(m.tag ? { tag: m.tag } : {})).forEach(n => n.close());
      await updateBadge();
    })());
  }
  if (m.type === 'skip-waiting') self.skipWaiting();
});

/* ---------- Keep the push subscription alive when the browser rotates it ---------- */
function b64u(s) {
  const p = '='.repeat((4 - s.length % 4) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...r].map(c => c.charCodeAt(0)));
}
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      let key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
      if (!key) {
        const j = await (await fetch('/api/push/public-key', { credentials: 'include' })).json();
        if (!j.key) return;
        key = b64u(j.key);
      }
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/api/push/subscribe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() },
        body: JSON.stringify(sub)
      });
    } catch (_) {}
  })());
});