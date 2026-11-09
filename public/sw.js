// sw.js — Flookes HQ Service Worker
// Pages are network-first so a new version of the app shows up right away; the cached
// copy is only used when the phone is offline. /api/ is never cached.
const CACHE    = 'flookes-hq-v3';
const PRECACHE = ['/index.html', '/app.html', '/db.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // API calls and other sites (weather, fonts): straight to the network.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Pages and scripts: network first, cached copy when offline.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});

// ── Push notifications ────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Flookes HQ', body: 'You have a new notification.' };
  try { data = e.data.json(); } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'Flookes HQ', {
      body:               data.body || '',
      icon:               '/icon-192.png',
      badge:              '/icon-192.png',
      tag:                data.tag  || 'flookes-hq',
      data:               { url: data.url || '/app.html' },
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = self.location.origin + (e.notification.data?.url || '/app.html');
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(target);
    })
  );
});
