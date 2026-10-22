/**
 * Service-worker cache provenance (R5).
 *
 * `public/sw.js` is a classic worker script, so it is loaded here with the two
 * globals it actually uses (`caches`, `fetch`) injected, and driven through its
 * own fetch listener. What the review found was a *silent* replay: the old
 * fallback returned the cached response untouched, so the app could not tell a
 * day-old score from a live one. These tests pin the two halves of the fix —
 * the marker on every replayed copy, and push status never entering a cache.
 *
 * Not covered here: a real browser going offline (Cache Storage semantics,
 * navigation fallbacks, SW lifecycle). The assertions below are about this
 * worker's own logic, not about Chrome's implementation of it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://example.test";

/** The subset of the Cache Storage API the worker touches. */
function fakeCaches() {
  const stores = new Map();

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  return {
    stores,
    open: async (name) => {
      const entries = store(name);
      return {
        put: async (request, response) => {
          entries.set(new Request(request).url, response);
        },
        add: async (request) => {
          entries.set(new Request(request).url, new Response("shell"));
        },
      };
    },
    match: async (request) => {
      for (const entries of stores.values()) {
        const hit = entries.get(new Request(request).url);
        if (hit) return hit.clone();
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
}

/** Load the worker with injected globals and return its fetch listener. */
function loadWorker({ caches, fetch }) {
  const listeners = new Map();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
    registration: { showNotification: async () => {} },
  };

  // The worker is a classic script, so it is evaluated with its own globals.
  new Function("self", "caches", "fetch", SOURCE)(self, caches, fetch);

  const handler = listeners.get("fetch")?.[0];
  assert.ok(handler, "sw.js registers a fetch listener");
  return handler;
}

function fetchEvent(url) {
  return {
    request: new Request(url),
    response: undefined,
    waits: [],
    respondWith(promise) {
      this.response = promise;
    },
    waitUntil(promise) {
      this.waits.push(promise);
    },
  };
}

function apiUrl(path) {
  return `${ORIGIN}${path}`;
}

test("an offline API copy is replayed with an explicit cache marker", async () => {
  const caches = fakeCaches();
  await caches.open("nba-runtime-v2");
  const entries = caches.stores.get("nba-runtime-v2");
  const writtenAt = "2026-10-09T01:14:25.142Z";
  const stored = new Response(JSON.stringify({ date: "2026-10-09", games: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-DSH-Cached-At": writtenAt },
  });
  entries.set(apiUrl("/api/games?date=2026-10-09"), stored);

  const handler = loadWorker({ caches, fetch: async () => Promise.reject(new Error("offline")) });
  const event = fetchEvent(apiUrl("/api/games?date=2026-10-09"));
  handler(event);

  const response = await event.response;
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-DSH-From-Cache"), "1", "the app must be able to tell");
  assert.equal(response.headers.get("X-DSH-Cached-At"), writtenAt, "the copy's own write time is kept");
  assert.deepEqual(await response.json(), { date: "2026-10-09", games: [] });
});

test("offline with nothing cached answers 503, still marked as cached", async () => {
  const caches = fakeCaches();
  const handler = loadWorker({ caches, fetch: async () => Promise.reject(new Error("offline")) });
  const event = fetchEvent(apiUrl("/api/games?date=2026-10-09"));
  handler(event);

  const response = await event.response;
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-DSH-From-Cache"), "1");
});

test("a network answer is stored with its write time, and the marker points at it", async () => {
  const caches = fakeCaches();
  let reachable = true;
  const handler = loadWorker({
    caches,
    fetch: async () => {
      if (!reachable) throw new Error("offline");
      return new Response(JSON.stringify({ date: "2026-10-11", games: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const url = apiUrl("/api/games?date=2026-10-11");
  const online = fetchEvent(url);
  handler(online);
  const live = await online.response;

  assert.equal(live.headers.get("X-DSH-From-Cache"), null, "a live answer carries no cache marker");

  await Promise.all(online.waits);
  const stored = await caches.match(new Request(url));
  assert.ok(stored, "the successful answer was cached");
  const writtenAt = stored.headers.get("X-DSH-Cached-At");
  assert.ok(writtenAt && !Number.isNaN(Date.parse(writtenAt)), `a real write time was recorded: ${writtenAt}`);

  // The network drops; the very same URL now comes back marked with that time.
  reachable = false;
  const offline = fetchEvent(url);
  handler(offline);
  const replayed = await offline.response;

  assert.equal(replayed.headers.get("X-DSH-From-Cache"), "1");
  assert.equal(replayed.headers.get("X-DSH-Cached-At"), writtenAt);
});

test("push status never enters a cache", async () => {
  const caches = fakeCaches();
  let fetched = 0;
  const handler = loadWorker({
    caches,
    fetch: async () => {
      fetched += 1;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const event = fetchEvent(apiUrl("/api/push/status"));
  handler(event);

  assert.equal(event.response, undefined, "the worker steps aside, so nothing is cached or replayed");
  assert.equal(event.waits.length, 0);
  assert.equal(caches.stores.size, 0);
  assert.equal(fetched, 0, "the network path is the browser's own, not the worker's");
});
