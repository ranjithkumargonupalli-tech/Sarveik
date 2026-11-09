/* Sarveik – global push setup. Put at  public/notify.js  and load it on EVERY logged-in page
   (dashboard, profile, main, tools, …):   <script src="/notify.js" defer></script>
   It does three things:
   1. registers /sw.js
   2. subscribes this device to Web Push on every page load (so notifications arrive on your phone
      even when the app is closed or you are on any page, not only Chat / Network)
   3. shows a small "Turn on notifications" bar until the user allows them (iPhone: "Add to Home Screen" hint)
   Pages that already have their own banner (#notifBanner, e.g. friends.html) are skipped for the bar. */
(function () {
  if (window.SarveikNotify) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  const perm = () => ('Notification' in window ? Notification.permission : 'unsupported');
  const HIDE_KEY = 'sarveik_notify_bar_hidden_until';

  async function csrf() {
    try { const r = await fetch('/api/csrf-token', { credentials: 'include' }); return (await r.json()).csrfToken; } catch (_) { return ''; }
  }
  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error(await r.text());
    return r;
  }
  function urlB64(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  async function loggedIn() {
    try { const r = await fetch('/check-session', { credentials: 'include' }); return !!(await r.json()).loggedIn; } catch (_) { return false; }
  }

  let reg = null;
  async function register() {
    if (!('serviceWorker' in navigator)) return null;
    try { reg = await navigator.serviceWorker.register('/sw.js'); }
    catch (_) { try { reg = await navigator.serviceWorker.getRegistration(); } catch (_) {} }
    return reg;
  }

  /* (re)register this device for the CURRENT logged-in user */
  async function subscribe() {
    try {
      if (!reg) await register();
      if (!reg || !('PushManager' in window) || perm() !== 'granted') return false;
      const k = await (await fetch('/api/push/public-key', { credentials: 'include' })).json();
      if (!k.key) return false;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(k.key) });
      await post('/api/push/subscribe', sub.toJSON());
      return true;
    } catch (e) { console.warn('Push subscribe failed:', e); return false; }
  }

  async function enable() {
    if (!('Notification' in window)) return false;
    const p = await Notification.requestPermission();
    if (p === 'granted') { const ok = await subscribe(); removeBar(); return ok; }
    return false;
  }

  /* call this right before logging out */
  async function cleanup() {
    try {
      const r = reg || (await navigator.serviceWorker.getRegistration());
      const sub = r && r.pushManager ? await r.pushManager.getSubscription() : null;
      if (sub) { try { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch (_) {} await sub.unsubscribe(); }
      if (r && r.active) r.active.postMessage({ type: 'logout' });
    } catch (_) {}
  }

  /* ---------- small prompt bar ---------- */
  let bar = null;
  function removeBar() { if (bar) { bar.remove(); bar = null; } }
  function showBar() {
    if (bar || document.getElementById('notifBanner')) return;            // page has its own banner
    if (Number(localStorage.getItem(HIDE_KEY) || 0) > Date.now()) return;
    const needInstall = isIOS && !isStandalone;
    if (!needInstall && perm() !== 'default') return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'region');
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:max(14px,env(safe-area-inset-bottom));z-index:99999;' +
      'width:min(440px,calc(100vw - 20px));display:flex;gap:10px;align-items:center;padding:12px 14px;border-radius:16px;' +
      'background:#fff;color:#12324a;border:1px solid rgba(37,211,102,.45);box-shadow:0 14px 40px rgba(10,60,50,.3);font:500 13.5px/1.4 system-ui,sans-serif';
    const text = document.createElement('div');
    text.style.flex = '1';
    text.innerHTML = needInstall
      ? '<b>Get Sarveik notifications on iPhone</b><br>Tap Share → “Add to Home Screen”, then open Sarveik from the icon.'
      : '<b>Turn on notifications</b><br>Get new messages and requests on your phone, even when the app is closed.';
    bar.appendChild(text);
    if (!needInstall) {
      const b = document.createElement('button');
      b.textContent = 'Enable';
      b.style.cssText = 'border:0;border-radius:999px;padding:9px 16px;font-weight:700;color:#fff;background:linear-gradient(135deg,#25d366,#128c7e);cursor:pointer';
      b.onclick = enable;
      bar.appendChild(b);
    }
    const x = document.createElement('button');
    x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText = 'border:0;background:none;font-size:22px;line-height:1;color:#6b8aa3;cursor:pointer';
    x.onclick = () => { localStorage.setItem(HIDE_KEY, String(Date.now() + 3 * 864e5)); removeBar(); };
    bar.appendChild(x);
    document.body.appendChild(bar);
  }

  window.SarveikNotify = { enable, subscribe, cleanup };

  (async function init() {
    await register();
    if (!(await loggedIn())) return;          // login page etc.: nothing to do
    if (perm() === 'granted') subscribe();    // keep this device registered on every page
    else showBar();
  })();
})();