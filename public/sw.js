/* Sarveik Chat service worker  (v5)
   - Web Push (VAPID) notifications for background / closed-app / mobile
   - No alert while the chat is open, focused and visible
   - Per-chat stacking: "Ravi (3 new messages)" with the last 3 lines in the body; app-icon badge
   - De-duplicates the page's own notification vs the server push (same message never counts twice)
   - Actions: Open / Mark read (friend chats) / Dismiss
   - Taps open the exact chat, even if the app is on another page; payload URLs are same-origin only
   - Requests / non-chat notifications open /friends.html
   - Fast loads: precached shell + icons, query-insensitive page cache, stale-while-revalidate assets,
     CDN fonts/icons cached too (works offline), caches size-capped, live data never cached
   - 'logout' message wipes caches + notifications
   Serve from the ROOT of the site:  /sw.js  */

const VERSION = 'v5';
const CACHE = 'sarveik-' + VERSION;
const CDN_CACHE = 'sarveik-cdn-' + VERSION;
const SHELL = ['/chat.html', '/manifest.json', '/icons/icon-192.png'];
const DEFAULT_URL = '/chat.html';
const FALLBACK_URL = '/friends.html';           // used when a notification has no chat target (e.g. connection request)
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-72.png';            // monochrome white-on-transparent PNG (72x72). Create this file!
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const MAX_PAGES = 20, MAX_ASSETS = 80, MAX_CDN = 60;
const MAX_LINES = 3;                             // message lines shown in a stacked notification
const DUP_WINDOW = 8000;                         // ms: page notification + push for the same message = one

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0c0d14;color:#f1f3ff;font-family:system-ui,sans-serif;text-align:center">
<div><div style="font-size:3rem">📡</div><h2>You're offline</h2><p style="color:#9ba3c0">Messages will load when you're back online.</p>
<button onclick="location.reload()" style="margin-top:12px;padding:9px 20px;border:0;border-radius:10px;background:#7c6dfa;color:#fff;font-weight:600">Retry</button></div>`;

/* ---------- Install / activate ---------- */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // add one by one: a single 404 must not abort the whole precache
    await Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, CDN_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('sarveik-') && !keep.has(k)).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    await self.clients.claim();
  })());
});

/* ---------- Fetch ---------- */
async function trim(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}
const pageKey = url => new Request(url.origin + url.pathname);   // /chat.html?friend=3 and /chat.html share one entry

async function swr(e, req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const net = fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()).then(() => trim(cache, max)); }
    return res;
  }).catch(() => cached || Response.error());
  if (cached) { e.waitUntil(net); return cached; }
  return net;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Third-party fonts / icon CSS: cache so the UI renders instantly and offline
  if (url.origin !== location.origin) {
    if (CDN_HOSTS.includes(url.hostname)) e.respondWith(swr(e, req, CDN_CACHE, MAX_CDN));
    return;
  }
  if (url.pathname === '/sw.js' ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io/') ||
      url.pathname.startsWith('/.well-known/') ||      // never cache assetlinks.json
      url.pathname.startsWith('/uploads/') ||          // private avatars: auth-protected, never cache
      url.pathname.startsWith('/auth/')) return;

  // Pages: network-first (always fresh), cached copy when offline
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = (await e.preloadResponse) || (await fetch(req));
        // never cache redirects / login pages: a redirected response can't be replayed for navigations
        if (res.ok && res.type === 'basic' && !res.redirected) {
          const c = await caches.open(CACHE);
          await c.put(pageKey(url), res.clone());
          trim(c, MAX_PAGES);
        }
        return res;
      } catch (_) {
        return (await caches.match(pageKey(url))) || (await caches.match(DEFAULT_URL)) ||
          new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 });
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate
  if (/\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?|json)$/i.test(url.pathname)) {
    e.respondWith(swr(e, req, CACHE, MAX_ASSETS));
  }
});

/* ---------- Helpers ---------- */
const sameOrigin = u => { try { return new URL(u, location.origin).origin === location.origin; } catch (_) { return false; } };
function chatUrl(d) {
  if (d.url && sameOrigin(d.url)) return d.url;
  if (d.groupId) return DEFAULT_URL + '?group=' + encodeURIComponent(d.groupId);
  if (d.friendId) return DEFAULT_URL + '?friend=' + encodeURIComponent(d.friendId);
  return FALLBACK_URL;
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
    const r = await fetch('/api/messages/read/' + encodeURIComponent(friendId), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() }
    });
    return r.ok;
  } catch (_) { return false; }
}
const broadcast = async msg => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).forEach(c => c.postMessage(msg));

/* ---------- Push ----------
   Payload JSON: { title, body, sender, friendId | groupId, url, icon, badge, image, tag, count,
                   msgId, timestamp, silent, force }
   - groups: send "sender" so the line reads "Ravi: hello"
   - msgId: lets the worker ignore a repeated delivery of the same message */
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; }
    catch (_) { d = { body: event.data ? event.data.text() : '' }; }

    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!d.force && wins.some(c => c.visibilityState === 'visible' && c.focused)) return; // live socket already shows it

    const url = chatUrl(d), tag = chatTag(d);
    const existing = await self.registration.getNotifications({ tag });
    const prev = existing[0] && existing[0].data || {};
    const now = Date.now();

    // Same message already announced? (page notification a moment ago, or a repeated push)
    const dupOfPage = prev.src === 'page' && now - (prev.t || 0) < DUP_WINDOW;
    const dupById = d.msgId && prev.lastId === d.msgId;
    const isDup = !!(existing.length && (dupOfPage || dupById));

    const baseTitle = d.title || prev.baseTitle || 'Sarveik';
    const line = (d.sender && d.groupId ? d.sender + ': ' : '') + (d.body || 'You have a new message');
    let lines = existing.length ? (prev.lines || (prev.body ? [prev.body] : [])) : [];
    if (isDup) lines = lines.slice(0, -1);              // replace the duplicate line instead of adding one
    lines = [...lines, line].slice(-MAX_LINES);

    const prevCount = existing.length ? (prev.count || 1) : 0;
    const count = d.count || (isDup ? Math.max(prevCount, 1) : prevCount + 1);

    const actions = d.groupId
      ? [{ action: 'open', title: 'Open' }, { action: 'dismiss', title: 'Dismiss' }]
      : d.friendId
        ? [{ action: 'open', title: 'Open' }, { action: 'read', title: 'Mark read' }]
        : [{ action: 'open', title: 'Open' }, { action: 'dismiss', title: 'Dismiss' }];

    await self.registration.showNotification(count > 1 ? `${baseTitle} (${count} new messages)` : baseTitle, {
      body: count > 1 ? lines.join('\n') : line,
      icon: d.icon || ICON,
      badge: d.badge || BADGE,
      image: d.image,
      tag, renotify: !isDup,                            // a duplicate must not buzz twice
      silent: !!d.silent,
      timestamp: d.timestamp || now,
      vibrate: [120, 60, 120],
      data: { url, friendId: d.friendId, groupId: d.groupId, count, baseTitle, lines, body: line, lastId: d.msgId || null, src: 'push', t: now },
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
  if (event.action === 'read') {
    event.waitUntil((async () => {
      if (data.friendId && await markRead(data.friendId)) await broadcast({ type: 'marked-read', friendId: data.friendId });
      await updateBadge();
    })());
    return;
  }

  const url = chatUrl(data);
  const targetPath = new URL(url, location.origin).pathname;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const onTarget = list.find(c => new URL(c.url).pathname === targetPath);
    const target = onTarget || list.find(c => c.visibilityState === 'visible') || list[0];
    try {
      if (target) {
        await target.focus();
        if (onTarget && targetPath === DEFAULT_URL) target.postMessage({ type: 'open-chat', open: url, friendId: data.friendId, groupId: data.groupId });
        else if (!onTarget || targetPath !== DEFAULT_URL) {
          if ('navigate' in target) await target.navigate(url);   // app is on another page: bring it to the right one
          else if (self.clients.openWindow) await self.clients.openWindow(url);
        }
      } else if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    } catch (_) {
      if (self.clients.openWindow) await self.clients.openWindow(url).catch(() => {});
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
  if (m.type === 'logout') {
    event.waitUntil((async () => {
      (await self.registration.getNotifications()).forEach(n => n.close());
      await caches.delete(CACHE);                      // pages cached for the signed-in user
      await updateBadge();
    })());
  }
  if (m.type === 'skip-waiting') self.skipWaiting();
  if (m.type === 'get-version' && event.source) event.source.postMessage({ type: 'version', version: VERSION });
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