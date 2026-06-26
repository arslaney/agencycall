// Sompo Acente Aramaları — Service Worker (v3 — HTML her zaman taze)
const CACHE = 'acente-v3';
const SHELL = [
  '/sompo-logo.png',
  '/header-bg.jpg',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon-32.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

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
  // API: her zaman ağdan, önbelleğe alma
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;

  // HTML/sayfa istekleri ve index.html: HER ZAMAN ağdan taze (önbelleğe alma)
  const isHTML = e.request.mode === 'navigate' ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html');
  if (isHTML) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).catch(() =>
        caches.match('/sompo-logo.png').then(() => new Response(
          '<h1>Bağlantı yok</h1><p>İnternet bağlantınızı kontrol edip sayfayı yenileyin.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        ))
      )
    );
    return;
  }

  // Diğer statik dosyalar (logo, ikon): önce ağ, başarısızsa önbellek
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
