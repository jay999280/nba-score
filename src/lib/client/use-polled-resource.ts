"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createPollLoop,
  sharedPollCache,
  snapshotFromCache,
  type PollSnapshot,
} from "./poll-loop";

/**
 * A polling resource with the refresh rules the PRD asks for (PRD §27), plus
 * the freshness discipline the v0.9 review required:
 *
 *  - the caller decides the cadence from the payload it just received;
 *  - polling stops the moment the caller returns `null`;
 *  - **at most one request is in flight**, and exactly one timer is scheduled;
 *  - focus and visibilitychange are coalesced into a single sync, and the loop
 *    is suspended entirely while the document is hidden;
 *  - a wake that arrives while a request is in flight is remembered and
 *    replayed **once** when that request settles, so returning to the app
 *    while a slow request is pending still syncs immediately afterwards;
 *  - a response that belongs to a superseded attempt is discarded rather than
 *    written over newer data (native HTTP cannot be cancelled, so this is a
 *    guard, not an optimisation);
 *  - the receive time and the upstream data time are kept apart, so the UI can
 *    never present "when we happened to fetch" as "when the score was true";
 *  - the last good payload is kept in memory, so returning to a date paints
 *    instantly and never flashes a skeleton.
 *
 * All of the scheduling — and therefore all of the rules above — lives in
 * `./poll-loop`, which has no React dependency so the regression suite can
 * drive it with a fake clock. This hook is the React binding: it owns the
 * component state, the refs that keep inline callbacks from restarting the
 * loop, and the event listeners.
 */

export interface ResourceState<T> {
  data: T | null;
  status: "loading" | "ready" | "error";
  /** The last attempt failed; what is on screen is the previous payload. */
  stale: boolean;
  /** Client clock when the payload on screen arrived. */
  receivedAt: Date | null;
  /** Upstream's own data time, when the payload carries one. */
  sourceAt: Date | null;
  /** A request is in flight right now. */
  refreshing: boolean;
  refresh: () => void;
}

interface Options<T> {
  /** Identity of the payload; also the in-memory cache key. */
  cacheKey: string;
  /**
   * Performs the request. `null` disables fetching entirely and stops the
   * loop. Must be referentially stable (wrap it in `useCallback`/`useMemo`).
   */
  load: ((signal: AbortSignal) => Promise<T>) | null;
  /**
   * Milliseconds until the next poll, or `null` to stop. Must be referentially
   * stable (wrap it in `useCallback`); it is read through a ref regardless.
   */
  nextDelay: (data: T) => number | null;
  /**
   * Reconcile a fresh payload with the last good one before it is published.
   * Read through a ref, so an inline closure does not restart the loop.
   */
  merge?: (previous: T | null, next: T) => T;
  /** Used when a refresh fails, so errors do not spin the loop. */
  retryDelay?: number;
}

export function usePolledResource<T>({
  cacheKey,
  load,
  nextDelay,
  merge,
  retryDelay = 20_000,
}: Options<T>): ResourceState<T> {
  const [snapshot, setSnapshot] = useState<PollSnapshot<T>>(() =>
    snapshotFromCache<T>(sharedPollCache, cacheKey),
  );
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Read through to the cache when the key changed during this render, so a
  // revisited date renders its old payload on the very first paint.
  const view = snapshot.key === cacheKey ? snapshot : snapshotFromCache<T>(sharedPollCache, cacheKey);

  // Kept in refs so a fresh inline callback cannot restart the polling loop.
  const nextDelayRef = useRef(nextDelay);
  const mergeRef = useRef(merge);
  useEffect(() => {
    nextDelayRef.current = nextDelay;
    mergeRef.current = merge;
  });

  useEffect(() => {
    if (!load) return;

    const loop = createPollLoop<T>({
      cacheKey,
      load,
      nextDelay: (data) => nextDelayRef.current(data),
      merge: (previous, next) => (mergeRef.current ? mergeRef.current(previous, next) : next),
      retryDelay,
      onSnapshot: setSnapshot,
      onRefreshing: setRefreshing,
    });

    loop.start();

    const onSignal = () => {
      loop.wake();
    };

    document.addEventListener("visibilitychange", onSignal);
    window.addEventListener("focus", onSignal);

    return () => {
      document.removeEventListener("visibilitychange", onSignal);
      window.removeEventListener("focus", onSignal);
      loop.dispose();
    };
  }, [cacheKey, load, nonce, retryDelay]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const status: ResourceState<T>["status"] =
    view.data !== null ? "ready" : view.failed ? "error" : "loading";

  return {
    data: view.data,
    status,
    stale: view.failed && view.data !== null,
    receivedAt: view.receivedAt,
    sourceAt: view.sourceAt,
    refreshing,
    refresh,
  };
}
