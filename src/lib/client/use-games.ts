"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { localDateKey, localDayWindow } from "@/lib/format";
import type { GameDetailResponse, GamesResponse, PlaysResponse } from "@/lib/types";
import { usePolledResource, type ResourceState } from "./use-polled-resource";

/** Live games move fastest, games about to tip off move slowly, finals never do. */
const POLL_LIVE_MS = 12_000;
const POLL_UPCOMING_MS = 60_000;

/** Nothing emits date changes; the snapshot re-reads the clock when asked. */
const subscribeToNothing = () => () => {};
const todaySnapshot = () => localDateKey(new Date());
const serverSnapshot = () => null;

/**
 * Today's local calendar day, or `null` before hydration.
 *
 * The browser is the only thing that knows the device's time zone, so every
 * date-dependent label waits for it — which also keeps hydration clean.
 */
export function useLocalToday(): string | null {
  return useSyncExternalStore(subscribeToNothing, todaySnapshot, serverSnapshot);
}

export function useGames(dateKey: string | null): ResourceState<GamesResponse> {
  const url = useMemo(() => {
    if (!dateKey) return null;
    const { from, to } = localDayWindow(dateKey);
    const params = new URLSearchParams({ date: dateKey, from, to });
    return `/api/games?${params.toString()}`;
  }, [dateKey]);

  const nextDelay = useCallback((data: GamesResponse) => {
    if (data.games.some((game) => game.status === "live")) return POLL_LIVE_MS;
    if (data.games.some((game) => game.status === "upcoming")) return POLL_UPCOMING_MS;
    return null;
  }, []);

  return usePolledResource<GamesResponse>({
    cacheKey: `games:${dateKey ?? "pending"}`,
    url,
    nextDelay,
  });
}

export function useGameDetail(gameId: string): ResourceState<GameDetailResponse> {
  const nextDelay = useCallback((data: GameDetailResponse) => {
    if (data.game.status === "live") return POLL_LIVE_MS;
    if (data.game.status === "upcoming") return POLL_UPCOMING_MS;
    return null;
  }, []);

  return usePolledResource<GameDetailResponse>({
    cacheKey: `game:${gameId}`,
    url: gameId ? `/api/games/${gameId}` : null,
    nextDelay,
  });
}

/**
 * Play-by-play for the Plays tab. Fetched lazily — `enabled` is only true
 * while the tab is mounted — so games nobody opens never pay for 600 events.
 * Live games keep polling; everything else loads once and stops.
 */
export function useGamePlays(gameId: string, enabled: boolean): ResourceState<PlaysResponse> {
  const nextDelay = useCallback((data: PlaysResponse) => {
    if (data.status === "live") return POLL_LIVE_MS;
    return null;
  }, []);

  return usePolledResource<PlaysResponse>({
    cacheKey: `plays:${gameId}`,
    url: enabled && gameId ? `/api/games/${gameId}/plays` : null,
    nextDelay,
  });
}
