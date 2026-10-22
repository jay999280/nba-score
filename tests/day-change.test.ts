/**
 * R7 regression: the local-midnight chain behind `useLocalToday`.
 *
 * Two layers:
 *   1. the pure arithmetic — the delay to the next local midnight, including a
 *      half-hour zone (Asia/Kolkata) and a DST spring-forward day
 *      (America/New_York) — and the time-zone-change predicate;
 *   2. the focus / visibilitychange path itself, driven with stub event
 *      targets and a fake timer, because the reviewed defect was that a wake
 *      only notified the listener and left the timer aimed at the old zone.
 *
 * Time zones are simulated through `process.env.TZ`, which Node honours at
 * runtime; a zone the platform ignores skips its test with a diagnostic rather
 * than passing silently.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
  msUntilNextLocalMidnight,
  shouldRescheduleMidnight,
  subscribeToDayChange,
} from "../src/lib/client/use-games.ts";

/**
 * The zone this process started in. Restoring is done by *assigning* it back:
 * `delete process.env.TZ` does not reset V8's cached zone on this Node build,
 * so a test that deleted instead of assigning would leak its zone into the
 * next one.
 */
const HOST_ZONE = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

/**
 * Runs `body` with the process time zone set, and restores it afterwards.
 * `probeOffset` is the offset that zone must report on 2026-07-01.
 */
function withTimeZone(
  zone: string,
  probeOffset: number,
  t: TestContext,
  body: () => void,
): void {
  process.env.TZ = zone;
  try {
    const probe = new Date(2026, 6, 1).getTimezoneOffset();
    if (probe !== probeOffset) {
      t.diagnostic(`this Node build ignored TZ=${zone}`);
      t.skip(`TZ=${zone} is not honoured here (probe offset ${probe})`);
      return;
    }
    body();
  } finally {
    process.env.TZ = HOST_ZONE;
  }
}

test("the delay lands exactly on the next local midnight", () => {
  const now = new Date(2026, 9, 11, 13, 37, 12, 345);
  const delay = msUntilNextLocalMidnight(now);
  // The function adds 50ms of slack, so the target is the local midnight.
  const landed = new Date(now.getTime() + delay - 50);

  assert.equal(landed.getHours(), 0, "target is local midnight");
  assert.equal(landed.getMinutes(), 0);
  assert.equal(landed.getSeconds(), 0);
  assert.equal(landed.getMilliseconds(), 0);
  assert.equal(landed.getMonth(), 9);
  assert.equal(landed.getDate(), 12, "target is the *next* calendar day");
  assert.ok(delay > 0 && delay <= 24 * 3_600_000 + 60_000, `delay within a day: ${delay}`);
});

test("crossing midnight from 23:59:30 is a 30s wait, not a day", () => {
  const now = new Date(2026, 9, 11, 23, 59, 30, 0);
  assert.equal(msUntilNextLocalMidnight(now), 30_000 + 50);
});

test("a deadline 1ms away is clamped instead of firing in the past", () => {
  const now = new Date(2026, 9, 11, 23, 59, 59, 999);
  assert.equal(msUntilNextLocalMidnight(now), 1_000);
});

test("a half-hour zone keeps its :30 offset (Asia/Kolkata)", (t) => {
  withTimeZone("Asia/Kolkata", -330, t, () => {
    const now = new Date(2026, 9, 11, 23, 59, 30, 0);
    const delay = msUntilNextLocalMidnight(now);
    const landed = new Date(now.getTime() + delay - 50);

    assert.equal(delay, 30_000 + 50, "+05:30 midnight is 30s away");
    assert.equal(landed.getTimezoneOffset(), -330, "still UTC+05:30 at the target");
    assert.equal(landed.getDate(), 12);
    assert.equal(landed.getHours(), 0);
  });
});

test("a DST spring-forward day shortens the wait (America/New_York)", (t) => {
  withTimeZone("America/New_York", 240, t, () => {
    // A normal day: 7 Mar 12:00 EST → 8 Mar 00:00 EST is exactly 12h.
    assert.equal(
      msUntilNextLocalMidnight(new Date(2026, 2, 7, 12, 0, 0, 0)),
      43_200_000 + 50,
    );

    // 8 Mar 00:30 EST (05:30Z) → 9 Mar 00:00 EDT (04:00Z) is 22.5h, because
    // 02:00–03:00 local never happens.
    const before = new Date(2026, 2, 8, 0, 30, 0, 0);
    assert.equal(before.getTimezoneOffset(), 300, "precondition: still EST");

    const delay = msUntilNextLocalMidnight(before);
    assert.equal(delay, Date.UTC(2026, 2, 9, 4, 0, 0) - Date.UTC(2026, 2, 8, 5, 30, 0) + 50);
    assert.equal(delay, 81_000_000 + 50, "22.5 hours, not 24");
  });
});

test("shouldRescheduleMidnight fires only on a real offset change", () => {
  assert.equal(shouldRescheduleMidnight(-480, -480), false, "no change");
  assert.equal(shouldRescheduleMidnight(0, 0), false);
  assert.equal(shouldRescheduleMidnight(-480, -330), true, "Shanghai → Kolkata");
  assert.equal(shouldRescheduleMidnight(300, 240), true, "EST → EDT");
  assert.equal(shouldRescheduleMidnight(null, -480), true, "nothing to compare: re-arm");
  assert.equal(shouldRescheduleMidnight(undefined, -480), true);
  assert.equal(shouldRescheduleMidnight(Number.NaN, -480), true);
});

interface StubTarget {
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
  fire(type: string): void;
  count(type: string): number;
}

function createStubTarget(): StubTarget {
  const handlers = new Map<string, Set<() => void>>();
  return {
    addEventListener(type, handler) {
      const set = handlers.get(type) ?? new Set<() => void>();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener(type, handler) {
      handlers.get(type)?.delete(handler);
    },
    fire(type) {
      for (const handler of [...(handlers.get(type) ?? [])]) handler();
    },
    count(type) {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

interface ArmedTimer {
  delay: number;
  at: number;
}

interface StubWorld {
  document: StubTarget;
  window: StubTarget;
  armed(): ArmedTimer[];
}

function patchGlobal(name: string, value: unknown): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const previous = globals[name];
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  return () => {
    if (had) {
      Object.defineProperty(globalThis, name, { value: previous, writable: true, configurable: true });
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  };
}

/**
 * Replaces the timer functions and installs `document`/`window` stubs for the
 * duration of a synchronous body, then restores everything. The reviewed
 * subscription is real code; only its environment is faked.
 */
function withStubWorld(body: (world: StubWorld) => void): void {
  const timers = new Map<number, ArmedTimer>();
  let seq = 0;

  const fakeSetTimeout = ((handler: () => void, delay?: number) => {
    seq += 1;
    const wait = Number(delay ?? 0);
    timers.set(seq, { delay: wait, at: Date.now() + wait });
    void handler;
    return seq;
  }) as unknown as typeof setTimeout;

  const fakeClearTimeout = ((handle?: unknown) => {
    timers.delete(Number(handle));
  }) as unknown as typeof clearTimeout;

  const documentStub = createStubTarget();
  const windowStub = createStubTarget();

  const restores = [
    patchGlobal("setTimeout", fakeSetTimeout),
    patchGlobal("clearTimeout", fakeClearTimeout),
    patchGlobal("document", documentStub),
    patchGlobal("window", windowStub),
  ];

  try {
    body({ document: documentStub, window: windowStub, armed: () => [...timers.values()] });
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

test("a wake re-arms the midnight chain onto the current time zone", (t) => {
  const hostOffset = new Date().getTimezoneOffset();

  process.env.TZ = "Asia/Kolkata";
  const honoured = new Date().getTimezoneOffset() === -330;
  process.env.TZ = HOST_ZONE;
  const restored = new Date().getTimezoneOffset() === hostOffset;

  if (!honoured || !restored || hostOffset === -330) {
    t.skip(
      `needs runtime TZ support, a zone change that is detectable, and a host zone other than UTC+05:30 (host offset ${hostOffset})`,
    );
    return;
  }
  if (msUntilNextLocalMidnight(new Date()) < 5_000) {
    t.skip("running within 5s of local midnight; this test would race the boundary");
    return;
  }

  try {
    withStubWorld((world) => {
      const reads: number[] = [];
      const unsubscribe = subscribeToDayChange(() => reads.push(Date.now()));

      assert.equal(reads.length, 0, "subscribing does not notify");
      assert.equal(world.armed().length, 1, "one timer chain on subscribe");
      assert.equal(world.document.count("visibilitychange"), 1);
      assert.equal(world.window.count("focus"), 1);

      const initial = world.armed()[0];
      assert.ok(
        Math.abs(initial.delay - msUntilNextLocalMidnight(new Date())) < 1_000,
        `the first timer aims at the host zone's midnight (delay=${initial.delay})`,
      );

      // Returning to the app: the date is re-read, the chain stays single.
      world.window.fire("focus");
      assert.equal(reads.length, 1, "focus re-reads the date");
      assert.equal(world.armed().length, 1, "still exactly one timer");
      assert.equal(world.armed()[0].at, initial.at, "an unchanged zone does not restart the chain");

      // The phone is carried into another time zone: the target the old timer
      // was aimed at no longer exists, so the chain must be re-aimed.
      process.env.TZ = "Asia/Kolkata";
      assert.equal(new Date().getTimezoneOffset(), -330, "precondition: the zone switch took effect");
      world.document.fire("visibilitychange");

      assert.equal(reads.length, 2, "the wake still notifies the listener");
      assert.equal(world.armed().length, 1, "clearTimeout before setTimeout: one chain");

      const moved = world.armed()[0];
      assert.ok(
        Math.abs(moved.delay - msUntilNextLocalMidnight(new Date())) < 1_000,
        `re-armed onto the new zone (delay=${moved.delay})`,
      );
      assert.ok(
        Math.abs(moved.at - initial.at) > 3_600_000,
        `the deadline really moved (${initial.at} -> ${moved.at})`,
      );

      unsubscribe();
      assert.equal(world.armed().length, 0, "unsubscribe clears the chain");
      assert.equal(world.window.count("focus"), 0);
      assert.equal(world.document.count("visibilitychange"), 0);
    });
  } finally {
    process.env.TZ = HOST_ZONE;
  }
});
