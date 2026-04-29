// sw.js — Flookes HQ Service Worker
const CACHE    = 'flookes-hq-v1';
const PRECACHE = ['/', '/index.html', '/app.html', '/manifest.json'];

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
  // Network-first for API / dynamic calls
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('workers.dev') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('open-meteo.com')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Cache-first for static assets
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
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
  const target = 'https://family.flookesitup.com' + (e.notification.data?.url || '/app.html');
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith('https://family.flookesitup.com') && 'focus' in c) return c.focus();
      }
      return clients.openWindow(target);
    })
  );
});
