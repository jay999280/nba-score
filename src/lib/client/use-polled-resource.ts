"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A polling resource with the refresh rules the PRD asks for (PRD §27):
 *
 *  - the caller decides the cadence from the payload it just received;
 *  - polling stops the moment the caller returns `null`;
 *  - regaining focus refreshes immediately;
 *  - the last good payload is kept in memory, so switching back to a date the
 *    user already visited paints instantly and never flashes a skeleton.
 */

export interface ResourceState<T> {
  data: T | null;
  status: "loading" | "ready" | "error";
  /** True while showing a cached payload after a failed refresh (PRD §33). */
  stale: boolean;
  updatedAt: Date | null;
  refresh: () => void;
}

interface Options<T> {
  /** Identity of the payload; also the in-memory cache key. */
  cacheKey: string;
  /**
   * Performs the request. `null` disables fetching entirely and stops the
   * loop. Must be referentially stable (wrap it in `useCallback`).
   */
  load: ((signal: AbortSignal) => Promise<T>) | null;
  /**
   * Milliseconds until the next poll, or `null` to stop. Must be referentially
   * stable (wrap it in `useCallback`); it is read through a ref regardless.
   */
  nextDelay: (data: T) => number | null;
  /** Used when a refresh fails, so errors do not spin the loop. */
  retryDelay?: number;
}

interface Snapshot<T> {
  key: string;
  data: T | null;
  updatedAt: Date | null;
  failed: boolean;
}

const memory = new Map<string, { data: unknown; updatedAt: Date }>();

function snapshotFor<T>(key: string, failed: boolean): Snapshot<T> {
  const cached = memory.get(key);
  return {
    key,
    data: (cached?.data as T) ?? null,
    updatedAt: cached?.updatedAt ?? null,
    failed,
  };
}

export function usePolledResource<T>({
  cacheKey,
  load,
  nextDelay,
  retryDelay = 20_000,
}: Options<T>): ResourceState<T> {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(() => snapshotFor<T>(cacheKey, false));
  const [nonce, setNonce] = useState(0);

  // Read through to the cache when the key changed during this render, so a
  // revisited date renders its old payload on the very first paint.
  const view = snapshot.key === cacheKey ? snapshot : snapshotFor<T>(cacheKey, false);

  // Kept in a ref so a fresh inline callback cannot restart the polling loop.
  const nextDelayRef = useRef(nextDelay);
  useEffect(() => {
    nextDelayRef.current = nextDelay;
  });

  useEffect(() => {
    if (!load) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const schedule = (delay: number | null) => {
      if (cancelled || delay === null) return;
      timer = setTimeout(run, delay);
    };

    const run = async () => {
      try {
        const body = await load(controller.signal);
        if (cancelled) return;

        const updatedAt = new Date();
        memory.set(cacheKey, { data: body, updatedAt });
        setSnapshot({ key: cacheKey, data: body, updatedAt, failed: false });
        schedule(nextDelayRef.current(body));
      } catch (error) {
        if (cancelled || (error as Error)?.name === "AbortError") return;

        const cached = memory.get(cacheKey);
        setSnapshot({
          key: cacheKey,
          data: (cached?.data as T) ?? null,
          updatedAt: cached?.updatedAt ?? null,
          failed: true,
        });
        const delay = cached ? nextDelayRef.current(cached.data as T) : null;
        schedule(delay === null ? retryDelay : Math.max(delay, retryDelay));
      }
    };

    void run();

    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void run();
    };

    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [cacheKey, load, nonce, retryDelay]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const status: ResourceState<T>["status"] =
    view.data !== null ? "ready" : view.failed ? "error" : "loading";

  return {
    data: view.data,
    status,
    stale: view.failed && view.data !== null,
    updatedAt: view.updatedAt,
    refresh,
  };
}
