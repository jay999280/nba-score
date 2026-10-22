"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { localDateKey } from "@/lib/format";
import { mergeGames } from "@/lib/game-state";
import type { GameDetailResponse, GamesResponse, PlaysResponse } from "@/lib/types";
import { activeSource } from "./data-source";
import { usePolledResource, type ResourceState } from "./use-polled-resource";

/** Live games move fastest; tip-off watch catches the flip promptly. */
const POLL_LIVE_MS = 6_000;
const POLL_UPCOMING_MS = 60_000;
const POLL_TIPOFF_MS = 15_000;
/** The schedule is still loading; the list must be completed shortly. */
const POLL_PENDING_MS = 2_000;
/** Games tipping within this window get watched closely. */
const TIPOFF_WINDOW_MS = 10 * 60_000;

/** Nothing emits date changes; the snapshot re-reads the clock when asked. */
const todaySnapshot = () => localDateKey(new Date());
const serverSnapshot = () => null;

/**
 * Milliseconds until the next local midnight. Derived from local calendar
 * fields, so a 23- or 25-hour DST day is handled without a hard-coded offset.
 *
 * Exported so the regression suite can assert the arithmetic directly.
 */
export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime() + 50);
}

/**
 * Did the device's UTC offset change since the last reading?
 *
 * Carrying a phone into another time zone moves the local midnight the timer
 * is aimed at, so the chain has to be re-armed on the next wake. An unknown
 * previous reading counts as "re-arm": the safe direction, because a needless
 * re-arm costs one timer while a missed one costs a whole day.
 *
 * Exported so the regression suite can assert the rule directly.
 */
export function shouldRescheduleMidnight(
  previousOffset: number | null | undefined,
  nextOffset: number,
): boolean {
  if (previousOffset === null || previousOffset === undefined) return true;
  if (!Number.isFinite(previousOffset) || !Number.isFinite(nextOffset)) return true;
  return previousOffset !== nextOffset;
}

/**
 * Re-reads the date when the local day actually turns over, and whenever the
 * app is looked at again (a phone that slept through midnight, or a device
 * whose time zone changed). Without this the default day stayed on yesterday
 * until some unrelated state change happened to re-render.
 *
 * Every wake also re-derives the midnight target from the current clock: the
 * OS can freeze a timer while the app sits in the background, and a device
 * carried across time zones has a different local midnight. `clearTimeout`
 * before `setTimeout` keeps exactly one chain alive.
 *
 * Exported so the regression suite can drive the focus path with stub
 * listeners and a fake timer instead of waiting for a real midnight.
 */
export function subscribeToDayChange(listener: () => void): () => void {
  function nextMidnightTarget(): number {
    const now = new Date();
    return now.getTime() + msUntilNextLocalMidnight(now);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let offset = new Date().getTimezoneOffset();
  let target = nextMidnightTarget();

  function arm(at: number) {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(onMidnight, Math.max(0, at - Date.now()));
  }

  function onMidnight() {
    timer = undefined;
    listener();
    target = nextMidnightTarget();
    arm(target);
  }

  function onWake() {
    const current = new Date().getTimezoneOffset();
    const zoneChanged = shouldRescheduleMidnight(offset, current);
    offset = current;

    const fresh = nextMidnightTarget();
    // A changed offset moves the goal itself; a missing timer means the chain
    // was dropped (frozen timer, throttled tab) and must be rebuilt.
    if (zoneChanged || timer === undefined || fresh !== target) {
      target = fresh;
      arm(fresh);
    }

    // React re-reads the date on every wake: a phone that slept through
    // midnight has no other trigger, and after a zone change "today" may well
    // be a different day than the one on screen.
    listener();
  }

  arm(target);
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("focus", onWake);

  return () => {
    clearTimeout(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", onWake);
    window.removeEventListener("focus", onWake);
  };
}

/**
 * Today's local calendar day, or `null` before hydration.
 *
 * The browser is the only thing that knows the device's time zone, so every
 * date-dependent label waits for it — which also keeps hydration clean.
 */
export function useLocalToday(): string | null {
  return useSyncExternalStore(subscribeToDayChange, todaySnapshot, serverSnapshot);
}

export function useGames(dateKey: string | null): ResourceState<GamesResponse> {
  const load = useMemo(() => {
    if (!dateKey) return null;
    const source = activeSource();
    return (signal: AbortSignal) => source.games(dateKey, signal);
  }, [dateKey]);

  /**
   * A degraded payload may not move a game backwards. When the live feed is
   * missing, the schedule alone can report a game that was 89–94 a moment ago
   * as "upcoming / no score"; publishing that would be a regression dressed as
   * a successful refresh.
   */
  const merge = useCallback(
    (previous: GamesResponse | null, next: GamesResponse): GamesResponse => ({
      ...next,
      games: mergeGames(previous?.games ?? null, next.games, next.freshness).games,
    }),
    [],
  );

  const nextDelay = useCallback((data: GamesResponse) => {
    // The schedule is still on its way: the list on screen is real but may be
    // incomplete, so poll again shortly rather than waiting a whole minute for
    // the normal cadence. This is what turns a fast partial paint into a
    // complete list without the reader doing anything.
    if (data.freshness.schedulePending) return POLL_PENDING_MS;
    const now = Date.now();
    if (data.games.some((game) => game.status === "live")) return POLL_LIVE_MS;
    if (
      data.games.some(
        (game) =>
          game.status === "upcoming" &&
          !game.postponed &&
          Date.parse(game.startTime) - now < TIPOFF_WINDOW_MS &&
          Date.parse(game.startTime) - now > -30 * 60_000,
      )
    ) {
      return POLL_TIPOFF_MS;
    }
    if (data.games.some((game) => game.status === "upcoming")) return POLL_UPCOMING_MS;
    return null;
  }, []);

  return usePolledResource<GamesResponse>({
    cacheKey: `games:${dateKey ?? "pending"}`,
    load,
    merge,
    nextDelay,
  });
}

export function useGameDetail(gameId: string): ResourceState<GameDetailResponse> {
  const load = useMemo(() => {
    if (!gameId) return null;
    const source = activeSource();
    return (signal: AbortSignal) => source.detail(gameId, signal);
  }, [gameId]);

  const nextDelay = useCallback((data: GameDetailResponse) => {
    // The pre-game page is built from the schedule; finishing that read is what
    // turns a placeholder into the full matchup, so retry shortly instead of
    // waiting out the normal cadence for an upcoming game.
    if (data.freshness.schedulePending) return POLL_PENDING_MS;
    if (data.game.status === "live") return POLL_LIVE_MS;
    if (
      data.game.status === "upcoming" &&
      !data.game.postponed &&
      Date.parse(data.game.startTime) - Date.now() < TIPOFF_WINDOW_MS
    ) {
      return POLL_TIPOFF_MS;
    }
    if (data.game.status === "upcoming") return POLL_UPCOMING_MS;
    return null;
  }, []);

  return usePolledResource<GameDetailResponse>({
    cacheKey: `game:${gameId}`,
    load,
    nextDelay,
  });
}

/**
 * Play-by-play for the Plays tab. Fetched lazily — `enabled` is only true
 * while the tab is mounted — so games nobody opens never pay for 600 events.
 * Live games keep polling; everything else loads once and stops.
 */
export function useGamePlays(gameId: string, enabled: boolean): ResourceState<PlaysResponse> {
  const load = useMemo(() => {
    if (!enabled || !gameId) return null;
    const source = activeSource();
    return (signal: AbortSignal) => source.plays(gameId, signal);
  }, [gameId, enabled]);

  const nextDelay = useCallback((data: PlaysResponse) => {
    if (data.status === "live") return POLL_LIVE_MS;
    return null;
  }, []);

  return usePolledResource<PlaysResponse>({
    cacheKey: `plays:${gameId}`,
    load,
    nextDelay,
  });
}
