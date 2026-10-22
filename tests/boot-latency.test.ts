/**
 * Cold-start latency behaviour.
 *
 * The app used to paint the first screen only after the whole season schedule
 * (~7 MB) had been downloaded, parsed and indexed. The rules asserted here are
 * what replaced that: the live scoreboard may answer alone inside a caller's
 * budget, the payload says so honestly (`schedulePending`), and the list is
 * completed by the next poll instead of being presented as the whole truth.
 *
 * Also asserted: the device-side store degrades to "no cache" rather than
 * throwing where IndexedDB does not exist (the server, and this suite).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { setUpstreamRequester } from "../src/lib/nba/source.ts";
import { listGames } from "../src/lib/nba/games.ts";
import {
  loadPersistedSchedule,
  savePersistedSchedule,
} from "../src/lib/nba/schedule-store.ts";
import { classifyFreshness, freshnessNotice } from "../src/lib/game-state.ts";

/* ------------------------------------------------------------------ *
 * Fixtures — small, but shaped exactly like the real documents.
 * ------------------------------------------------------------------ */

function scheduleTeam(teamId, tricode, score) {
  return {
    teamId,
    teamName: tricode === "LAL" ? "Lakers" : "Warriors",
    teamCity: tricode === "LAL" ? "Los Angeles" : "Golden State",
    teamTricode: tricode,
    teamSlug: tricode.toLowerCase(),
    wins: 1,
    losses: 0,
    score,
    seed: 1,
  };
}

function scheduleGame(gameId, gameStatus) {
  return {
    gameId,
    gameCode: `20261010/${gameId}`,
    gameStatus,
    gameStatusText: gameStatus === 2 ? "Q4 6:21" : "7:30 pm ET",
    gameSequence: 1,
    gameDateEst: "2026-10-10T00:00:00Z",
    gameDateTimeUTC: "2026-10-11T02:00:00Z",
    gameDateUTC: "2026-10-11T02:00:00Z",
    gameTimeUTC: "2026-10-11T02:00:00Z",
    day: "20261010",
    monthNum: 10,
    gameLabel: "Regular Season",
    gameSubLabel: "",
    arenaName: "Crypto.com Arena",
    arenaCity: "Los Angeles",
    arenaState: "CA",
    postponedStatus: "",
    homeTeam: scheduleTeam(1610612747, "LAL", 100),
    awayTeam: scheduleTeam(1610612744, "GSW", 95),
  };
}

function schedulePayload() {
  return {
    meta: { time: "2026-10-10 01:14:25.1425", code: 200 },
    leagueSchedule: {
      seasonYear: "2026",
      leagueId: "00",
      gameDates: [{ gameDate: "10/10/2026 00:00:00", games: [scheduleGame("0022600001", 2)] }],
    },
  };
}

function scoreboardTeam(teamId, tricode, score) {
  return {
    teamId,
    teamName: tricode === "LAL" ? "Lakers" : "Warriors",
    teamCity: tricode === "LAL" ? "Los Angeles" : "Golden State",
    teamTricode: tricode,
    teamSlug: tricode.toLowerCase(),
    score,
    periods: [],
    wins: 1,
    losses: 0,
    seed: 1,
  };
}

function scoreboardPayload() {
  return {
    meta: { time: "2026-10-10 01:14:25.1425", code: 200 },
    scoreboard: {
      gameDate: "2026-10-10",
      leagueId: "00",
      leagueName: "NBA",
      games: [
        {
          gameId: "0022600001",
          gameCode: "20261010/0022600001",
          gameStatus: 2,
          gameStatusText: "Q4 6:21",
          period: 4,
          gameClock: "PT06M21.00S",
          gameTimeUTC: "2026-10-11T02:00:00Z",
          regulationPeriods: 4,
          gameLabel: "Regular Season",
          gameSubLabel: "",
          seriesGameNumber: "",
          seriesText: "",
          awayTeam: scoreboardTeam(1610612744, "GSW", 95),
          homeTeam: scoreboardTeam(1610612747, "LAL", 100),
        },
      ],
    },
  };
}

const FROM = "2026-10-11T00:00:00Z";
const TO = "2026-10-12T00:00:00Z";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * Slow schedule → fast, honest, partial answer.
 * ------------------------------------------------------------------ */

/**
 * Both the schedule and the scoreboard are asked in parallel; only the
 * schedule is allowed to be late. Deliberately below the 250 ms the schedule
 * takes, so the assertion is about the *budget winning*, not about speed.
 */
setUpstreamRequester(async (url) => {
  if (url.includes("scheduleLeagueV2_1.json")) {
    await delay(250);
    return { status: 200, text: JSON.stringify(schedulePayload()) };
  }
  if (url.includes("todaysScoreboard")) {
    return { status: 200, text: JSON.stringify(scoreboardPayload()) };
  }
  return { status: 404, text: "not found" };
});

test("a schedule that misses its budget yields a fast scoreboard-only payload", async () => {
  const started = Date.now();
  const payload = await listGames(FROM, TO, { scheduleDeadlineMs: 60 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 250, `answered before the schedule landed (took ${elapsed} ms)`);
  assert.equal(payload.games.length, 1, "the live feed alone still enumerates the date");
  assert.equal(payload.games[0].id, "0022600001");

  assert.equal(payload.freshness.schedulePending, true);
  assert.equal(payload.freshness.scheduleOk, false);
  assert.equal(payload.freshness.scoreboardOk, true);
  // This fixture window is a fixed past day, so the scoreboard cannot claim to
  // cover it: ignorance, not a partial answer. (On a real "today" window the
  // same path reports `partial`; that branch is exercised by the browser suite.)
  assert.equal(payload.freshness.coverage, "unknown");
  assert.equal(payload.freshness.kind, "partial");
  assert.equal(
    payload.freshness.revalidateFailed,
    false,
    "a feed that is late has not failed — no degraded-source warning",
  );
});

test("the next call completes from the schedule that has landed", async () => {
  await delay(300);

  const completed = await listGames(FROM, TO);

  assert.equal(completed.freshness.schedulePending, undefined);
  assert.equal(completed.freshness.scheduleOk, true);
  assert.equal(completed.freshness.coverage, "full");
  assert.equal(completed.freshness.kind, "live");
  assert.equal(completed.freshness.revalidateFailed, false);
  assert.equal(completed.games.length, 1);
});

/* ------------------------------------------------------------------ *
 * The honesty of the pending state.
 * ------------------------------------------------------------------ */

test("pending is classified as a not-yet, never as a failed refresh", () => {
  assert.deepEqual(
    classifyFreshness({ scoreboardOk: true, scheduleOk: false, pending: true }),
    { kind: "partial", revalidateFailed: false },
  );
  // A real failure keeps its own classification.
  assert.deepEqual(
    classifyFreshness({ scoreboardOk: true, scheduleOk: false }),
    { kind: "partial", revalidateFailed: false },
  );
  assert.deepEqual(
    classifyFreshness({ scoreboardOk: true, scheduleOk: false, degraded: true }),
    { kind: "partial", revalidateFailed: true },
  );
});

test("a pending payload says the schedule is loading, not that a source is missing", () => {
  const notice = freshnessNotice(
    {
      sourceAt: new Date().toISOString(),
      coverage: "partial",
      scoreboardOk: true,
      scheduleOk: false,
      kind: "partial",
      revalidateFailed: false,
      schedulePending: true,
    },
    [{ status: "live" }],
  );

  assert.equal(notice.tone, "partial");
  assert.equal(notice.badge, "", "not a degraded-source badge");
  assert.equal(notice.label, "赛程还在加载，先显示实时比分");
});

/* ------------------------------------------------------------------ *
 * Device store
 * ------------------------------------------------------------------ */

test("the persisted index degrades to no-cache where IndexedDB does not exist", async () => {
  // Node has no IndexedDB. The server relies on its process cache instead, and
  // neither path may throw: this runs on the request path of a web build.
  assert.equal(await loadPersistedSchedule(), null);
  await savePersistedSchedule({ entries: [], season: "2026", sourceAt: null, fetchedAt: Date.now() });
});
