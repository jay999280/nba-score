import assert from "node:assert/strict";
import test from "node:test";
import type { Game, TeamSide } from "../src/lib/types.ts";
import { gameStageFor, gameStageLabel } from "../src/lib/nba/game-stage.ts";
import { normalizeBoxScore, normalizeScoreboardGame } from "../src/lib/nba/normalize.ts";
import type { RawBoxScore, RawScoreboardGame } from "../src/lib/nba/raw.ts";
import { playoffSeriesFor } from "../src/lib/nba/series.ts";
import type { ScheduleEntry, ScheduleIndex } from "../src/lib/nba/schedule.ts";

function team(id: number, score: number | null, winner: boolean, record: string | null = "10-8"): TeamSide {
  return {
    id, tricode: id === 1 ? "AAA" : "BBB", city: "城市", name: "球队", fullName: "城市球队",
    score, winner, record, periods: [], logo: "", color: "#000000",
  };
}

function game(id: string, date: string, homeId: number, awayId: number, winner: "home" | "away" | null): Game {
  return {
    id, status: winner ? "final" : "upcoming", statusText: winner ? "已结束" : "", period: 0,
    clock: null, startTime: date, label: "季后赛", stage: "playoffs", series: null, postponed: false,
    home: team(homeId, winner ? (winner === "home" ? 101 : 98) : null, winner === "home"),
    away: team(awayId, winner ? (winner === "away" ? 101 : 98) : null, winner === "away"),
  };
}

function indexOf(games: Game[], season = "2025-26"): ScheduleIndex {
  const entries: ScheduleEntry[] = games.map((game) => ({ game, etDate: game.startTime.slice(0, 10), startTime: game.startTime, arena: null }));
  return { entries, byId: new Map(entries.map((entry) => [entry.game.id, entry])), season, sourceAt: "2026-10-12T06:44:13Z" };
}

function scoreboard(id: string, label: string, subLabel = ""): RawScoreboardGame {
  const side = (teamId: number) => ({
    teamId, teamName: "Team", teamCity: "City", teamTricode: teamId === 1 ? "AAA" : "BBB",
    wins: 42, losses: 20, score: 103, periods: [],
  });
  return {
    gameId: id, gameCode: id, gameStatus: 3, gameStatusText: "Final", period: 4, gameClock: "",
    gameTimeUTC: "2025-01-01T00:00:00Z", regulationPeriods: 4, gameLabel: label, gameSubLabel: subLabel,
    homeTeam: side(1), awayTeam: side(2),
  };
}

function boxScore(id: string): RawBoxScore {
  const stats = {
    points: 103, reboundsTotal: 40, reboundsOffensive: 8, assists: 20, turnovers: 12,
    steals: 6, blocks: 4, fieldGoalsPercentage: 0.5, threePointersPercentage: 0.35,
    freeThrowsPercentage: 0.8, fieldGoalsMade: 40, fieldGoalsAttempted: 80,
    threePointersMade: 10, threePointersAttempted: 30, freeThrowsMade: 13,
    freeThrowsAttempted: 16, pointsInThePaint: 44, pointsFastBreak: 12,
    pointsFromTurnovers: 10, benchPoints: 28, biggestLead: 12,
  };
  const side = (teamId: number) => ({
    teamId, teamName: "Team", teamCity: "City", teamTricode: teamId === 1 ? "AAA" : "BBB",
    score: 103, periods: [], players: [], statistics: stats,
  });
  return {
    meta: { time: "2025-01-01T00:00:00Z", code: 200 },
    game: {
      gameId: id, gameCode: id, gameStatus: 3, gameStatusText: "Final", period: 4,
      gameClock: "PT00M00.00S", gameTimeUTC: "2025-01-01T00:00:00Z", regulationPeriods: 4,
      duration: "120", attendance: "0", arena: { arenaName: "Arena", arenaCity: "City", arenaState: "ST" },
      officials: [], homeTeam: side(1), awayTeam: side(2),
    },
  } as RawBoxScore;
}

test("game ids and official labels produce a Chinese type, including labels omitted by regular season", () => {
  assert.equal(gameStageFor("0012600004", "Preseason"), "preseason");
  assert.equal(gameStageFor("0022600015", "Emirates NBA Cup", "East Group C"), "regular-season");
  assert.equal(gameStageFor("0022600001", "", ""), "regular-season");
  assert.equal(gameStageFor("0042500101", "Playoffs"), "playoffs");
  assert.equal(gameStageFor("0052500001", "Play-In"), "play-in");
  assert.equal(gameStageFor("0062600001", "Emirates NBA Cup", "Championship"), "nba-cup-final");
  assert.equal(gameStageFor("0022601229", "Emirates NBA Cup", "Semifinal"), "regular-season");
  assert.equal(gameStageFor("0022601201", "Emirates NBA Cup", "Quarterfinal"), "regular-season");
  assert.equal(gameStageFor("0032500001", "All-Star"), "all-star");
  assert.equal(gameStageFor("1522500001", "Summer League"), "summer-league");
  assert.equal(gameStageLabel("unknown"), "比赛类型待确认");
});

test("normalization keeps records only for regular-season games and always labels the stage", () => {
  const preseason = normalizeScoreboardGame(scoreboard("0012600004", "Preseason"));
  const regular = normalizeScoreboardGame(scoreboard("0022600001", ""));
  const cupFinal = normalizeScoreboardGame(scoreboard("0062600001", "Emirates NBA Cup", "Championship"));
  assert.equal(preseason.label, "季前赛");
  assert.equal(preseason.home.record, null);
  assert.equal(regular.label, "常规赛");
  assert.equal(regular.home.record, "42-20");
  assert.equal(cupFinal.label, "NBA杯决赛");
  assert.equal(cupFinal.home.record, null);
});

test("box score detail uses the game id and schedule label to set stage and type label", () => {
  const detail = normalizeBoxScore(boxScore("0062600001"), { label: "NBA杯决赛" });
  assert.equal(detail.stage, "nba-cup-final");
  assert.equal(detail.label, "NBA杯决赛");
  assert.equal(detail.home.record, null);
});

test("playoff series follows the official series id, maps home swaps, and ignores later games", () => {
  const games = [
    game("0042500101", "2026-04-20T00:00:00Z", 1, 2, "home"),
    game("0042500102", "2026-04-22T00:00:00Z", 2, 1, "away"),
    game("0042500103", "2026-04-24T00:00:00Z", 1, 2, null),
    game("0042500104", "2026-04-26T00:00:00Z", 2, 1, "home"),
    game("0042500201", "2026-04-21T00:00:00Z", 3, 4, "home"),
    game("0042400101", "2025-04-20T00:00:00Z", 1, 2, "away"),
    game("0022500101", "2026-04-19T00:00:00Z", 1, 2, "away"),
  ];
  const result = playoffSeriesFor(games[2], indexOf(games));
  assert.deepEqual(result, { homeWins: 2, awayWins: 0, gameNumber: 3, round: "首轮", source: "schedule" });
});

test("an incomplete round and non-playoff stage do not fabricate a playoff score", () => {
  const gameThree = game("0042500103", "2026-04-24T00:00:00Z", 1, 2, null);
  assert.equal(playoffSeriesFor(gameThree, indexOf([gameThree])), null);
  assert.deepEqual(
    playoffSeriesFor(game("0042500101", "2026-04-20T00:00:00Z", 1, 2, null), indexOf([
      game("0042500101", "2026-04-20T00:00:00Z", 1, 2, null),
    ])),
    { homeWins: 0, awayWins: 0, gameNumber: 1, round: "首轮", source: "schedule" },
  );
  assert.equal(playoffSeriesFor({ ...gameThree, stage: "regular-season" }, indexOf([gameThree])), null);
  assert.equal(playoffSeriesFor({ ...gameThree, id: "0062600001", stage: "nba-cup-final" }, indexOf([gameThree])), null);
  assert.equal(playoffSeriesFor(gameThree, indexOf([game("0042500101", "2026-04-20T00:00:00Z", 1, 2, "home")], "2024-25")), null);
  assert.equal(playoffSeriesFor(game("0042500102", "2026-04-22T00:00:00Z", 2, 1, "home"), indexOf([
    game("0042500101", "2026-04-20T00:00:00Z", 1, 2, null),
    game("0042500102", "2026-04-22T00:00:00Z", 2, 1, "home"),
  ])), null);
  assert.equal(playoffSeriesFor(game("0042500102", "2026-04-22T00:00:00Z", 2, 1, "home"), indexOf([
    { ...game("0042500101", "2026-04-20T00:00:00Z", 1, 2, null), status: "final" },
    { ...game("0042500102", "2026-04-22T00:00:00Z", 2, 1, null), status: "final" },
  ])), null);
});

test("official playoff ID round codes map to the four NBA rounds", () => {
  const expected = new Map([
    ["0042400101", "首轮"],
    ["0042400201", "分区半决赛"],
    ["0042400301", "分区决赛"],
    ["0042400401", "总决赛"],
  ]);
  for (const [id, round] of expected) {
    const current = game(id, "2025-06-05T00:00:00Z", 1, 2, null);
    assert.equal(playoffSeriesFor(current, indexOf([current], "2024-25"))?.round, round, id);
  }
});
