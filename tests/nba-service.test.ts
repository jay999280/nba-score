/**
 * Service-layer degradation behaviour (R6-c), against injected upstream
 * responses — no network, no real CDN.
 *
 * What is asserted:
 *  - `getGamePlays` distinguishes "upstream has not published yet" from "we
 *    could not read it", and throws instead of inventing a pre-game page when
 *    no source can speak for the game at all;
 *  - the schedule's kept copy is served for a bounded window and marked
 *    degraded, then becomes unavailable;
 *  - `sourceAt` leaves the service as a valid ISO UTC instant even though the
 *    feed writes `"2026-10-10 01:14:25.1425"`.
 *
 * Not covered here: the real CDN failing (no fault injection against the live
 * origin), and the service worker's own cache path — see the delivery notes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { UpstreamError } from "../src/lib/nba/source.ts";
import { setUpstreamRequester } from "../src/lib/nba/source.ts";
import { getGameDetail, getGamePlays, listGames } from "../src/lib/nba/games.ts";
import { getScheduleIndexState } from "../src/lib/nba/schedule.ts";

const HOUR = 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Fixtures — minimal but structurally real upstream payloads.
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
    gameStatusText: gameStatus === 2 ? "Q4 6:21" : gameStatus === 3 ? "Final" : "7:30 pm ET",
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
    homeTeam: scheduleTeam(1610612747, "LAL", gameStatus === 1 ? 0 : 100),
    awayTeam: scheduleTeam(1610612744, "GSW", gameStatus === 1 ? 0 : 95),
  };
}

function schedulePayload(games) {
  return {
    leagueSchedule: {
      seasonYear: "2026",
      leagueId: "00",
      gameDates: [{ gameDate: "10/10/2026 00:00:00", games }],
    },
  };
}

function boxTeam(teamId, tricode, players) {
  return {
    teamId,
    teamName: tricode === "LAL" ? "Lakers" : "Warriors",
    teamCity: tricode === "LAL" ? "Los Angeles" : "Golden State",
    teamTricode: tricode,
    score: tricode === "LAL" ? 100 : 95,
    periods: [],
    players,
    statistics: {},
  };
}

function boxPayload(gameId, gameStatus, time, players = []) {
  return {
    meta: { time, code: 200 },
    game: {
      gameId,
      gameCode: `20261010/${gameId}`,
      gameStatus,
      gameStatusText: "Q4 6:21",
      period: 4,
      gameClock: "PT06M21.00S",
      gameTimeUTC: "2026-10-11T02:00:00Z",
      regulationPeriods: 4,
      duration: "",
      attendance: "18000",
      arena: { arenaName: "Crypto.com Arena", arenaCity: "Los Angeles", arenaState: "CA" },
      officials: [],
      homeTeam: boxTeam(1610612747, "LAL", players),
      awayTeam: boxTeam(1610612744, "GSW", []),
    },
  };
}

const ONE_ACTION = [
  {
    actionNumber: 7,
    clock: "PT06M21.00S",
    period: 4,
    teamId: 1610612747,
    teamTricode: "LAL",
    actionType: "3pt",
    subType: "Jump Shot",
    qualifiers: [],
    personId: 2544,
    playerName: "James",
    scoreHome: "100",
    scoreAway: "95",
    shotResult: "Made",
    shotDistance: 25,
    isFieldGoal: 1,
    x: 10,
    y: 40,
    description: "LeBron James 25' 3PT Jump Shot",
  },
];

function pbpPayload(gameId, gameStatus, actions) {
  return {
    meta: { time: "2026-10-10 01:14:25.1425", code: 200 },
    game: { gameId, gameStatus, actions },
  };
}

/* ------------------------------------------------------------------ *
 * Upstream stub
 * ------------------------------------------------------------------ */

let respond = () => ({ status: 404, text: "not found" });

setUpstreamRequester(async (url) => {
  const reply = respond(url);
  return reply ?? { status: 404, text: "not found" };
});

const SCHEDULE_URL = "scheduleLeagueV2_1.json";

/* ------------------------------------------------------------------ *
 * getGamePlays
 * ------------------------------------------------------------------ */

test("a game the schedule has not started yet is not-published", async () => {
  respond = (url) => {
    if (url.includes(SCHEDULE_URL)) {
      return {
        status: 200,
        text: JSON.stringify(
          schedulePayload([
            scheduleGame("0012600101", 1),
            scheduleGame("0012600102", 1),
            scheduleGame("0012600103", 2),
            scheduleGame("0012600104", 2),
          ]),
        ),
      };
    }
    return { status: 404, text: "not found" };
  };

  const plays = await getGamePlays("0012600101");

  assert.equal(plays.state, "not-published");
  assert.equal(plays.status, "upcoming");
  assert.equal(plays.freshness.scheduleOk, true, "the schedule did answer");
  assert.equal(plays.freshness.scoreboardOk, false, "no live feed answered");
  assert.equal(plays.freshness.kind, "partial");
  assert.equal(plays.freshness.revalidateFailed, false, "nothing has been published yet");
  assert.equal(plays.events.length, 0);
});

test("a started game with no readable feed is unavailable, not not-published", async () => {
  const plays = await getGamePlays("0012600103");

  assert.equal(plays.status, "live", "the schedule says the game is under way");
  assert.equal(plays.state, "unavailable", "a started game must never claim 'not published'");
  assert.equal(plays.freshness.scoreboardOk, false);
  assert.equal(plays.freshness.kind, "partial");
  assert.equal(plays.freshness.revalidateFailed, true, "the live feeds failed after tip-off");
});

test("a readable feed is ready and reports a valid ISO source time", async () => {
  respond = (url) => {
    if (url.includes("boxscore_0012600104")) {
      return {
        status: 200,
        text: JSON.stringify(
          boxPayload("0012600104", 2, "2026-10-10 01:14:25.1425", [
            { personId: 2544, name: "LeBron James", firstName: "LeBron", familyName: "James" },
          ]),
        ),
      };
    }
    if (url.includes("playbyplay_0012600104")) {
      return { status: 200, text: JSON.stringify(pbpPayload("0012600104", 2, ONE_ACTION)) };
    }
    return { status: 404, text: "not found" };
  };

  const plays = await getGamePlays("0012600104");

  assert.equal(plays.state, "ready");
  assert.equal(plays.status, "live");
  assert.equal(plays.events.length, 1);
  assert.equal(plays.freshness.scheduleOk, true);
  assert.equal(plays.freshness.scoreboardOk, true);
  assert.equal(plays.freshness.coverage, "full");
  assert.equal(plays.freshness.kind, "live");
  assert.equal(plays.freshness.revalidateFailed, false);
  assert.equal(plays.freshness.sourceAt, "2026-10-10T01:14:25.142Z");
  assert.equal(plays.freshness.sourceAt, new Date(plays.freshness.sourceAt).toISOString());
});

/* ------------------------------------------------------------------ *
 * Schedule last-good, and the all-sources-failed path
 * ------------------------------------------------------------------ */

test("a kept schedule is served degraded for a bounded window, then unavailable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  // The schedule fetched above is still inside its normal lifetime.
  const fresh = await getScheduleIndexState();
  assert.equal(fresh.degraded, false);
  assert.ok(fresh.index.byId.size >= 4);

  // Everything fails from here on.
  respond = () => ({ status: 503, text: "upstream down" });

  // Past the 6h lifetime but inside the 30-minute grace: the kept copy answers.
  t.mock.timers.tick(6 * HOUR + 10 * 60 * 1000);
  const kept = await getScheduleIndexState();
  assert.equal(kept.degraded, true, "a refresh failure keeps the last good index, marked");
  assert.equal(kept.index, fresh.index);

  const list = await listGames("2026-10-11T00:00:00Z", "2026-10-12T00:00:00Z");
  assert.equal(list.games.length, 4, "the kept schedule still enumerates the date");
  assert.equal(list.freshness.scheduleOk, true);
  assert.equal(list.freshness.scoreboardOk, false);
  assert.equal(list.freshness.coverage, "full");
  assert.equal(list.freshness.kind, "partial", "a kept copy is never classified live");
  assert.equal(list.freshness.revalidateFailed, true, "the refresh did fail");

  // Past the grace window the schedule is simply unavailable — every caller
  // must say so rather than keep serving an arbitrarily old season.
  t.mock.timers.tick(21 * 60 * 1000);
  const expired = await getScheduleIndexState().then(
    () => "resolved",
    () => "rejected",
  );
  assert.equal(expired, "rejected");

  // Nothing can speak for this game at all: play-by-play, box score and
  // schedule are all gone. This must be an upstream failure, and it must not
  // be dressed up as a pre-game "not published" with scheduleOk: true.
  const plays = await getGamePlays("0012600104").then(
    (value) => ({ resolved: true, value }),
    (error) => ({ resolved: false, error }),
  );
  assert.equal(plays.resolved, false, "an unknown game must throw, not fabricate a state");
  assert.ok(plays.error instanceof UpstreamError);

  const detail = await getGameDetail("0012600104").then(
    () => "resolved",
    () => "rejected",
  );
  assert.equal(detail, "rejected", "the detail page has no fixture to describe either");
});
