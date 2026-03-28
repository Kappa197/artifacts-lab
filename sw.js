// The Artifacts Lab — Service Worker
// Version: 1.0.0

const CACHE_NAME = 'artifacts-lab-v1';

// Core pages to cache immediately on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/login.html',
  '/tools.html',
  '/offline.html',
  '/manifest.json',
  '/retirement-calculator.html',
  '/meal-planner.html',
  '/expense-tracker.html',
  '/workout-planner.html',
  '/pregnancy-roadmap.html',
];

// ── INSTALL ──────────────────────────────────
// Cache core pages when the service worker is installed
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────
// Remove old caches when a new service worker takes over
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────
// Network-first strategy for HTML pages (always fresh content)
// Cache-first strategy for static assets (fonts, scripts)
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and external APIs
  if (request.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  // Skip Supabase and Stripe API calls — always need network
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('stripe.com')) return;
  if (url.hostname.includes('resend.com')) return;

  // Network-first for HTML pages — users always get fresh content
  if (request.headers.get('Accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache successful responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline — try cache first, then show offline page
          return caches.match(request)
            .then(cached => cached || caches.match('/offline.html'));
        })
    );
    return;
  }

  // Cache-first for everything else (fonts, CSS, JS, images)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
