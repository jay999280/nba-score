"use client";

import { useCallback, useMemo } from "react";

import type { LineupsResponse } from "@/lib/types";
import { activeSource } from "./data-source";
import { usePolledResource, type ResourceState } from "./use-polled-resource";

/**
 * Pre-game data that is not part of the NBA feeds: the season comparison and
 * the probable lineups.
 *
 * Two resources rather than one because the two halves cost very different
 * amounts: the comparison is two team-statistics documents (plus the shared
 * standings read), while a lineup needs a box score, a roster and one
 * statistics read per player. The comparison therefore loads as soon as the
 * pre-game view mounts, and the lineups only when the reader expands the block
 * — `enabled` is false until then, which keeps the request from ever being
 * made for a page nobody expanded.
 *
 * Neither resource polls: season statistics move after a game, not between two
 * scores on the same screen. A failed read is retried by the shared loop's
 * default backoff, and the block shows its explicit "unavailable" copy.
 */

/** `null` disables the loop entirely, like `useGamePlays`' `load`. */
function lineupsLoader(gameId: string, section: "comparison" | "lineups", enabled: boolean) {
  if (!enabled || !gameId) return null;
  const source = activeSource();
  return (signal: AbortSignal) => source.lineups(gameId, signal, section);
}

export function useTeamComparison(gameId: string): ResourceState<LineupsResponse> {
  const load = useMemo(() => lineupsLoader(gameId, "comparison", true), [gameId]);
  const nextDelay = useCallback(() => null, []);
  return usePolledResource<LineupsResponse>({
    cacheKey: `lineups:comparison:${gameId}`,
    load,
    nextDelay,
  });
}

export function useLineups(gameId: string, enabled: boolean): ResourceState<LineupsResponse> {
  const load = useMemo(() => lineupsLoader(gameId, "lineups", enabled), [gameId, enabled]);
  const nextDelay = useCallback(() => null, []);
  return usePolledResource<LineupsResponse>({
    cacheKey: `lineups:roster:${gameId}`,
    load,
    nextDelay,
  });
}
