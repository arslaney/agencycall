// Sompo Acente Aramaları — Service Worker
const CACHE = 'acente-v1';
const SHELL = [
  '/',
  '/index.html',
  '/sompo-logo.png',
  '/header-bg.jpg',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon-32.png'
];

// Kurulumda kabuğu önbelleğe al
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// Eski önbellekleri temizle
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API çağrıları: her zaman ağdan (canlı veri), önbelleğe alma
  if (url.pathname.startsWith('/api/')) {
    return; // tarayıcı normal şekilde ağdan alsın
  }
  // Sadece GET isteklerini ele al
  if (e.request.method !== 'GET') return;
  // Statik içerik: önce ağ, başarısızsa önbellek (offline fallback)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
