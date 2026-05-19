const CACHE_NAME = 'nova-v1';
const urlsToCache = [
  '/',
  '/style.css',
  '/script.js',
  '/main.html',
  '/dashboard.html',
  '/profile.html',
  '/friends.html',
  '/chat.html',
  '/tool.html',
  '/student-mega.html',
  '/teacher-mega.html',
  // ... add other important assets
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});