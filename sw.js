// Service Worker: App-Dateien offline verfügbar halten (Daten kommen immer frisch)
const CACHE = 'varroa-kalib-v7';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/core.js', 'js/ui.js', 'js/detect.js', 'js/model.js', 'js/exif.js', 'js/worker.js',
  'js/upload.js', 'js/review.js', 'js/stats.js', 'js/store-local.js', 'js/store-supabase.js',
  'seed/seed.json', 'seed/model_v1.json', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Supabase-Daten nie cachen
  if (url.hostname.endsWith('supabase.co') || url.pathname.includes('/rest/v1/') || url.pathname.includes('/storage/v1/') || url.pathname.includes('/auth/v1/')) return;
  // App-Dateien: zuerst Netz (damit Updates ankommen), sonst Cache
  if (url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request)));
  }
});
