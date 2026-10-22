/**
 * Provenance rules (R5, R6-a).
 *
 * Two claims are asserted here, and both were false before this round:
 *  - a payload that only partly answered, or that is a kept/cached copy, is
 *    never classified as this round's success;
 *  - a *degraded* payload cannot roll the list backwards, while a *complete*
 *    one is authoritative enough to accept a corrected (even lower) score.
 *
 * The upstream time format is covered here too: `sourceAt` is only useful if
 * it is a valid ISO instant, and the feed writes `"2026-10-10 01:14:25.1425"`,
 * which `Date.parse` reads as local time.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseUpstreamTime } from "../src/lib/format.ts";
import { activeSource } from "../src/lib/client/data-source.ts";
import {
  LIVE_STALE_MS,
  UPCOMING_STALE_MS,
  classifyFreshness,
  isPartialFreshness,
  isStaleFreshness,
  mergeGames,
} from "../src/lib/game-state.ts";
import { normalizeFreshness } from "../src/lib/types.ts";

function team(score, overrides = {}) {
  return {
    id: 1610612747,
    tricode: "LAL",
    city: "洛杉矶",
    name: "湖人",
    fullName: "洛杉矶湖人",
    score,
    winner: false,
    record: null,
    periods: [],
    logo: "/logos/1610612747.svg",
    color: "#7C4DDB",
    ...overrides,
  };
}

function game(overrides = {}) {
  return {
    id: "0012600037",
    status: "live",
    statusText: "第4节 · 6:21",
    period: 4,
    clock: "6:21",
    startTime: "2026-10-11T02:00:00Z",
    label: "常规赛",
    postponed: false,
    away: team(89, { id: 1610612744, tricode: "GSW", city: "金州", name: "勇士", fullName: "金州勇士" }),
    home: team(94),
    ...overrides,
  };
}

const LIVE = {
  sourceAt: "2026-10-11T02:00:00Z",
  coverage: "full",
  scoreboardOk: true,
  scheduleOk: true,
  kind: "live",
  revalidateFailed: false,
};

const PARTIAL = {
  sourceAt: "2026-10-11T02:00:00Z",
  coverage: "full",
  scoreboardOk: true,
  scheduleOk: false,
  kind: "partial",
  revalidateFailed: true,
};

/* ------------------------------------------------------------------ *
 * Upstream `meta.time`
 * ------------------------------------------------------------------ */

test("the space-separated upstream time is read as UTC, not local time", () => {
  const parsed = parseUpstreamTime("2026-10-10 01:14:25.1425");

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.toISOString(), "2026-10-10T01:14:25.142Z");
  assert.equal(parsed.getUTCHours(), 1, "the upstream hour is a UTC hour");
  assert.equal(parsed.getUTCMinutes(), 14);
  assert.equal(parsed.getUTCSeconds(), 25);
  assert.equal(parsed.getUTCMilliseconds(), 142);
});

test("the hour in the text survives as the UTC hour", () => {
  for (const hour of ["00", "07", "12", "23"]) {
    const parsed = parseUpstreamTime(`2026-10-10 ${hour}:30:00.0000`);
    assert.equal(parsed.getUTCHours(), Number(hour), `hour ${hour} must stay UTC`);
  }
});

test("an ISO value with T or a zone marker is parsed as ISO", () => {
  assert.equal(parseUpstreamTime("2026-10-10T01:14:25.142Z").toISOString(), "2026-10-10T01:14:25.142Z");
  assert.equal(
    parseUpstreamTime("2026-10-10T09:14:25+08:00").toISOString(),
    "2026-10-10T01:14:25.000Z",
  );
});

test("garbage in meta.time returns null instead of throwing", () => {
  for (const value of [null, undefined, "", "   ", "not a time", 42, {}, [], "2026-13-01 00:00:00", "2026-02-31 00:00:00"]) {
    assert.equal(parseUpstreamTime(value), null, `${JSON.stringify(value)} must not parse`);
  }
});

/* ------------------------------------------------------------------ *
 * Freshness classification
 * ------------------------------------------------------------------ */

test("only a round where every needed feed answered is classified live", () => {
  assert.deepEqual(classifyFreshness({ scoreboardOk: true, scheduleOk: true }), {
    kind: "live",
    revalidateFailed: false,
  });
});

test("a kept or cached copy is never classified live, even when complete", () => {
  assert.deepEqual(classifyFreshness({ scoreboardOk: true, scheduleOk: true, degraded: true }), {
    kind: "partial",
    revalidateFailed: true,
  });
  assert.deepEqual(classifyFreshness({ scoreboardOk: true, scheduleOk: true, lastGood: true }), {
    kind: "partial",
    revalidateFailed: true,
  });
});

test("a partly answered round is partial", () => {
  assert.equal(classifyFreshness({ scoreboardOk: true, scheduleOk: false }).kind, "partial");
  assert.equal(classifyFreshness({ scoreboardOk: false, scheduleOk: true }).kind, "partial");
});

test("nothing answered: last-good if a copy exists, unavailable otherwise", () => {
  assert.deepEqual(classifyFreshness({ scoreboardOk: false, scheduleOk: false, lastGood: true }), {
    kind: "last-good",
    revalidateFailed: true,
  });
  assert.deepEqual(classifyFreshness({ scoreboardOk: false, scheduleOk: false }), {
    kind: "unavailable",
    revalidateFailed: true,
  });
});

test("an older four-field freshness record is filled in, not rejected", () => {
  const legacy = { sourceAt: "2026-10-11T02:00:00Z", coverage: "full", scoreboardOk: true, scheduleOk: true };
  const filled = normalizeFreshness(legacy);

  assert.equal(filled.kind, "live");
  assert.equal(filled.revalidateFailed, false);
  assert.equal(filled.cachedAt, null);
  assert.equal(filled.sourceAt, legacy.sourceAt);
});

test("a malformed freshness record degrades to unavailable instead of throwing", () => {
  for (const value of [null, undefined, "boom", 7, []]) {
    const filled = normalizeFreshness(value);
    assert.equal(filled.kind, "unavailable");
    assert.equal(filled.coverage, "unknown");
    assert.equal(filled.sourceAt, null);
  }
});

test("partial means an incomplete window or a feed that did not answer", () => {
  assert.equal(isPartialFreshness(LIVE), false);
  assert.equal(isPartialFreshness(PARTIAL), true, "the schedule did not answer");
  assert.equal(isPartialFreshness({ ...LIVE, coverage: "partial" }), true);
  assert.equal(isPartialFreshness({ ...LIVE, coverage: "unknown" }), true);
  assert.equal(isPartialFreshness({ ...LIVE, scoreboardOk: false }), true);
  assert.equal(isPartialFreshness({ ...LIVE, scheduleOk: false }), true);
});

/* ------------------------------------------------------------------ *
 * Staleness
 * ------------------------------------------------------------------ */

test("a live game is stale once three polling cycles have passed", () => {
  const now = Date.parse("2026-10-11T02:05:00Z");
  const fresh = { ...LIVE, sourceAt: new Date(now - 30_000).toISOString() };
  const old = { ...LIVE, sourceAt: new Date(now - LIVE_STALE_MS - 1_000).toISOString() };

  assert.equal(isStaleFreshness(fresh, "live", now), false);
  assert.equal(isStaleFreshness(old, "live", now), true);
});

test("an upcoming game is not stale until ten minutes have passed", () => {
  const now = Date.parse("2026-10-11T02:05:00Z");
  const fresh = { ...LIVE, sourceAt: new Date(now - 5 * 60_000).toISOString() };
  const old = { ...LIVE, sourceAt: new Date(now - UPCOMING_STALE_MS - 1_000).toISOString() };

  assert.equal(isStaleFreshness(fresh, "upcoming", now), false);
  assert.equal(isStaleFreshness(old, "upcoming", now), true);
});

test("a final is never stale for being old — only for a failed revalidation", () => {
  const veryOld = { ...LIVE, sourceAt: "2026-10-09T01:14:25.142Z" };

  assert.equal(isStaleFreshness(veryOld, "final", Date.parse("2026-10-11T02:05:00Z")), false);
  assert.equal(isStaleFreshness({ ...veryOld, revalidateFailed: true }, "final"), true);
});

test("a cached or kept copy is stale regardless of what its timestamps say", () => {
  assert.equal(isStaleFreshness({ ...LIVE, kind: "cache" }, "live"), true);
  assert.equal(isStaleFreshness({ ...LIVE, kind: "last-good" }, "final"), true);
  assert.equal(isStaleFreshness({ ...LIVE, kind: "unavailable" }, "upcoming"), true);
  assert.equal(isStaleFreshness({ ...LIVE, sourceAt: null }, "live"), true, "an undated live payload is not fresh");
});

/* ------------------------------------------------------------------ *
 * mergeGames
 * ------------------------------------------------------------------ */

test("assertion 1: a complete round accepts the authoritative score correction", () => {
  const previous = [game({ status: "live", away: team(89, { id: 1610612744, tricode: "GSW" }), home: team(94) })];
  const corrected = [game({ status: "live", away: team(88, { id: 1610612744, tricode: "GSW" }), home: team(92) })];

  const { games, heldBack } = mergeGames(previous, corrected, LIVE);

  assert.equal(games[0].away.score, 88, "a lower, corrected score must be accepted");
  assert.equal(games[0].home.score, 92);
  assert.equal(games[0].status, "live");
  assert.equal(heldBack, 0, "nothing was held back from a complete round");
});

test("assertion 2: a degraded round cannot turn a live game back into upcoming", () => {
  const previous = [game({ status: "live", away: team(89), home: team(94) })];
  const stale = [
    game({ status: "upcoming", statusText: "19:30", period: 0, clock: null, away: team(null), home: team(null) }),
  ];

  const { games, heldBack } = mergeGames(previous, stale, PARTIAL);

  assert.equal(games[0].status, "live");
  assert.equal(games[0].away.score, 89);
  assert.equal(games[0].home.score, 94);
  assert.equal(heldBack, 1);
});

test("assertion 3: a degraded round cannot blank out a known score, period or clock", () => {
  const previous = [game({ status: "live", period: 4, clock: "6:21", statusText: "第4节 · 6:21" })];
  const stale = [
    game({ status: "live", statusText: "进行中", period: 0, clock: null, away: team(null), home: team(null) }),
  ];

  const { games } = mergeGames(previous, stale, PARTIAL);

  assert.equal(games[0].away.score, 89);
  assert.equal(games[0].home.score, 94);
  assert.equal(games[0].period, 4);
  assert.equal(games[0].clock, "6:21");
  assert.equal(games[0].statusText, "第4节 · 6:21", "the status line must match the numbers shown");
});

test("assertion 4: a degraded round cannot reopen a finished game", () => {
  const previous = [game({ status: "final", period: 4, clock: null })];
  const stale = [game({ status: "live", period: 4, clock: "2:00", away: team(88), home: team(92) })];

  const { games } = mergeGames(previous, stale, PARTIAL);

  assert.equal(games[0].status, "final");
  assert.equal(games[0].away.score, 89);
  assert.equal(games[0].home.score, 94);
});

test("a degraded round may still report progress it can see", () => {
  const previous = [game({ status: "live", period: 3, clock: "4:12", away: team(70, { id: 1610612744 }), home: team(74) })];
  const advanced = [
    game({ status: "live", period: 4, clock: "8:00", away: team(88, { id: 1610612744 }), home: team(92) }),
  ];

  const { games } = mergeGames(previous, advanced, PARTIAL);

  assert.equal(games[0].away.score, 88, "a higher score is progress, not a regression");
  assert.equal(games[0].home.score, 92);
  assert.equal(games[0].period, 4);
  assert.equal(games[0].clock, "8:00");
});

test("a degraded round cannot drop points it already knows about", () => {
  const previous = [game({ status: "live", away: team(89, { id: 1610612744 }), home: team(94) })];
  const behind = [game({ status: "live", away: team(80, { id: 1610612744 }), home: team(85) })];

  const { games } = mergeGames(previous, behind, PARTIAL);

  assert.equal(games[0].away.score, 89);
  assert.equal(games[0].home.score, 94);
});

test("a live payload with one side missing does not erase the other side", () => {
  const previous = [game({ status: "live", away: team(89, { id: 1610612744 }), home: team(94) })];
  const half = [game({ status: "live", away: team(null, { id: 1610612744 }), home: team(98) })];

  const { games } = mergeGames(previous, half, PARTIAL);

  assert.equal(games[0].away.score, 89, "a null side must not overwrite a known one");
  assert.equal(games[0].home.score, 98);
});

/* ------------------------------------------------------------------ *
 * Client: the service worker's marker reaching the app
 * ------------------------------------------------------------------ */

test("a service-worker cache hit reaches the client classified as cache", async () => {
  const original = globalThis.fetch;
  const served = {
    date: "2026-10-11",
    games: [],
    freshness: {
      sourceAt: "2026-10-09T01:14:25.142Z",
      coverage: "full",
      scoreboardOk: true,
      scheduleOk: true,
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify(served), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-DSH-From-Cache": "1",
        "X-DSH-Cached-At": "2026-10-09T01:20:00.000Z",
      },
    });

  try {
    const response = await activeSource().games("2026-10-11", new AbortController().signal);

    assert.equal(response.freshness.kind, "cache", "a replay must not look like a live read");
    assert.equal(response.freshness.cachedAt, "2026-10-09T01:20:00.000Z");
    assert.equal(
      response.freshness.sourceAt,
      "2026-10-09T01:14:25.142Z",
      "the upstream's own data time is left alone",
    );
    assert.equal(response.freshness.revalidateFailed, true);
    assert.equal(isStaleFreshness(response.freshness, "live"), true, "a replayed live score is stale");
  } finally {
    globalThis.fetch = original;
  }
});

test("a live answer is left exactly as the server sent it", async () => {
  const original = globalThis.fetch;
  const served = {
    date: "2026-10-11",
    games: [],
    freshness: {
      sourceAt: "2026-10-11T02:00:00Z",
      coverage: "full",
      scoreboardOk: true,
      scheduleOk: true,
      kind: "live",
      revalidateFailed: false,
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify(served), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const response = await activeSource().games("2026-10-11", new AbortController().signal);
    assert.deepEqual(response, served, "no client-side rewrite of a live payload");
  } finally {
    globalThis.fetch = original;
  }
});

test("offline standings retain their season and records but are explicitly stale", async () => {
  const original = globalThis.fetch;
  const served = {
    season: "2026-27", source: "ESPN", sourceAt: null,
    fetchedAt: "2026-10-25T02:00:00Z", state: "ready", stale: false,
    teams: [{ teamId: 1610612747, wins: 2, losses: 1, rank: 3 }],
  };
  globalThis.fetch = async () => new Response(JSON.stringify(served), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-DSH-From-Cache": "1" },
  });
  try {
    const result = await activeSource().standings(new AbortController().signal);
    assert.equal(result.stale, true);
    assert.equal(result.season, served.season);
    assert.deepEqual(result.teams, served.teams);
    assert.equal(result.fetchedAt, served.fetchedAt, "a replay must not invent a new fetch time");
  } finally {
    globalThis.fetch = original;
  }
});
