/**
 * Pre-game comparison + lineups service, against injected upstream responses —
 * no network, no real NBA or ESPN feed.
 *
 * What is asserted:
 *  - the season conversion the app relies on (`2026-27` → ESPN season 2027) is
 *    what the requests actually ask for;
 *  - the two blocks are independently addressable: `section: "comparison"`
 *    never reads a box score, a roster or a player's statistics, and
 *    `section: "lineups"` never reads team statistics or the standings;
 *  - starters come from the most recent completed game, mapped to ESPN athlete
 *    ids through the roster, with per-game averages taken from `avg*` (not the
 *    season total that `value` carries);
 *  - a team with no completed game falls back to a positional roster list, and
 *    a missing box score falls back the same way;
 *  - every degradation stays explicit: no games → `no-games`, an unreadable
 *    statistics feed → `unavailable`, a player without data → null averages.
 *
 * The schedule index is process state, so one fixture schedule is installed on
 * the first call and reused by the rest of the file (the same way the service
 * behaves in a running app).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { UpstreamError, setUpstreamRequester } from "../src/lib/nba/source.ts";
import { getLineups, rosterFive } from "../src/lib/nba/lineups.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

/* ------------------------------------------------------------------ *
 * ESPN fixtures (shapes taken from the live endpoints on 2026-10-22)
 * ------------------------------------------------------------------ */

const ESPN = {
  LAL: 13,
  GSW: 9,
  CLE: 5,
  DEN: 7,
  BOS: 2,
  PHX: 21,
  SAC: 23,
  MIA: 14,
  POR: 22,
};

/** Minimal `{ splits: { categories: [...] } }` payload, as both ESPN stats endpoints send. */
function statsPayload(categories) {
  return { splits: { categories } };
}

function stat(name, value, displayValue) {
  return { name, value, displayValue: displayValue ?? String(value) };
}

const TEAM_STATS = {
  [ESPN.LAL]: statsPayload([
    {
      name: "general",
      stats: [stat("gamesPlayed", 1), stat("avgRebounds", 43.634148, "43.6")],
    },
    {
      name: "offensive",
      stats: [
        stat("avgPoints", 115.87805, "115.9"),
        stat("fieldGoalPct", 46.218, "46.2"),
        stat("threePointPct", 34.91, "34.9"),
        stat("avgAssists", 24.59756, "24.6"),
        stat("avgTurnovers", 12.97561, "13.0"),
      ],
    },
  ]),
};

/** A player's 2026-27 line: `avg*` present, as the real feed publishes it. */
function athleteStats({ points, rebounds, assists, gamesPlayed = 1 }) {
  return statsPayload([
    {
      name: "offensive",
      stats: [
        stat("gamesPlayed", gamesPlayed),
        stat("avgPoints", points, String(points)),
        stat("avgAssists", assists, String(assists)),
      ],
    },
    {
      name: "general",
      stats: [stat("avgRebounds", rebounds, String(rebounds))],
    },
  ]);
}

/**
 * A player's season totals WITHOUT `avg*` — the shape a naive reader mistakes
 * for averages. `statPerGame` must divide by games played instead.
 */
function athleteTotals({ points, rebounds, assists, gamesPlayed }) {
  return statsPayload([
    {
      name: "offensive",
      stats: [
        stat("gamesPlayed", gamesPlayed),
        stat("points", points),
        stat("assists", assists),
      ],
    },
    {
      name: "general",
      stats: [stat("rebounds", rebounds)],
    },
  ]);
}

const ATHLETE_STATS = {
  // Luka Doncic: averages straight from the source.
  3945274: athleteStats({ points: 28, rebounds: 8, assists: 7 }),
  // LeBron James: totals only — 2143/64 etc. is the fallback the trap needs.
  1966: athleteTotals({ points: 2143, rebounds: 495, assists: 530, gamesPlayed: 64 }),
  // Rui Hachimura: averages that exercise rounding.
  12345: athleteStats({ points: 12.5, rebounds: 4.25, assists: 1.75 }),
  // Austin Reaves and Deandre Ayton deliberately absent → 404 "No stats found."
};

function roster(teamName, athletes) {
  return {
    team: { displayName: teamName },
    athletes: athletes.map(([id, displayName, jersey, position]) => ({
      id,
      displayName,
      jersey,
      position: { abbreviation: position },
    })),
  };
}

const ROSTERS = {
  [ESPN.LAL]: roster("Los Angeles Lakers", [
    ["3945274", "Luka Doncic", "77", "G"],
    ["1966", "LeBron James", "23", "F"],
    ["4397", "Austin Reaves", "15", "G"],
    ["12345", "Rui Hachimura", "28", "F"],
    ["67890", "Deandre Ayton", "5", "C"],
  ]),
  [ESPN.GSW]: roster("Golden State Warriors", [
    ["201939", "Alpha Guard", "30", "G"],
    ["201940", "Bravo Guard", "1", "G"],
    ["201941", "Charlie Wing", "10", "F"],
    ["201942", "Delta Wing", "23", "F"],
    ["201943", "Echo Center", "45", "C"],
  ]),
  [ESPN.CLE]: roster("Cleveland Cavaliers", [
    ["301", "Guard One", "1", "G"],
    ["302", "Guard Two", "2", "G"],
    ["303", "Forward One", "3", "F"],
    ["304", "Forward Two", "4", "F"],
    ["305", "Center One", "5", "C"],
  ]),
  [ESPN.DEN]: roster("Denver Nuggets", [
    ["401", "Guard A", "11", "G"],
    ["402", "Guard B", "12", "G"],
    ["403", "Wing A", "13", "F"],
    ["404", "Wing B", "14", "F"],
    ["405", "Big A", "15", "C"],
  ]),
  [ESPN.MIA]: roster("Miami Heat", [
    ["501", "Heat Guard A", "1", "G"],
    ["502", "Heat Guard B", "2", "G"],
    ["503", "Heat Wing A", "3", "F"],
    ["504", "Heat Wing B", "4", "F"],
    ["505", "Heat Big", "5", "C"],
  ]),
  [ESPN.POR]: roster("Portland Trail Blazers", [
    ["601", "Blazer Guard A", "1", "G"],
    ["602", "Blazer Guard B", "2", "G"],
    ["603", "Blazer Wing A", "3", "F"],
    ["604", "Blazer Wing B", "4", "F"],
    ["605", "Blazer Big", "5", "C"],
  ]),
  [ESPN.PHX]: roster("Phoenix Suns", [
    ["701", "Suns Guard A", "1", "G"],
    ["702", "Suns Guard B", "2", "G"],
    ["703", "Suns Wing A", "3", "F"],
    ["704", "Suns Wing B", "4", "F"],
    ["705", "Suns Big", "5", "C"],
  ]),
  [ESPN.SAC]: roster("Sacramento Kings", [
    ["801", "Kings Guard A", "1", "G"],
    ["802", "Kings Guard B", "2", "G"],
    ["803", "Kings Wing A", "3", "F"],
    ["804", "Kings Wing B", "4", "F"],
    ["805", "Kings Big", "5", "C"],
  ]),
};

/**
 * The standings document both this feature and the standings page read.
 * Every entry needs wins/losses/winPercent/playoffSeed for the project's guard,
 * and `avgPointsAgainst` is the only opponent-scoring number ESPN publishes.
 */
function standingsPayload() {
  // [espn id, wins, losses, avgPointsAgainst] — every team, as the real feed has.
  const records = [];
  for (let id = 1; id <= 30; id += 1) records.push([id, 0, 1, 100]);
  const override = (id, wins, losses, against) => {
    records[id - 1] = [id, wins, losses, against];
  };
  override(ESPN.LAL, 1, 0, 110.3);
  override(ESPN.BOS, 1, 0, 101.2);
  override(ESPN.GSW, 0, 0, 0);
  override(ESPN.CLE, 0, 0, 0);
  override(ESPN.DEN, 0, 0, 0);
  override(ESPN.PHX, 1, 0, 105);
  override(ESPN.SAC, 0, 1, 100);
  override(ESPN.MIA, 1, 0, 99);
  override(ESPN.POR, 0, 1, 101);

  const entries = (slice) =>
    slice.map(([id, wins, losses, against], index) => ({
      team: { id: String(id), abbreviation: `T${id}` },
      stats: [
        stat("wins", wins),
        stat("losses", losses),
        stat("winPercent", wins / Math.max(1, wins + losses)),
        stat("playoffSeed", (index % 15) + 1),
        stat("avgPointsAgainst", against, String(against)),
      ],
    }));
  return {
    season: { year: 2027, displayName: "2026-27" },
    children: [
      {
        abbreviation: "East",
        standings: { season: 2027, seasonType: 2, entries: entries(records.slice(0, 15)) },
      },
      {
        abbreviation: "West",
        standings: { season: 2027, seasonType: 2, entries: entries(records.slice(15)) },
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * NBA fixture schedule and box score
 * ------------------------------------------------------------------ */

function scheduleTeam(teamId, tricode, teamName, teamCity, score) {
  return {
    teamId,
    teamName,
    teamCity,
    teamTricode: tricode,
    teamSlug: tricode.toLowerCase(),
    wins: 0,
    losses: 0,
    score,
    seed: 1,
  };
}

function scheduleGame(gameId, status, startUTC, away, home) {
  return {
    gameId,
    gameCode: `${startUTC.slice(0, 10).replace(/-/g, "")}/${gameId}`,
    gameStatus: status,
    gameStatusText: status === 3 ? "Final" : "7:00 pm ET",
    gameSequence: 1,
    gameDateEst: `${startUTC.slice(0, 10)}T00:00:00Z`,
    gameDateTimeUTC: startUTC,
    gameDateUTC: startUTC,
    gameTimeUTC: startUTC,
    day: startUTC.slice(0, 10).replace(/-/g, ""),
    monthNum: 10,
    gameLabel: "",
    gameSubLabel: "",
    arenaName: "Test Arena",
    arenaCity: "Test City",
    arenaState: "TS",
    postponedStatus: "N",
    homeTeam: home,
    awayTeam: away,
  };
}

const LAL = [1610612747, "LAL", "Lakers", "Los Angeles"];
const GSW = [1610612744, "GSW", "Warriors", "Golden State"];
const BOS = [1610612738, "BOS", "Celtics", "Boston"];
const CLE = [1610612739, "CLE", "Cavaliers", "Cleveland"];
const DEN = [1610612743, "DEN", "Nuggets", "Denver"];
const PHX = [1610612756, "PHX", "Suns", "Phoenix"];
const SAC = [1610612758, "SAC", "Kings", "Sacramento"];
const MIA = [1610612748, "MIA", "Heat", "Miami"];
const POR = [1610612757, "POR", "Trail Blazers", "Portland"];

function teamOf(team, score) {
  return scheduleTeam(team[0], team[1], team[2], team[3], score);
}

function schedulePayload() {
  const past = new Date(NOW - 48 * HOUR).toISOString();
  const past2 = new Date(NOW - 72 * HOUR).toISOString();
  const future = new Date(NOW + 24 * HOUR).toISOString();
  const future2 = new Date(NOW + 30 * HOUR).toISOString();
  const games = [
    // LAL's most recent completed regular-season game (the lineup source).
    scheduleGame("0022600400", 3, past, teamOf(BOS, 100), teamOf(LAL, 110)),
    // PHX/SAC and MIA/POR: completed games, used by the unavailable/failure paths.
    scheduleGame("0022600401", 3, past, teamOf(SAC, 101), teamOf(PHX, 105)),
    scheduleGame("0022600403", 3, past2, teamOf(POR, 98), teamOf(MIA, 102)),
    // The four preview games the tests ask about.
    scheduleGame("0022600500", 1, future, teamOf(LAL, 0), teamOf(GSW, 0)),
    scheduleGame("0022600502", 1, future, teamOf(CLE, 0), teamOf(DEN, 0)),
    scheduleGame("0022600503", 1, future2, teamOf(PHX, 0), teamOf(SAC, 0)),
    scheduleGame("0022600504", 1, future2, teamOf(MIA, 0), teamOf(POR, 0)),
  ];
  return {
    meta: { time: "2026-10-22 07:51:59.5159", code: 200 },
    leagueSchedule: {
      seasonYear: "2026-27",
      leagueId: "00",
      gameDates: [{ gameDate: "10/20/2026 00:00:00", games }],
    },
  };
}

function boxPlayer(personId, firstName, familyName, jerseyNum, position, starter) {
  return {
    personId,
    name: `${firstName} ${familyName}`,
    firstName,
    familyName,
    jerseyNum,
    position,
    starter: starter ? "1" : "0",
    status: "ACTIVE",
    played: "1",
    statistics: { minutes: "PT30M00.00S", points: 10, reboundsTotal: 5, assists: 3 },
  };
}

function boxTeam(team, score, players) {
  return {
    teamId: team[0],
    teamName: team[2],
    teamCity: team[3],
    teamTricode: team[1],
    score,
    periods: [],
    players,
    statistics: {},
  };
}

const LAL_BOX = {
  meta: { time: "2026-10-20 03:00:00.0000", code: 200 },
  game: {
    gameId: "0022600400",
    gameStatus: 3,
    gameStatusText: "Final",
    period: 4,
    gameClock: "",
    gameTimeUTC: new Date(NOW - 48 * HOUR).toISOString(),
    regulationPeriods: 4,
    duration: "",
    attendance: "18000",
    arena: { arenaName: "Test Arena", arenaCity: "Test City", arenaState: "TS" },
    officials: [],
    homeTeam: boxTeam(LAL, 110, [
      boxPlayer(3945274, "Luka", "Doncic", "77", "PG", true),
      boxPlayer(1966, "LeBron", "James", "23", "SF", true),
      boxPlayer(4397, "Austin", "Reaves", "15", "SG", true),
      boxPlayer(12345, "Rui", "Hachimura", "28", "PF", true),
      boxPlayer(67890, "Deandre", "Ayton", "5", "C", true),
      boxPlayer(9001, "Bench", "Guard", "9", "SG", false),
    ]),
    awayTeam: boxTeam(BOS, 100, []),
  },
};

/* ------------------------------------------------------------------ *
 * Upstream stub
 * ------------------------------------------------------------------ */

let respond = () => ({ status: 404, text: "not found" });
let requested = [];

setUpstreamRequester(async (url) => {
  requested.push(url);
  return respond(url) ?? { status: 404, text: "not found" };
});

function jsonResponse(status, body) {
  return { status, text: JSON.stringify(body) };
}

/** The responder every test starts from; individual tests override one branch. */
function defaultResponder(url) {
  if (url.includes("scheduleLeagueV2_1.json")) return jsonResponse(200, schedulePayload());
  if (url.includes("/standings?")) return jsonResponse(200, standingsPayload());

  const athlete = /\/athletes\/([^/]+)\/statistics/.exec(url);
  if (athlete) {
    const stats = ATHLETE_STATS[athlete[1]];
    return stats ? jsonResponse(200, stats) : { status: 404, text: '{"message":"No stats found."}' };
  }

  const teamStats = /\/teams\/(\d+)\/statistics/.exec(url);
  if (teamStats) {
    const stats = TEAM_STATS[Number(teamStats[1])];
    return stats ? jsonResponse(200, stats) : { status: 404, text: '{"message":"No stats found."}' };
  }

  const rosterMatch = /\/teams\/(\d+)\/roster/.exec(url);
  if (rosterMatch) {
    const body = ROSTERS[Number(rosterMatch[1])];
    return body ? jsonResponse(200, body) : { status: 404, text: "not found" };
  }

  if (url.includes("boxscore_0022600400")) return jsonResponse(200, LAL_BOX);

  return { status: 404, text: "not found" };
}

respond = defaultResponder;

async function capture(action) {
  requested = [];
  const value = await action();
  return { value, urls: [...requested] };
}

/* ------------------------------------------------------------------ *
 * Roster fallback ordering (pure)
 * ------------------------------------------------------------------ */

test("the roster fallback covers positions: two guards, two forwards, one center", () => {
  const athletes = ROSTERS[ESPN.GSW].athletes.map((athlete) => ({
    espnId: athlete.id,
    displayName: athlete.displayName,
    jersey: athlete.jersey,
    position: athlete.position.abbreviation,
  }));
  const five = rosterFive(athletes);
  assert.equal(five.length, 5);
  assert.deepEqual(
    five.map((athlete) => athlete.position),
    ["G", "G", "F", "F", "C"],
  );

  // A short group is filled from whoever is left instead of shrinking the row count.
  const short = rosterFive([
    { espnId: "1", displayName: "Only Guard", jersey: "1", position: "G" },
    { espnId: "2", displayName: "Only Forward", jersey: "2", position: "F" },
    { espnId: "3", displayName: "Only Center", jersey: "3", position: "C" },
    { espnId: "4", displayName: "Extra Forward", jersey: "4", position: "F" },
  ]);
  assert.equal(short.length, 4, "never invents a player who is not on the roster");
  assert.equal(new Set(short.map((athlete) => athlete.espnId)).size, 4);
});

/* ------------------------------------------------------------------ *
 * The comparison section
 * ------------------------------------------------------------------ */

test("the comparison asks for the ESPN season and never reads a lineup", async () => {
  const { value, urls } = await capture(() =>
    getLineups("0022600502", { section: "comparison" }),
  );

  assert.equal(value.season, "2026-27");
  assert.equal(value.comparison.state, "no-games", "CLE and DEN have not played a regular-season game");
  assert.deepEqual(value.comparison.sides, { away: "no-games", home: "no-games" });
  assert.deepEqual(value.comparison.rows, [], "no dash table for a season with no games");
  assert.equal(value.lineups.away.basis, "unavailable", "the lazy half is not computed");
  assert.equal(value.lineups.home.basis, "unavailable");

  // 2026-27 → ESPN's 2027 season, keyed by ESPN team id (CLE 5, DEN 7).
  assert.ok(urls.some((url) => url.includes("/seasons/2027/types/2/teams/5/statistics")));
  assert.ok(urls.some((url) => url.includes("/seasons/2027/types/2/teams/7/statistics")));
  // One standings read serves both teams' points allowed.
  assert.equal(urls.filter((url) => url.includes("/standings?")).length, 1);
  // The lazy half must not be paid for: no box score, roster or athlete read.
  assert.equal(urls.filter((url) => url.includes("/roster")).length, 0);
  assert.equal(urls.filter((url) => url.includes("boxscore_")).length, 0);
  assert.equal(urls.filter((url) => url.includes("/athletes/")).length, 0);
});

test("the lineups section never reads team statistics or the standings", async () => {
  const { value, urls } = await capture(() =>
    getLineups("0022600502", { section: "lineups" }),
  );

  assert.equal(value.comparison.state, "unavailable", "not computed, not fabricated");
  assert.equal(value.lineups.away.basis, "roster", "CLE has no completed game yet");
  assert.equal(value.lineups.home.basis, "roster", "DEN has no completed game yet");
  assert.equal(value.lineups.away.completedGames, 0);

  assert.equal(urls.filter((url) => /teams\/\d+\/statistics/.test(url)).length, 0);
  assert.equal(urls.filter((url) => url.includes("/standings?")).length, 0);
  assert.ok(urls.some((url) => url.includes("/teams/5/roster")));
  assert.ok(urls.some((url) => url.includes("/teams/7/roster")));

  // A roster fallback still tries the player's season line; ESPN says 404 and
  // the row stays "no season data" instead of failing.
  for (const lineup of [value.lineups.away, value.lineups.home]) {
    assert.equal(lineup.players.length, 5);
    for (const player of lineup.players) assert.equal(player.points, null);
  }
});

/* ------------------------------------------------------------------ *
 * Last completed game → ESPN athlete averages
 * ------------------------------------------------------------------ */

test("a team's starters come from its last completed game, with per-game averages", async () => {
  const { value, urls } = await capture(() => getLineups("0022600500"));

  const away = value.lineups.away;
  assert.equal(away.basis, "last-game");
  assert.ok(away.sourceGame, "the completed game is named in the payload");
  assert.equal(away.sourceGame.id, "0022600400");
  assert.equal(away.sourceGame.opponentTricode, "BOS");
  assert.equal(away.sourceGame.label, "常规赛");
  assert.equal(away.completedGames, 1);
  assert.equal(away.players.length, 5);

  const [doncic, james, reaves, hachimura, ayton] = away.players;
  // The ESPN roster maps the NBA box score's personId to an ESPN athlete id.
  assert.equal(doncic.name, "卢卡·东契奇");
  assert.equal(doncic.espnId, "3945274");
  assert.equal(doncic.position, "PG");
  assert.equal(doncic.jersey, "77");
  assert.deepEqual(
    { points: doncic.points, rebounds: doncic.rebounds, assists: doncic.assists },
    { points: 28, rebounds: 8, assists: 7 },
  );

  // `avg*` is missing here: the total must be divided by games played (64),
  // never shown raw (2143 points would be a decade, not an average).
  assert.equal(james.espnId, "1966");
  assert.equal(james.points, 33.5);
  assert.equal(james.rebounds, 7.7);
  assert.equal(james.assists, 8.3);

  // Averages are rounded once, not truncated.
  assert.equal(hachimura.points, 12.5);
  assert.equal(hachimura.rebounds, 4.3);
  assert.equal(hachimura.assists, 1.8);

  // ESPN answers 404 for a player with no regular-season game: no averages,
  // and the player is still listed because the box score named him.
  assert.equal(reaves.name, "奥斯汀·里夫斯");
  assert.equal(reaves.points, null);
  assert.equal(reaves.rebounds, null);
  assert.equal(ayton.name, "德安德烈·艾顿");
  assert.equal(ayton.points, null);

  // The home side has no completed game at all, so it falls back to the roster.
  const home = value.lineups.home;
  assert.equal(home.basis, "roster");
  assert.equal(home.completedGames, 0);
  assert.equal(home.sourceGame, null);
  assert.deepEqual(
    home.players.map((player) => player.position),
    ["G", "G", "F", "F", "C"],
  );

  // Requests prove the ESPN mapping and the season conversion.
  assert.ok(urls.some((url) => url.includes("boxscore_0022600400.json")));
  assert.ok(urls.some((url) => url.includes("/teams/13/roster")), "LAL → ESPN 13");
  assert.ok(urls.some((url) => url.includes("/teams/9/roster")), "GSW → ESPN 9");
  assert.ok(urls.some((url) => url.includes("/athletes/3945274/statistics")));
  assert.ok(urls.some((url) => url.includes("/athletes/201939/statistics")), "roster fallback players get a stats read too");
});

/* ------------------------------------------------------------------ *
 * The comparison payload itself
 * ------------------------------------------------------------------ */

test("the comparison formats per-game averages, percentages and points allowed", async () => {
  const { value } = await capture(() => getLineups("0022600500", { section: "comparison" }));
  const comparison = value.comparison;

  assert.equal(comparison.season, "2026-27");
  assert.equal(comparison.state, "ready");
  assert.deepEqual(comparison.sides, { away: "ready", home: "no-games" });
  assert.deepEqual(
    comparison.rows.map((row) => row.label),
    ["场均得分", "场均失分", "投篮命中率", "三分命中率", "场均篮板", "场均助攻", "场均失误"],
  );

  const row = (key) => comparison.rows.find((entry) => entry.key === key);
  assert.equal(row("points").away, "115.9");
  // Points allowed comes from the standings document (the only ESPN source for it).
  assert.equal(row("points-allowed").away, "110.3");
  assert.equal(row("field-goal-pct").away, "46.2%");
  assert.equal(row("three-point-pct").away, "34.9%");
  assert.equal(row("rebounds").away, "43.6");
  assert.equal(row("assists").away, "24.6");
  assert.equal(row("turnovers").away, "13.0");

  // Golden State has no completed game, so every one of its cells is blank —
  // never a zero that would read as a real average.
  for (const entry of comparison.rows) assert.equal(entry.home, null);
});

test("games exist but the statistics feed fails: unavailable, not no-games", async () => {
  respond = (url) => {
    if (url.includes("/standings?")) return jsonResponse(200, standingsPayload());
    if (/\/teams\/(21|23)\/statistics/.test(url)) return { status: 500, text: "upstream down" };
    if (url.includes("scheduleLeagueV2_1.json")) return jsonResponse(200, schedulePayload());
    return defaultResponder(url);
  };
  try {
    const { value } = await capture(() => getLineups("0022600503", { section: "comparison" }));
    assert.equal(value.comparison.state, "unavailable");
    assert.deepEqual(value.comparison.sides, { away: "unavailable", home: "unavailable" });
    assert.deepEqual(value.comparison.rows, []);
  } finally {
    respond = defaultResponder;
  }
});

/* ------------------------------------------------------------------ *
 * Degradation and hard failures
 * ------------------------------------------------------------------ */

test("a missing box score falls back to the roster, and says the team has played", async () => {
  respond = (url) => {
    if (url.includes("boxscore_0022600403")) return { status: 403, text: "<html>forbidden</html>" };
    return defaultResponder(url);
  };
  try {
    const { value } = await capture(() => getLineups("0022600504", { section: "lineups" }));
    for (const lineup of [value.lineups.away, value.lineups.home]) {
      assert.equal(lineup.basis, "roster");
      assert.equal(lineup.completedGames, 1, "the schedule knows the game happened");
      assert.equal(lineup.sourceGame, null);
      assert.equal(lineup.players.length, 5);
    }
  } finally {
    respond = defaultResponder;
  }
});

test("a game the schedule does not list has no honest answer", async () => {
  await assert.rejects(
    () => getLineups("0099999999"),
    (error) => error instanceof UpstreamError,
  );
});
