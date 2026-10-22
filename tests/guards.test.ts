/**
 * Upstream structural guards (R6-b).
 *
 * The guards sit in front of the cache and the normalize layer, so two
 * mistakes are equally expensive: accepting `[null]` (which crashes a
 * normalizer later, after the payload was written to the cache) and rejecting
 * a legal empty array (which turns "no games today" into an error page).
 *
 * The last test covers the cache contract directly: a payload that fails its
 * guard is a failed read, never a memoized value.
 *
 * The entry checks were tightened in round 2 (B4): a row that carries an id and
 * a status but no teams, no identifiable `teamId`, or no parseable tip-off used
 * to pass and normalized into a blank model. The shapes that must keep passing
 * are asserted next to them — empty arrays, TBD/延期 placeholders, missing
 * optional fields — because a guard that rejects the real season is worse than
 * the defect it fixes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isRawBoxScore,
  isRawPlayByPlay,
  isRawSchedule,
  isRawScoreboard,
} from "../src/lib/nba/guards.ts";
import { fetchSource, setUpstreamRequester } from "../src/lib/nba/source.ts";

const HOME = { teamId: 1610612747, teamTricode: "LAL" };
const AWAY = { teamId: 1610612744, teamTricode: "GSW" };
const TIPOFF = "2026-10-11T23:00:00Z";

/** A schedule row shaped like the real feed, minus everything optional. */
function scheduleGame(overrides = {}) {
  return {
    gameId: "0012600037",
    gameStatus: 3,
    gameDateTimeUTC: TIPOFF,
    gameTimeUTC: TIPOFF,
    homeTeam: HOME,
    awayTeam: AWAY,
    ...overrides,
  };
}

function scheduleWith(games: unknown[]) {
  return { leagueSchedule: { gameDates: [{ gameDate: "10/10/2026 00:00:00", games }] } };
}

/* ------------------------------------------------------------------ *
 * Scoreboard
 * ------------------------------------------------------------------ */

test("a scoreboard game must identify itself and carry both teams", () => {
  assert.equal(isRawScoreboard({ scoreboard: { games: [null] } }), false, "games:[null] is not a game");
  assert.equal(isRawScoreboard({ scoreboard: { games: [{}] } }), false, "no gameId/gameStatus");
  assert.equal(
    isRawScoreboard({
      scoreboard: { games: [{ gameId: "0012600037", gameStatus: 2, homeTeam: HOME, gameTimeUTC: TIPOFF }] },
    }),
    false,
    "a game without an away team cannot be normalized",
  );
  assert.equal(
    isRawScoreboard({
      scoreboard: {
        games: [{ gameId: "0012600037", gameStatus: 2, homeTeam: HOME, awayTeam: AWAY, gameTimeUTC: TIPOFF }],
      },
    }),
    true,
  );
});

test("an empty team object is not a team, however complete the rest of the row is", () => {
  const base = { gameId: "0012600037", gameStatus: 2, gameTimeUTC: TIPOFF };
  assert.equal(
    isRawScoreboard({ scoreboard: { games: [{ ...base, homeTeam: {}, awayTeam: {} }] } }),
    false,
    "both sides empty would normalize into two nameless teams",
  );
  assert.equal(isRawScoreboard({ scoreboard: { games: [{ ...base, homeTeam: HOME, awayTeam: {} }] } }), false);
  assert.equal(isRawScoreboard({ scoreboard: { games: [{ ...base, homeTeam: HOME, awayTeam: AWAY }] } }), true);
});

test("a scoreboard team must carry a numeric teamId", () => {
  const base = { gameId: "0012600037", gameStatus: 2, gameTimeUTC: TIPOFF };
  assert.equal(
    isRawScoreboard({ scoreboard: { games: [{ ...base, homeTeam: { teamTricode: "LAL" }, awayTeam: AWAY }] } }),
    false,
    "a team block without an id cannot be identified by the model",
  );
  assert.equal(
    isRawScoreboard({ scoreboard: { games: [{ ...base, homeTeam: { teamId: "1610612747" }, awayTeam: AWAY }] } }),
    false,
    "a string id is not an id",
  );
  assert.equal(
    isRawScoreboard({ scoreboard: { games: [{ ...base, homeTeam: { teamId: Number.NaN }, awayTeam: AWAY }] } }),
    false,
  );
});

test("a scoreboard game without a parseable tip-off is rejected", () => {
  const base = { gameId: "0012600037", gameStatus: 2, homeTeam: HOME, awayTeam: AWAY };
  assert.equal(
    isRawScoreboard({ scoreboard: { games: [{ ...base }] } }),
    false,
    "no gameTimeUTC: the window filter would drop the game silently",
  );
  assert.equal(isRawScoreboard({ scoreboard: { games: [{ ...base, gameTimeUTC: "" }] } }), false);
  assert.equal(isRawScoreboard({ scoreboard: { games: [{ ...base, gameTimeUTC: "not a date" }] } }), false);
  assert.equal(isRawScoreboard({ scoreboard: { games: [{ ...base, gameTimeUTC: TIPOFF }] } }), true);
});

test("an empty scoreboard is a legal answer, not a broken payload", () => {
  assert.equal(isRawScoreboard({ scoreboard: { games: [] } }), true);
});

test("a missing or non-object games array is invalid", () => {
  assert.equal(isRawScoreboard({ scoreboard: {} }), false);
  assert.equal(isRawScoreboard({ scoreboard: { games: "nope" } }), false);
  assert.equal(isRawScoreboard({}), false);
  assert.equal(isRawScoreboard(null), false);
});

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

test("a schedule date must carry a games array of real entries", () => {
  assert.equal(isRawSchedule({ leagueSchedule: { gameDates: [null] } }), false);
  assert.equal(isRawSchedule({ leagueSchedule: { gameDates: [{ games: [null] }] } }), false);
  assert.equal(isRawSchedule({ leagueSchedule: { gameDates: [{}] } }), false);
  assert.equal(
    isRawSchedule({ leagueSchedule: { gameDates: [{ gameDate: "10/10/2026 00:00:00", games: [{ gameId: "x" }] }] } }),
    false,
    "entries without a gameStatus cannot be normalized",
  );
  assert.equal(isRawSchedule(scheduleWith([scheduleGame()])), true);
});

test("a schedule entry with an id and a status but nothing else is rejected", () => {
  // The exact row the round-2 review slipped through: it normalizes into an
  // empty team name and a NaN tip-off, i.e. a blank card no date can select.
  assert.equal(
    isRawSchedule(scheduleWith([{ gameId: "0012600037", gameStatus: 1 }])),
    false,
    "no teams and no start time",
  );
  assert.equal(isRawSchedule(scheduleWith([{ gameId: "0012600037", gameStatus: 1, homeTeam: HOME, awayTeam: AWAY }])), false);
  assert.equal(isRawSchedule(scheduleWith([{ gameId: "0012600037", gameStatus: 1, gameDateTimeUTC: TIPOFF, gameTimeUTC: TIPOFF }])), false);
});

test("a schedule entry needs a numeric teamId on both sides", () => {
  assert.equal(isRawSchedule(scheduleWith([scheduleGame({ awayTeam: {} })])), false, "an empty team block is not a team");
  assert.equal(isRawSchedule(scheduleWith([scheduleGame({ homeTeam: { teamTricode: "LAL" } })])), false);
  assert.equal(isRawSchedule(scheduleWith([scheduleGame({ awayTeam: { teamId: "1610612744" } })])), false);
  assert.equal(isRawSchedule(scheduleWith([scheduleGame({ homeTeam: { teamId: Number.POSITIVE_INFINITY } })])), false);
});

test("a schedule entry needs a parseable tip-off", () => {
  assert.equal(
    isRawSchedule(scheduleWith([scheduleGame({ gameDateTimeUTC: undefined, gameTimeUTC: undefined })])),
    false,
    "no start time at all",
  );
  assert.equal(isRawSchedule(scheduleWith([scheduleGame({ gameDateTimeUTC: "", gameTimeUTC: "" })])), false);
  assert.equal(isRawSchedule(scheduleWith([scheduleGame({ gameDateTimeUTC: "nonsense", gameTimeUTC: "nonsense" })])), false);
  assert.equal(
    isRawSchedule(scheduleWith([scheduleGame({ gameDateTimeUTC: "nonsense", gameTimeUTC: TIPOFF })])),
    false,
    "the normalizer reads gameDateTimeUTC first, so a good fallback never saves a broken preferred field",
  );
  assert.equal(
    isRawSchedule(scheduleWith([scheduleGame({ gameDateTimeUTC: "", gameTimeUTC: TIPOFF })])),
    true,
    "an absent preferred field does fall through to gameTimeUTC",
  );
});

test("legal TBD placeholders from the real cup schedule stay legal", () => {
  // Measured on the real 2026-27 season (2026-10-11): 14 team blocks carry
  // `teamId: 0` with empty names for the Emirates NBA Cup knockout games whose
  // participants are still TBD. Rejecting them would reject the whole season.
  const tbd = { teamId: 0, teamName: "", teamCity: "", teamTricode: "", teamSlug: "", wins: 0, losses: 0, score: 0, seed: 0 };
  assert.equal(
    isRawSchedule(
      scheduleWith([
        {
          gameId: "0022601201",
          gameStatus: 1,
          gameStatusText: "TBD",
          gameLabel: "Emirates NBA Cup",
          postponedStatus: "N",
          gameDateTimeUTC: "2026-12-04T05:00:00Z",
          gameTimeUTC: "1900-01-01T05:00:00Z",
          homeTeam: tbd,
          awayTeam: tbd,
        },
      ]),
    ),
    true,
  );
});

test("a postponed fixture with an id, teams and a time stays legal", () => {
  assert.equal(
    isRawSchedule(
      scheduleWith([
        {
          gameId: "0012600100",
          gameStatus: 1,
          gameStatusText: "Postponed",
          postponedStatus: "P",
          gameDateTimeUTC: TIPOFF,
          gameTimeUTC: TIPOFF,
          homeTeam: { teamId: 1610612747 },
          awayTeam: { teamId: 1610612744 },
        },
      ]),
    ),
    true,
  );
});

test("the guard does not demand optional fields", () => {
  // wins/losses/periods/score/arenaName/gameLabel/seed are all read through
  // fallbacks by the normalizer, so a row carrying only the required four
  // fields must still pass.
  assert.equal(
    isRawSchedule(
      scheduleWith([
        { gameId: "0012600037", gameStatus: 2, gameDateTimeUTC: TIPOFF, homeTeam: { teamId: 1 }, awayTeam: { teamId: 2 } },
      ]),
    ),
    true,
  );
});

test("an empty schedule is a legal answer", () => {
  assert.equal(isRawSchedule({ leagueSchedule: { gameDates: [] } }), true);
  assert.equal(
    isRawSchedule({ leagueSchedule: { gameDates: [{ gameDate: "10/03/2026 00:00:00", games: [] }] } }),
    true,
  );
  assert.equal(
    isRawSchedule({ leagueSchedule: { gameDates: [{ games: [] }] } }),
    false,
    "the date key itself is dereferenced unguarded and must be present",
  );
});

/* ------------------------------------------------------------------ *
 * Box score
 * ------------------------------------------------------------------ */

test("a box score with two empty team objects is invalid", () => {
  assert.equal(isRawBoxScore({ game: { homeTeam: {}, awayTeam: {} } }), false);
  assert.equal(isRawBoxScore({ game: { homeTeam: HOME, awayTeam: {} } }), false);
  assert.equal(isRawBoxScore({ game: {} }), false);
  assert.equal(isRawBoxScore({}), false);
});

test("empty player lists are legal box scores", () => {
  assert.equal(isRawBoxScore({ game: { homeTeam: { players: [] }, awayTeam: { players: [] } } }), true);
  assert.equal(
    isRawBoxScore({
      game: {
        homeTeam: { players: [{ personId: 2544 }] },
        awayTeam: { players: [] },
      },
    }),
    true,
  );
});

test("a team block with a visible field is readable even without players", () => {
  assert.equal(
    isRawBoxScore({ game: { homeTeam: { teamId: 1610612747 }, awayTeam: { score: 94 } } }),
    true,
  );
});

/* ------------------------------------------------------------------ *
 * Play-by-play
 * ------------------------------------------------------------------ */

test("play-by-play must carry an actions array", () => {
  assert.equal(isRawPlayByPlay({ game: {} }), false);
  assert.equal(isRawPlayByPlay({ game: { actions: "nope" } }), false);
  assert.equal(isRawPlayByPlay({}), false);
});

test("an empty action list is legal; a null action is not", () => {
  assert.equal(isRawPlayByPlay({ game: { actions: [] } }), true);
  assert.equal(isRawPlayByPlay({ game: { actions: [null] } }), false);
  assert.equal(isRawPlayByPlay({ game: { actions: [{ actionNumber: 1 }] } }), true);
});

/* ------------------------------------------------------------------ *
 * The cache contract
 * ------------------------------------------------------------------ */

test("a structurally wrong payload is a failed read, never a cached value", async () => {
  let calls = 0;
  setUpstreamRequester(async () => {
    calls += 1;
    return { status: 200, text: JSON.stringify({ scoreboard: { games: [null] } }) };
  });

  await assert.rejects(
    () => fetchSource("test/guards/bad-structure.json", 300, 1_000, isRawScoreboard),
    /unexpected structure/,
    "a 200 with an unusable body is rejected",
  );
  assert.equal(calls, 2, "both origins were tried and neither was accepted");

  // Had the bad body been memoized as a valid payload, this call would resolve
  // with it. Resolving at all would be the bug; the check is that it does not.
  const second = await fetchSource("test/guards/bad-structure.json", 300, 1_000, isRawScoreboard).then(
    () => "resolved",
    () => "rejected",
  );
  assert.equal(second, "rejected", "the invalid payload never comes back as data");
});

test("a valid payload is cached, so a later failure cannot blank it out", async () => {
  let body = { scoreboard: { games: [] } };
  setUpstreamRequester(async () => ({ status: 200, text: JSON.stringify(body) }));

  const first = await fetchSource("test/guards/good-structure.json", 300, 1_000, isRawScoreboard);
  assert.deepEqual(first, { scoreboard: { games: [] } });

  // Upstream starts answering with garbage; the memoized valid copy still stands.
  body = { scoreboard: { games: [null] } };
  const second = await fetchSource("test/guards/good-structure.json", 300, 1_000, isRawScoreboard);
  assert.deepEqual(second, { scoreboard: { games: [] } });
});
