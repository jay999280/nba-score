import { localDayWindow } from "@/lib/format";
import type { GameDetailResponse, GamesResponse, PlaysResponse } from "@/lib/types";

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
}

function isNativePlatform(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (
    window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return (await response.json()) as T;
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
};

let transportReady = false;

/** Route upstream GETs through Capacitor's native HTTP client (no CORS). */
async function ensureNativeTransport(): Promise<void> {
  if (transportReady) return;
  transportReady = true;

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

const nativeSource: DataSource = {
  kind: "native",
  async games(dateKey) {
    await ensureNativeTransport();
    const [{ listGames }, { localDayWindow: window }] = await Promise.all([
      import("@/lib/nba/games"),
      import("@/lib/format"),
    ]);
    const { from, to } = window(dateKey);
    return {
      date: dateKey,
      games: await listGames(from, to),
      updatedAt: new Date().toISOString(),
    };
  },
  async detail(gameId) {
    await ensureNativeTransport();
    const { getGameDetail } = await import("@/lib/nba/games");
    return { game: await getGameDetail(gameId), updatedAt: new Date().toISOString() };
  },
  async plays(gameId) {
    await ensureNativeTransport();
    const { getGamePlays } = await import("@/lib/nba/games");
    const plays = await getGamePlays(gameId);
    return { ...plays, updatedAt: new Date().toISOString() };
  },
};

export function activeSource(): DataSource {
  return isNativePlatform() ? nativeSource : webSource;
}
