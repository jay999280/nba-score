/**
 * Service worker for the NBA scoreboard (PRD §31, v0.2).
 *
 * Deliberately boring: the app shell and immutable static assets are cached
 * for offline use, while scores always go to the network first and only fall
 * back to cache when offline. No background sync, no precached API responses
 * that could serve a stale score as if it were live.
 *
 * The one thing the fallback *must* do is announce itself. A cached score
 * replayed silently is the defect the v0.9 review found: the page said
 * "进行中 · 第4节 · 6:21" over a copy written the day before. Every cached API
 * answer therefore leaves with `X-DSH-From-Cache: 1` and the moment the copy
 * was written in `X-DSH-Cached-At`, and the app turns that into a visible
 * "离线缓存" state.
 *
 * On preferences: this worker never reads or writes `localStorage` (it cannot
 * see it at all — a service worker has no DOM), so upgrading or clearing
 * caches below cannot touch the reader's favourites. Only our own cache
 * buckets are ever deleted, which is what keeps that guarantee true.
 */

const STATIC_CACHE = "nba-static-v1";
/**
 * v2: API copies now carry their write time in `X-DSH-Cached-At`. The version
 * bump retires v1 entries, which have no timestamp and could therefore only be
 * replayed as "unknown age".
 */
const RUNTIME_CACHE = "nba-runtime-v2";
const OFFLINE_FALLBACK = "/";

/** The moment a copy was written, stored as a header on the copy itself. */
const CACHED_AT_HEADER = "X-DSH-Cached-At";
const FROM_CACHE_HEADER = "X-DSH-From-Cache";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.add(OFFLINE_FALLBACK))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Only our own buckets are swept; anything else is left alone. Reader
  // preferences live in localStorage, which a service worker cannot reach.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Store a copy that remembers when it was written.
 *
 * `content-encoding` and `content-length` are dropped from the copy: the Cache
 * API hands back a decoded body, so replaying those headers would have the
 * client decode a second time.
 */
async function storeCopy(request, response) {
  const body = await response.blob();
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, new Date().toISOString());
  headers.delete("content-encoding");
  headers.delete("content-length");
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
}

/** Re-serve a cached copy, explicitly marked as a copy. */
async function markedFromCache(request) {
  const hit = await caches.match(request);
  if (!hit) return null;

  const headers = new Headers(hit.headers);
  headers.set(FROM_CACHE_HEADER, "1");
  const cachedAt = hit.headers.get(CACHED_AT_HEADER);
  if (cachedAt) headers.set(CACHED_AT_HEADER, cachedAt);
  else headers.delete(CACHED_AT_HEADER);
  headers.delete("content-encoding");
  headers.delete("content-length");

  const body = await hit.blob();
  return new Response(body, { status: hit.status, statusText: hit.statusText, headers });
}

/** Offline: the last copy if there is one, otherwise an honest failure. */
async function offlineAnswer(request) {
  const cached = await markedFromCache(request);
  if (cached) return cached;
  return new Response(JSON.stringify({ error: "offline", fromCache: true }), {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "Content-Type": "application/json", [FROM_CACHE_HEADER]: "1" },
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: fresh deploys must win; cache is only the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((hit) => hit || caches.match(OFFLINE_FALLBACK)),
        ),
    );
    return;
  }

  // Scores and game data: network first, stale cache only when offline.
  if (url.pathname.startsWith("/api/")) {
    // Push status describes *this* subscription right now. A replayed copy
    // would be a lie about a device permission, so these never enter a cache.
    if (url.pathname.startsWith("/api/push/")) return;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) event.waitUntil(storeCopy(request, response.clone()));
          return response;
        })
        .catch(() => offlineAnswer(request)),
    );
    return;
  }

  // Hashed static assets, icons, proxied logos: cache first.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A push without JSON is still worth showing.
  }
  const title = data.title || "NBA 比分";
  const body = data.body || "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.gameId ? `/game?id=${data.gameId}` : "/" },
      tag: data.gameId ? `game-${data.gameId}-${data.kind || "update"}` : "nba-score",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (new URL(client.url).pathname === url.split("?")[0] && "focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
        return undefined;
      }),
  );
});
