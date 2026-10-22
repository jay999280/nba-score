"use client";

import { useCallback, useMemo } from "react";
import type { StandingsResponse } from "@/lib/types";
import { activeSource } from "./data-source";
import { usePolledResource } from "./use-polled-resource";

/** Standings load separately so a failed ranking feed never blocks scores. */
export function useStandings() {
  const load = useMemo(() => {
    const source = activeSource();
    return (signal: AbortSignal) => source.standings(signal);
  }, []);
  const nextDelay = useCallback(() => 5 * 60_000, []);
  return usePolledResource<StandingsResponse>({ cacheKey: "standings:current", load, nextDelay });
}
