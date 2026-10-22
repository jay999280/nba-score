import { localDayWindow } from "@/lib/format";
import { normalizeFreshness } from "@/lib/types";
import type {
  GameDetailResponse,
  GamesResponse,
  LineupsResponse,
  LineupsSection,
  PlaysResponse,
  StandingsResponse,
} from "@/lib/types";

/**
 * Where the client gets its data, which differs by build target.
 *
 * - **web**: our own API routes (`/api/*`). They exist because the NBA CDN
 *   sends no CORS headers and wants a `Referer` a browser will not set.
 * - **native** (Android app): the app runs the very same service layer that
 *   used to run on the server, inside the WebView, over the native HTTP
 *   bridge. There is no server on a phone — and therefore no domain to be
 *   blocked, which is the whole point of shipping an app.
 *
 * Both paths return the internal model, so no component knows the difference.
 */
export interface DataSource {
  readonly kind: "web" | "native";
  /** `signal` cancels an in-flight request; the native path uses its own timeouts. */
  games(dateKey: string, signal: AbortSignal): Promise<GamesResponse>;
  detail(gameId: string, signal: AbortSignal): Promise<GameDetailResponse>;
  plays(gameId: string, signal: AbortSignal): Promise<PlaysResponse>;
  /**
   * Pre-game season comparison and probable lineups. `section` narrows the
   * request so the eager comparison does not also pay for the lazy lineups;
   * omit it for the complete payload.
   */
  lineups(gameId: string, signal: AbortSignal, section?: LineupsSection): Promise<LineupsResponse>;
  standings(signal: AbortSignal): Promise<StandingsResponse>;
}

function isNativePlatform(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (
    window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

/** Markers the service worker adds to a response it served from its cache. */
const FROM_CACHE_HEADER = "X-DSH-From-Cache";
const CACHED_AT_HEADER = "X-DSH-Cached-At";

/**
 * A response that came out of the service worker's cache is not this round's
 * data, and the app must not treat it as a successful refresh. The upstream's
 * own `sourceAt` is left exactly as the server sent it — it is the one honest
 * "when was this true", and the client has no business rewriting it.
 */
function markFromCache<T>(body: T, cachedAt: string | null): T {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const previous = record.freshness;
  return {
    ...record,
    ...(Array.isArray(record.teams) ? { stale: true } : {}),
    freshness: normalizeFreshness({
      ...(typeof previous === "object" && previous !== null ? previous : {}),
      kind: "cache",
      cachedAt,
      // The network revalidation is exactly what failed.
      revalidateFailed: true,
    }),
  } as T;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  const body = (await response.json()) as T;

  // The native build never registers a service worker, so this only ever fires
  // on the web — and only when the network actually failed underneath it.
  if (response.headers.get(FROM_CACHE_HEADER) === "1") {
    return markFromCache(body, response.headers.get(CACHED_AT_HEADER));
  }
  return body;
}

const webSource: DataSource = {
  kind: "web",
  async games(dateKey, signal) {
    const { from, to } = localDayWindow(dateKey);
    const params = new URLSearchParams({ date: dateKey, from, to });
    return getJson<GamesResponse>(`/api/games?${params.toString()}`, signal);
  },
  async detail(gameId, signal) {
    return getJson<GameDetailResponse>(`/api/games/${gameId}`, signal);
  },
  async plays(gameId, signal) {
    return getJson<PlaysResponse>(`/api/games/${gameId}/plays`, signal);
  },
  async lineups(gameId, signal, section) {
    const query = section ? `?section=${section}` : "";
    return getJson<LineupsResponse>(`/api/games/${gameId}/lineups${query}`, signal);
  },
  async standings(signal) {
    return getJson<StandingsResponse>("/api/standings", signal);
  },
};

let transportPromise: Promise<void> | null = null;

/** Route upstream GETs through Capacitor's native HTTP client (no CORS). */
async function installNativeTransport(): Promise<void> {
  const [{ CapacitorHttp }, { setUpstreamRequester, upstreamHeaders }] = await Promise.all([
    import("@capacitor/core"),
    import("@/lib/nba/source"),
  ]);
  const headers = upstreamHeaders();

  setUpstreamRequester(async (url, timeoutMs) => {
    const response = await CapacitorHttp.get({
      url,
      headers,
      responseType: "text",
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    });
    return {
      status: response.status,
      text: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
    };
  });
}

/**
 * Installs the bridge exactly once, behind a shared promise.
 *
 * Marking it ready *before* the dynamic imports resolved used to let a second
 * concurrent first call skip the wait and fall through to the default `fetch`
 * — which the WebView cannot use for these hosts. A failure clears the promise
 * so the next call retries rather than staying broken for the process.
 */
function ensureNativeTransport(): Promise<void> {
  if (!transportPromise) {
    transportPromise = installNativeTransport().catch((error: unknown) => {
      transportPromise = null;
      throw error;
    });
  }
  return transportPromise;
}

/**
 * How long today's list waits for the season schedule before painting.
 *
 * The schedule is a ~7 MB document; the live scoreboard is ~10 KB and already
 * describes today. On a cold start the reader should see today's scores in
 * roughly a second and have the list completed moments later, instead of
 * watching a skeleton until the big document lands. Other dates have no fast
 * answer — the scoreboard only speaks about the present — so they wait.
 */
const FAST_TODAY_BUDGET_MS = 1_200;

const nativeSource: DataSource = {
  kind: "native",
  async games(dateKey) {
    await ensureNativeTransport();
    const [
      { listGames },
      { localDayWindow: window, localDateKey },
    ] = await Promise.all([import("@/lib/nba/games"), import("@/lib/format")]);
    const { from, to } = window(dateKey);
    // The service layer already reports its own freshness; the client adds the
    // receive time. Nothing here invents a timestamp.
    const isToday = dateKey === localDateKey(new Date());
    return {
      date: dateKey,
      ...(await listGames(from, to, isToday ? { scheduleDeadlineMs: FAST_TODAY_BUDGET_MS } : {})),
    };
  },
  async detail(gameId) {
    await ensureNativeTransport();
    const { getGameDetail } = await import("@/lib/nba/games");
    return getGameDetail(gameId);
  },
  async plays(gameId) {
    await ensureNativeTransport();
    const { getGamePlays } = await import("@/lib/nba/games");
    return getGamePlays(gameId);
  },
  async lineups(gameId, _signal, section) {
    await ensureNativeTransport();
    const { getLineups } = await import("@/lib/nba/lineups");
    return getLineups(gameId, section ? { section } : {});
  },
  async standings() {
    await ensureNativeTransport();
    const { getStandings } = await import("@/lib/nba/standings");
    return getStandings();
  },
};

export function activeSource(): DataSource {
  return isNativePlatform() ? nativeSource : webSource;
}
