/**
 * The polling loop, with React taken out of it.
 *
 * `use-polled-resource.ts` is a thin binding over this module. The scheduling
 * rules the review cares about all live here — one request in flight, exactly
 * one planned timer, background parking, coalesced wakes, superseded responses
 * dropped, and a wake that arrives *during* a request deferred to exactly one
 * catch-up. That catch-up is parked — not run — when the document went hidden
 * before the attempt settled, and is paid by the first wake after it is visible
 * again (B5) — with the clock, the visibility check and the cache injected so
 * `node --test` can drive them deterministically with a fake clock and
 * deferred promises.
 *
 * Nothing here imports React or reaches for the DOM at module scope, so the
 * regression suite can exercise the very same code the hook runs.
 */

/** focus and visibilitychange can arrive microseconds apart. */
export const WAKE_COALESCE_MS = 1_000;

/** What the loop needs from a clock. Injectable so tests can own time. */
export interface PollClock {
  now(): number;
  setTimeout(handler: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: PollClock = {
  now: () => Date.now(),
  setTimeout: (handler, delay) => setTimeout(handler, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One published state of the resource. `key` is the cache key it belongs to. */
export interface PollSnapshot<T> {
  key: string;
  data: T | null;
  receivedAt: Date | null;
  sourceAt: Date | null;
  failed: boolean;
}

export interface PollCacheEntry<T> {
  data: T;
  receivedAt: Date;
  sourceAt: Date | null;
}

export interface PollCache {
  read<T>(key: string): PollCacheEntry<T> | undefined;
  write<T>(key: string, entry: PollCacheEntry<T>): void;
}

/** Last-good payloads, keyed so a revisited date paints from memory. */
export function createMemoryPollCache(): PollCache {
  const entries = new Map<string, PollCacheEntry<unknown>>();
  return {
    read<T>(key: string): PollCacheEntry<T> | undefined {
      return entries.get(key) as PollCacheEntry<T> | undefined;
    },
    write<T>(key: string, entry: PollCacheEntry<T>): void {
      entries.set(key, entry);
    },
  };
}

/**
 * The cache every mounted resource shares. Module-level on purpose: the last
 * good payload outlives the component that fetched it, so returning to a date
 * never flashes a skeleton.
 */
export const sharedPollCache: PollCache = createMemoryPollCache();

/** Upstream's own data time, when the payload declares one. */
export function readSourceAt(value: unknown): Date | null {
  const iso = (value as { freshness?: { sourceAt?: unknown } } | null)?.freshness?.sourceAt;
  if (typeof iso !== "string") return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time);
}

/** What the cache holds right now, as a publishable snapshot. */
export function snapshotFromCache<T>(cache: PollCache, key: string, failed = false): PollSnapshot<T> {
  const cached = cache.read<T>(key);
  return {
    key,
    data: cached?.data ?? null,
    receivedAt: cached?.receivedAt ?? null,
    sourceAt: cached?.sourceAt ?? null,
    failed,
  };
}

/**
 * Why a wake did or did not start a request. `queued` is the R7 case: a
 * request was already in flight, so this wake is remembered and paid for once
 * when that request settles.
 */
export type WakeOutcome = "ran" | "queued" | "coalesced" | "parked" | "disposed";

export interface PollLoopOptions<T> {
  /** Identity of the payload; also the cache key. */
  cacheKey: string;
  /**
   * Performs the request. Must be referentially stable for the loop's
   * lifetime — the hook recreates the loop when the loader changes.
   */
  load: (signal: AbortSignal) => Promise<T>;
  /** Milliseconds until the next poll, or `null` to stop after this one. */
  nextDelay: (data: T) => number | null;
  /** Reconcile a fresh payload with the last good one before publishing. */
  merge?: (previous: T | null, next: T) => T;
  /** Used when a refresh fails, so errors do not spin the loop. */
  retryDelay?: number;
  cache?: PollCache;
  clock?: PollClock;
  /** The document is visible right now. Polling parks while it is not. */
  isVisible?: () => boolean;
  onSnapshot?: (snapshot: PollSnapshot<T>) => void;
  onRefreshing?: (refreshing: boolean) => void;
}

export interface PollLoop {
  /** First request of the loop's life. Runs even while hidden, like a mount. */
  start(): void;
  /**
   * focus / visibilitychange. Never runs a second request in parallel: while
   * one is in flight the wake is recorded and replayed once afterwards. A
   * catch-up parked while the document was hidden is paid by the first wake
   * after it becomes visible again, coalescing window or not.
   */
  wake(): WakeOutcome;
  /** Cancels the timer, aborts the request and refuses to publish anything. */
  dispose(): void;
}

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function createPollLoop<T>({
  cacheKey,
  load,
  nextDelay,
  merge,
  retryDelay = 20_000,
  cache = sharedPollCache,
  clock = systemClock,
  isVisible = documentIsVisible,
  onSnapshot,
  onRefreshing,
}: PollLoopOptions<T>): PollLoop {
  let disposed = false;
  let started = false;
  let timer: unknown;
  let inFlight = false;
  /**
   * A wake that arrived while a request was in flight; paid once, never
   * queued. When the attempt settles hidden the intent stays *parked* here —
   * set, but with no timer — until the next visible wake (B5).
   */
  let pendingWake = false;
  let lastWake = 0;
  const controller = new AbortController();

  const clearTimer = () => {
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = (delay: number | null) => {
    clearTimer();
    if (disposed || delay === null) return;
    // While the app is in the background the loop is parked; coming back runs
    // one sync and reschedules from there.
    if (!isVisible()) return;
    const wait = Number.isFinite(delay) ? Math.max(0, delay) : 0;
    timer = clock.setTimeout(() => {
      timer = undefined;
      void run();
    }, wait);
  };

  const run = async (): Promise<void> => {
    if (disposed || inFlight) return;
    inFlight = true;
    onRefreshing?.(true);

    /** What to do once this attempt settles and nothing else is owed. */
    let plan: (() => void) | undefined;

    try {
      const payload = await load(controller.signal);
      // A superseded or unmounted attempt must never publish: the request
      // itself may be uncancellable (native bridge), so the guard is here.
      if (disposed) return;

      const previous = cache.read<T>(cacheKey)?.data ?? null;
      const reconciled = merge ? merge(previous, payload) : payload;

      const receivedAt = new Date(clock.now());
      const sourceAt = readSourceAt(reconciled);
      cache.write<T>(cacheKey, { data: reconciled, receivedAt, sourceAt });
      onSnapshot?.({ key: cacheKey, data: reconciled, receivedAt, sourceAt, failed: false });
      // Read the cadence here, inside the attempt: a throwing `nextDelay` is a
      // failed refresh, not an unhandled rejection escaping the loop.
      const delay = nextDelay(reconciled);
      plan = () => schedule(delay);
    } catch (error) {
      if (disposed || (error as Error)?.name === "AbortError") return;

      const cached = cache.read<T>(cacheKey);
      onSnapshot?.({
        key: cacheKey,
        data: cached?.data ?? null,
        receivedAt: cached?.receivedAt ?? null,
        sourceAt: cached?.sourceAt ?? null,
        failed: true,
      });
      const delay = cached ? nextDelay(cached.data) : null;
      const backoff = delay === null ? retryDelay : Math.max(delay, retryDelay);
      plan = () => schedule(backoff);
    } finally {
      inFlight = false;
      if (!disposed) {
        onRefreshing?.(false);
        // A wake collected during this attempt is replayed exactly once:
        // clearing the flag before re-entering means the catch-up cannot chain.
        if (pendingWake) {
          if (isVisible()) {
            pendingWake = false;
            void run();
          } else {
            // B5: the document went hidden while this attempt was in flight.
            // Running the owed sync here would be a background request the user
            // never asked for. Keep the intent parked and leave no timer, so a
            // hidden loop is completely idle; the next visible wake pays it.
            clearTimer();
          }
        } else {
          plan?.();
        }
      }
    }
  };

  const start = () => {
    if (disposed || started) return;
    started = true;
    void run();
  };

  const wake = (): WakeOutcome => {
    if (disposed) return "disposed";
    if (!isVisible()) {
      clearTimer();
      return "parked";
    }

    // B5: a catch-up parked while the document was hidden is owed the moment
    // it is visible again. Parking is not a new wake, so the coalescing window
    // must not swallow it; it is only paid when nothing is in flight, and
    // stamping `lastWake` folds the sibling focus event into this same sync.
    if (pendingWake && !inFlight) {
      lastWake = clock.now();
      clearTimer();
      pendingWake = false;
      void run();
      return "ran";
    }

    const now = clock.now();
    if (now - lastWake < WAKE_COALESCE_MS) return "coalesced";
    lastWake = now;

    clearTimer();
    if (inFlight) {
      pendingWake = true;
      return "queued";
    }

    void run();
    return "ran";
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pendingWake = false;
    clearTimer();
    controller.abort();
  };

  return { start, wake, dispose };
}
