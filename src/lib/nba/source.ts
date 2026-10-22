/**
 * The single place that talks to the NBA Live Data CDN.
 *
 * Two origins serve the exact same payloads. `cdn.nba.com` is the documented
 * one (PRD §25) but it rejects requests with 403 from some networks, so the
 * media-ops S3 mirror that the CDN itself reports in `meta.request` is used as
 * a transparent fallback. Responses are memoized in process so that a
 * 15-second polling loop never turns into a request storm upstream.
 */

const ORIGINS = [
  "https://cdn.nba.com/static/json",
  "https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/NBA",
] as const;

const UPSTREAM_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.nba.com/",
  Accept: "application/json, text/plain, */*",
};

/** Paths, relative to an origin. */
export const SOURCE = {
  scoreboard: "liveData/scoreboard/todaysScoreboard_00.json",
  schedule: "staticData/scheduleLeagueV2_1.json",
  boxScore: (gameId: string) => `liveData/boxscore/boxscore_${gameId}.json`,
  playByPlay: (gameId: string) => `liveData/playbyplay/playbyplay_${gameId}.json`,
} as const;

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
/**
 * Upstream is not merely flaky, it is sometimes definitively absent — a box
 * score does not exist before tip-off, and the CDN answers 403 rather than 404.
 * Remembering that for a few seconds keeps a 60s polling loop from hammering it.
 */
const recentFailures = new Map<string, number>();
const FAILURE_TTL_MS = 15_000;

export interface UpstreamResponse {
  status: number;
  text: string;
}

/**
 * How one upstream GET is performed.
 *
 * The default uses `fetch`, which is correct on the server (web build, through
 * our own API routes). The Android app swaps in the native HTTP bridge: a
 * WebView may not set the `Referer` the CDN requires, and the CDN answers with
 * no CORS headers, so a plain browser fetch is rejected before we see a byte.
 */
export type UpstreamRequester = (url: string, timeoutMs: number) => Promise<UpstreamResponse>;

const fetchRequester: UpstreamRequester = async (url, timeoutMs) => {
  const response = await fetch(url, {
    headers: UPSTREAM_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, text: await response.text() };
};

let requester: UpstreamRequester = fetchRequester;

/** Installed once by the native runtime; harmless to call again. */
export function setUpstreamRequester(next: UpstreamRequester): void {
  requester = next;
}

/** The headers the CDN expects, for a native bridge that must set them itself. */
export function upstreamHeaders(): Record<string, string> {
  return { ...UPSTREAM_HEADERS };
}

/**
 * Which origin last answered.
 *
 * `cdn.nba.com` is the documented origin, but it is not reachable from every
 * network: on some routes the TLS handshake is reset outright (measured at
 * ~5 s per attempt from this machine), on others it answers 403. Trying it
 * first and waiting for that failure, on *every* request, is most of a cold
 * start — the live feed asks for four documents before the first screen can
 * be painted. So the winner of the first race is remembered and asked first
 * from then on; when a remembered origin stops answering it is forgotten and
 * the next request races again.
 *
 * The preference lives in `localStorage` for a day on the client (a network
 * that blocks one origin today is a local condition, not a permanent fact) and
 * only in memory on the server, where a process is short-lived enough.
 */
const ORIGIN_MEMORY_KEY = "nba:origin:v1";
const ORIGIN_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
/** Rewriting localStorage on every 6-second scoreboard poll would be churn. */
const ORIGIN_REFRESH_MS = 60_000;

interface KnownOrigin {
  origin: string;
  at: number;
}

let knownOrigin: KnownOrigin | null | undefined;

function clientStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private mode / blocked storage: the in-memory copy still does its job.
    return null;
  }
}

function loadKnownOrigin(): KnownOrigin | null {
  const store = clientStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(ORIGIN_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KnownOrigin>;
    if (typeof parsed.origin !== "string" || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > ORIGIN_MEMORY_TTL_MS) return null;
    if (!ORIGINS.some((origin) => origin === parsed.origin)) return null;
    return { origin: parsed.origin, at: parsed.at };
  } catch {
    return null;
  }
}

function currentKnownOrigin(): KnownOrigin | null {
  if (knownOrigin === undefined) knownOrigin = loadKnownOrigin();
  return knownOrigin;
}

function forgetKnownOrigin(): void {
  knownOrigin = null;
  const store = clientStorage();
  if (!store) return;
  try {
    store.removeItem(ORIGIN_MEMORY_KEY);
  } catch {
    // Storage refused the write; the in-memory reset already took effect.
  }
}

function rememberOrigin(url: string): void {
  const origin = ORIGINS.find((candidate) => url.startsWith(`${candidate}/`));
  if (!origin) return;
  const now = Date.now();
  const previous = currentKnownOrigin();
  if (previous && previous.origin === origin && now - previous.at < ORIGIN_REFRESH_MS) return;
  knownOrigin = { origin, at: now };
  const store = clientStorage();
  if (!store) return;
  try {
    store.setItem(ORIGIN_MEMORY_KEY, JSON.stringify(knownOrigin));
  } catch {
    // A full or read-only storage must not break fetching.
  }
}

/** The remembered origin first, the rest in their declared order. */
function orderOrigins(urls: readonly string[]): readonly string[] {
  const known = currentKnownOrigin();
  if (!known) return urls;
  const preferred = urls.filter((url) => url.startsWith(`${known.origin}/`));
  if (preferred.length === 0) return urls;
  return [...preferred, ...urls.filter((url) => !url.startsWith(`${known.origin}/`))];
}

/** One origin, one attempt. Throws on HTTP failure, bad JSON or bad shape. */
async function attemptOrigin<T>(
  url: string,
  timeoutMs: number,
  isValid?: (value: unknown) => boolean,
): Promise<T> {
  const { status, text } = await requester(url, timeoutMs);

  if (status < 200 || status >= 300) {
    throw new UpstreamError(`${url} responded ${status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A 403 from the CDN answers with an HTML body, never JSON.
    throw new UpstreamError(`${url} returned a non-JSON body`);
  }

  // A structurally wrong payload is a failed read, not an empty season.
  // Falling through to the next origin keeps the last-good copy in play.
  if (isValid && !isValid(parsed)) {
    throw new UpstreamError(`${url} returned an unexpected structure`);
  }

  return parsed as T;
}

/**
 * Ask every origin at once and keep the first valid answer.
 *
 * Used only until an origin has been remembered: afterwards the preference is
 * tried first and the alternative is kept as a fallback. Racing is what makes
 * a blocked `cdn.nba.com` cost one connection attempt instead of a full
 * timeout on top of every document the app needs.
 */
function firstValidOrigin<T>(
  urls: readonly string[],
  timeoutMs: number,
  isValid?: (value: unknown) => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let remaining = urls.length;
    let lastError: unknown = null;

    for (const url of urls) {
      void attemptOrigin<T>(url, timeoutMs, isValid).then(
        (value) => {
          if (settled) return;
          settled = true;
          rememberOrigin(url);
          resolve(value);
        },
        (error: unknown) => {
          lastError = error;
          remaining -= 1;
          if (!settled && remaining === 0) {
            settled = true;
            reject(lastError);
          }
        },
      );
    }
  });
}


async function requestJson<T>(
  urls: readonly string[],
  timeoutMs: number,
  isValid?: (value: unknown) => boolean,
): Promise<T> {
  if (urls.length === 0) throw new UpstreamError("no source origin configured");

  // No origin remembered yet: race. Whichever answers first wins, and the
  // choice is remembered so the rest of this run costs one connection.
  if (!currentKnownOrigin() && urls.length > 1) {
    try {
      return await firstValidOrigin<T>(urls, timeoutMs, isValid);
    } catch (error) {
      throw new UpstreamError(
        `NBA data source unavailable for ${urls[0]}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  let lastError: unknown = null;

  for (const url of orderOrigins(urls)) {
    try {
      const value = await attemptOrigin<T>(url, timeoutMs, isValid);
      rememberOrigin(url);
      return value;
    } catch (error) {
      lastError = error;
      const known = currentKnownOrigin();
      if (known && url.startsWith(`${known.origin}/`)) {
        // The remembered origin stopped answering; let the next request race
        // instead of leaning on a dead preference for the rest of the day.
        forgetKnownOrigin();
      }
    }
  }

  throw new UpstreamError(
    `NBA data source unavailable for ${urls[0]}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Remember a failure briefly so a polling loop does not hammer a source that
 * is definitively absent. Entries are pruned once expired: the map is keyed by
 * path (which includes game ids), so it would otherwise grow for the life of
 * the process.
 */
function rememberFailure(path: string): void {
  const now = Date.now();
  if (recentFailures.size > 64) {
    for (const [key, expiry] of recentFailures) {
      if (expiry <= now) recentFailures.delete(key);
    }
  }
  recentFailures.set(path, now + FAILURE_TTL_MS);
}

/**
 * Fetch an upstream payload, reusing a memoized copy while it is fresh and
 * de-duplicating concurrent callers.
 */
export async function fetchSource<T>(
  path: string,
  ttlSeconds: number,
  timeoutMs = 15_000,
  isValid?: (value: unknown) => boolean,
): Promise<T> {
  return fetchSourceUrls(path, ORIGINS.map((origin) => `${origin}/${path}`), ttlSeconds, timeoutMs, isValid);
}

/** Alternate published feeds share the same native transport and bounded cache. */
export async function fetchSourceUrls<T>(
  path: string,
  urls: readonly string[],
  ttlSeconds: number,
  timeoutMs = 15_000,
  isValid?: (value: unknown) => boolean,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && hit.expires > now) {
    return hit.value as T;
  }

  if ((recentFailures.get(path) ?? 0) > now) {
    throw new UpstreamError(`${path} is unavailable (recent failure)`);
  }

  const pending = inflight.get(path);
  if (pending) {
    return pending as Promise<T>;
  }

  const task = requestJson<T>(urls, timeoutMs, isValid)
    .then((value) => {
      cache.set(path, { expires: Date.now() + ttlSeconds * 1000, value });
      recentFailures.delete(path);
      return value;
    })
    .catch((error: unknown) => {
      rememberFailure(path);
      throw error;
    })
    .finally(() => {
      inflight.delete(path);
    });

  inflight.set(path, task);
  return task;
}

/**
 * Extend the lifetime of an already memoized payload. A final box score never
 * changes again, so it can be kept far longer than a live one.
 */
export function primeSource(path: string, ttlSeconds: number): void {
  const hit = cache.get(path);
  if (hit) {
    cache.set(path, { expires: Date.now() + ttlSeconds * 1000, value: hit.value });
  }
}
