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

async function requestJson<T>(path: string, timeoutMs: number): Promise<T> {
  let lastError: unknown = null;

  for (const origin of ORIGINS) {
    const url = `${origin}/${path}`;
    try {
      const response = await fetch(url, {
        headers: UPSTREAM_HEADERS,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        lastError = new UpstreamError(`${url} responded ${response.status}`);
        continue;
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        // A 403 from the CDN answers with an HTML body, never JSON.
        lastError = new UpstreamError(`${url} returned a non-JSON body`);
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new UpstreamError(
    `NBA data source unavailable for ${path}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Fetch an upstream payload, reusing a memoized copy while it is fresh and
 * de-duplicating concurrent callers.
 */
export async function fetchSource<T>(
  path: string,
  ttlSeconds: number,
  timeoutMs = 15_000,
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

  const task = requestJson<T>(path, timeoutMs)
    .then((value) => {
      cache.set(path, { expires: Date.now() + ttlSeconds * 1000, value });
      recentFailures.delete(path);
      return value;
    })
    .catch((error: unknown) => {
      recentFailures.set(path, Date.now() + FAILURE_TTL_MS);
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
