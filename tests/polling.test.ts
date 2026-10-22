/**
 * R7 regression: the polling loop's scheduling rules, driven by a fake clock
 * and deferred promises.
 *
 * `src/lib/client/poll-loop.ts` is the module `use-polled-resource` actually
 * runs — the hook is only the React binding (useState/useEffect + listeners) —
 * so these assertions cover the shipped scheduling code. Only the binding
 * itself is not exercised here: the suite has no DOM and the project
 * deliberately adds no renderer dependency.
 *
 * The covered rules are the ones the v0.9 review asked for:
 *   - focus + visibilitychange inside one coalesce window sync once;
 *   - a wake that lands while a request is in flight is replayed once, never
 *     queued up;
 *   - a slow, superseded response cannot overwrite the newer payload;
 *   - at most one request in flight and one planned timer at a time;
 *   - a hidden document parks the loop; failures keep the last good payload
 *     and honour the retry floor; `nextDelay: null` stops the loop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WAKE_COALESCE_MS,
  createMemoryPollCache,
  createPollLoop,
  type PollCache,
  type PollClock,
  type PollLoop,
  type PollSnapshot,
} from "../src/lib/client/poll-loop.ts";

/** A realistic epoch, so "no wake yet" (lastWake = 0) is far in the past. */
const T0 = Date.UTC(2026, 9, 10, 18, 0, 0);
const KEY = "games:2026-10-11";

interface Payload {
  value: string;
  freshness: { sourceAt: string };
}

function payload(value: string, sourceAt = "2026-10-11T02:00:00Z"): Payload {
  return { value, freshness: { sourceAt } };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-scheduled microtask run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeClock {
  clock: PollClock;
  advance(ms: number): void;
  pending(): number;
  now(): number;
}

function createFakeClock(start = T0): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; handler: () => void }>();

  const clock: PollClock = {
    now: () => now,
    setTimeout(handler, delay) {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, delay), handler });
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(Number(handle));
    },
  };

  return {
    clock,
    now: () => now,
    pending: () => timers.size,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let dueId = -1;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of timers) {
          if (entry.at <= until && entry.at < dueAt) {
            dueAt = entry.at;
            dueId = id;
          }
        }
        if (dueId === -1) break;
        const entry = timers.get(dueId);
        timers.delete(dueId);
        now = entry ? entry.at : now;
        entry?.handler();
      }
      now = until;
    },
  };
}

interface Harness {
  loop: PollLoop;
  fake: FakeClock;
  cache: PollCache;
  requests: Array<{ deferred: Deferred<Payload>; at: number }>;
  published: PollSnapshot<Payload>[];
  /** Was the document visible at the moment each request started? */
  visibleAtStart: boolean[];
  inFlight(): number;
  peakConcurrency(): number;
}

function createHarness(
  options: {
    cacheKey?: string;
    nextDelay?: (data: Payload) => number | null;
    retryDelay?: number;
    isVisible?: () => boolean;
  } = {},
): Harness {
  const cache = createMemoryPollCache();
  const fake = createFakeClock();
  const requests: Array<{ deferred: Deferred<Payload>; at: number }> = [];
  const published: PollSnapshot<Payload>[] = [];
  const visibleAtStart: boolean[] = [];
  let inFlight = 0;
  let peak = 0;

  // Mirrors the loop's own default (no `document` in node means visible).
  const visibleNow = () => options.isVisible?.() ?? true;

  const loop = createPollLoop<Payload>({
    cacheKey: options.cacheKey ?? KEY,
    load: () => {
      const pending = deferred<Payload>();
      requests.push({ deferred: pending, at: fake.now() });
      visibleAtStart.push(visibleNow());
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return pending.promise.finally(() => {
        inFlight -= 1;
      });
    },
    nextDelay: options.nextDelay ?? (() => 6_000),
    retryDelay: options.retryDelay,
    cache,
    clock: fake.clock,
    isVisible: options.isVisible,
    onSnapshot: (snapshot) => published.push(snapshot),
  });

  return {
    loop,
    fake,
    cache,
    requests,
    published,
    visibleAtStart,
    inFlight: () => inFlight,
    peakConcurrency: () => peak,
  };
}

test("a wake during a slow request is replayed exactly once after it settles", async () => {
  const h = createHarness();

  h.loop.start();
  assert.equal(h.requests.length, 1, "mount starts one request");
  assert.equal(h.fake.pending(), 0, "no timer is planned while a request is in flight");

  h.fake.advance(WAKE_COALESCE_MS + 1);
  assert.equal(h.loop.wake(), "queued");
  assert.equal(h.requests.length, 1, "the wake must not start a second request");

  h.fake.advance(5_000);
  assert.equal(h.loop.wake(), "queued", "a second wake still only owes one catch-up");
  assert.equal(h.requests.length, 1, "queued wakes never pile up");

  h.requests[0].deferred.resolve(payload("slow"));
  await flush();
  assert.equal(h.requests.length, 2, "the pending wake is paid once, right after the settle");
  assert.equal(h.published.length, 1, "the slow response publishes before the catch-up answers");

  h.requests[1].deferred.resolve(payload("catch-up"));
  await flush();
  assert.equal(h.requests.length, 2, "the catch-up does not chain into a third request");
  assert.equal(h.published.at(-1)?.data?.value, "catch-up");
  assert.equal(h.cache.read<Payload>(KEY)?.data.value, "catch-up");
  assert.equal(h.fake.pending(), 1, "the loop hands back to exactly one timer");
  assert.equal(h.inFlight(), 0);
});

test("focus and visibilitychange inside one coalesce window sync once", async () => {
  const h = createHarness();

  h.loop.start();
  h.requests[0].deferred.resolve(payload("first"));
  await flush();
  assert.equal(h.fake.pending(), 1, "exactly one planned timer once settled");

  assert.equal(h.loop.wake(), "ran", "the focus event runs the sync");
  assert.equal(h.requests.length, 2);
  assert.equal(h.fake.pending(), 0, "the planned timer is replaced by the sync, not left behind");

  h.fake.advance(200);
  assert.equal(h.loop.wake(), "coalesced", "the sibling visibilitychange inside 1s is merged away");
  assert.equal(h.requests.length, 2);

  h.requests[1].deferred.resolve(payload("second"));
  await flush();
  assert.equal(h.fake.pending(), 1, "back to one timer");

  h.fake.advance(WAKE_COALESCE_MS + 400);
  assert.equal(h.loop.wake(), "ran", "past the window a wake syncs again");
  assert.equal(h.requests.length, 3);
});

test("never more than one request in flight and one planned timer", async () => {
  const h = createHarness();

  h.loop.start();
  assert.equal(h.requests.length, 1);
  assert.equal(h.fake.pending(), 0);

  h.fake.advance(WAKE_COALESCE_MS + 1);
  assert.equal(h.loop.wake(), "queued");
  assert.equal(h.requests.length, 1);
  assert.equal(h.peakConcurrency(), 1);

  h.requests[0].deferred.resolve(payload("a"));
  await flush();
  assert.equal(h.requests.length, 2, "the queued wake is replayed");
  assert.equal(h.fake.pending(), 0, "no timer exists while the catch-up is in flight");
  assert.equal(h.peakConcurrency(), 1);

  h.requests[1].deferred.resolve(payload("b"));
  await flush();
  assert.equal(h.fake.pending(), 1, "exactly one timer once idle");

  h.fake.advance(6_000);
  assert.equal(h.requests.length, 3, "the timer polls again");
  assert.equal(h.fake.pending(), 0);
  assert.equal(h.peakConcurrency(), 1);
});

test("a superseded slow response cannot overwrite the newer payload", async () => {
  const cache = createMemoryPollCache();
  const fake = createFakeClock();
  const slow = deferred<Payload>();
  const fast = deferred<Payload>();
  const published: string[] = [];
  const key = "games:2026-10-10";

  const first = createPollLoop<Payload>({
    cacheKey: key,
    load: () => slow.promise,
    nextDelay: () => null,
    cache,
    clock: fake.clock,
    onSnapshot: (snapshot) => published.push(`first:${snapshot.data?.value ?? "null"}`),
  });
  first.start();

  // What the hook does when the resource identity changes mid-request.
  first.dispose();

  const second = createPollLoop<Payload>({
    cacheKey: key,
    load: () => fast.promise,
    nextDelay: () => null,
    cache,
    clock: fake.clock,
    onSnapshot: (snapshot) => published.push(`second:${snapshot.data?.value ?? "null"}`),
  });
  second.start();

  fast.resolve(payload("B"));
  await flush();
  assert.equal(cache.read<Payload>(key)?.data.value, "B");

  slow.resolve(payload("A"));
  await flush();
  assert.equal(cache.read<Payload>(key)?.data.value, "B", "the slow, superseded response is dropped");
  assert.deepEqual(published, ["second:B"], "and it never reaches the screen");

  second.dispose();
});

test("a hidden document parks the loop until the next wake", async () => {
  let visible = true;
  const h = createHarness({ isVisible: () => visible });

  h.loop.start();
  assert.equal(h.requests.length, 1);

  visible = false;
  assert.equal(h.loop.wake(), "parked");
  assert.equal(h.requests.length, 1, "no request starts while hidden");

  h.requests[0].deferred.resolve(payload("while-hidden"));
  await flush();
  assert.equal(h.fake.pending(), 0, "settling while hidden does not plan a timer");
  assert.equal(h.published.at(-1)?.data?.value, "while-hidden", "the payload still lands");

  visible = true;
  assert.equal(h.loop.wake(), "ran");
  assert.equal(h.requests.length, 2);
  assert.equal(h.fake.pending(), 0);

  h.requests[1].deferred.resolve(payload("after-wake"));
  await flush();
  assert.equal(h.fake.pending(), 1, "polling resumes once visible");
});

test("a catch-up queued before the app hides is parked until the next visible wake", async () => {
  let visible = true;
  const h = createHarness({ isVisible: () => visible });

  // 1. Mounted and visible: exactly one request in flight.
  h.loop.start();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.visibleAtStart, [true]);

  // 2. A visible wake lands while that request is in flight: owed, not started.
  h.fake.advance(WAKE_COALESCE_MS + 1);
  assert.equal(h.loop.wake(), "queued");
  assert.equal(h.requests.length, 1, "the queued wake does not start a second request");

  // 3. The app goes to the background before the request settles.
  visible = false;

  // 4. The request settles hidden: the owed sync must not run behind the user's
  //    back, and no timer may be left planned while hidden.
  h.requests[0].deferred.resolve(payload("before-hide"));
  await flush();
  assert.equal(h.requests.length, 1, "B5: settling hidden does not start the owed catch-up");
  assert.equal(h.inFlight(), 0);
  assert.equal(h.fake.pending(), 0, "B5: a hidden loop keeps zero planned timers");
  assert.deepEqual(h.visibleAtStart, [true], "no request ever starts while hidden");
  assert.equal(h.published.at(-1)?.data?.value, "before-hide", "the payload still lands");

  // 5. Staying hidden changes nothing: a hidden wake re-parks without paying the
  //    catch-up, and still leaves no timer.
  h.fake.advance(300);
  assert.equal(h.loop.wake(), "parked");
  assert.equal(h.requests.length, 1, "a hidden wake never pays the parked catch-up");
  assert.equal(h.fake.pending(), 0);

  // 6. Back to visible: the very next wake pays the parked catch-up exactly
  //    once. It lands 300ms after the queued wake — inside WAKE_COALESCE_MS —
  //    and still runs, because parking is not a new wake.
  visible = true;
  assert.equal(h.loop.wake(), "ran");
  assert.equal(h.requests.length, 2, "the parked catch-up is paid exactly once");
  assert.equal(h.inFlight(), 1);
  assert.equal(h.peakConcurrency(), 1, "the catch-up never overlaps the first attempt");
  assert.equal(h.fake.pending(), 0, "no timer while the catch-up is in flight");
  assert.deepEqual(h.visibleAtStart, [true, true]);

  // 7. The sibling focus event that follows coming back is folded into this
  //    same sync, so the catch-up cannot be paid a second time.
  h.fake.advance(200);
  assert.equal(h.loop.wake(), "coalesced");
  assert.equal(h.requests.length, 2, "focus right after returning queues nothing more");

  // 8. When the catch-up settles the loop is back to exactly one timer.
  h.requests[1].deferred.resolve(payload("after-wake"));
  await flush();
  assert.equal(h.requests.length, 2, "the catch-up does not chain into a third request");
  assert.equal(h.fake.pending(), 1, "exactly one timer once idle again");
  assert.equal(h.inFlight(), 0);
  assert.equal(h.peakConcurrency(), 1);

  h.fake.advance(6_000);
  assert.equal(h.requests.length, 3, "normal polling resumes from the catch-up");
  assert.equal(h.peakConcurrency(), 1);
});

test("a catch-up parked by a failed attempt while hidden is still paid once visible", async () => {
  let visible = true;
  const h = createHarness({ isVisible: () => visible, retryDelay: 20_000 });

  h.loop.start();
  h.fake.advance(WAKE_COALESCE_MS + 1);
  assert.equal(h.loop.wake(), "queued");

  visible = false;
  h.requests[0].deferred.reject(new Error("upstream down"));
  await flush();
  assert.equal(h.published.at(-1)?.failed, true, "the failure is published as stale");
  assert.equal(h.requests.length, 1, "no retry is started while hidden");
  assert.equal(h.fake.pending(), 0, "no retry timer is planned while hidden");

  visible = true;
  assert.equal(h.loop.wake(), "ran", "the parked catch-up is paid before any retry backoff");
  assert.equal(h.requests.length, 2);
  assert.equal(h.fake.pending(), 0);
  assert.equal(h.peakConcurrency(), 1);

  h.requests[1].deferred.resolve(payload("recovered"));
  await flush();
  assert.equal(h.fake.pending(), 1, "exactly one timer once the catch-up succeeds");
  assert.equal(h.peakConcurrency(), 1);
});

test("a failed refresh keeps the last good payload and honours the retry floor", async () => {
  const h = createHarness({ nextDelay: () => 1_500, retryDelay: 20_000 });

  h.loop.start();
  h.requests[0].deferred.resolve(payload("good"));
  await flush();
  assert.equal(h.fake.pending(), 1);

  h.fake.advance(1_500);
  assert.equal(h.requests.length, 2);
  h.requests[1].deferred.reject(new Error("upstream down"));
  await flush();

  const last = h.published.at(-1);
  assert.equal(last?.failed, true, "the failure is published as stale, not as fresh data");
  assert.equal(last?.data?.value, "good", "the last good payload stays on screen");

  h.fake.advance(19_999);
  assert.equal(h.requests.length, 2, "the retry floor is respected");
  h.fake.advance(1);
  assert.equal(h.requests.length, 3, "the retry happens once the floor has passed");
});

test("null nextDelay stops the loop, and an explicit wake still syncs once", async () => {
  const h = createHarness({
    nextDelay: (data) => (data.value === "final" ? null : 6_000),
  });

  h.loop.start();
  h.requests[0].deferred.resolve(payload("final"));
  await flush();
  assert.equal(h.fake.pending(), 0, "a finished game stops the loop");

  assert.equal(h.loop.wake(), "ran");
  assert.equal(h.requests.length, 2);
  h.requests[1].deferred.resolve(payload("final"));
  await flush();
  assert.equal(h.fake.pending(), 0);
});

test("the published snapshot keeps receive time and upstream time apart", async () => {
  const h = createHarness();

  h.fake.advance(12_345);
  h.loop.start();
  h.requests[0].deferred.resolve(payload("x", "2026-10-11T02:00:00Z"));
  await flush();

  const last = h.published.at(-1);
  assert.equal(last?.failed, false);
  assert.equal(last?.sourceAt?.toISOString(), "2026-10-11T02:00:00.000Z");
  assert.equal(last?.receivedAt?.toISOString(), new Date(T0 + 12_345).toISOString());
  assert.equal(last?.key, KEY);
});
