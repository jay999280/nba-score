/**
 * The rules that decide what a payload is allowed to claim.
 *
 * These cover the two degradation defects the review reproduced with the real
 * service code: a live game coming back as "upcoming" after the live feed
 * failed, and an empty list being reported as "no games" when the schedule was
 * simply unreachable.
 *
 * Round 2 added the per-team, per-period half of the same rule (B3): a weak
 * source may add what it saw, but it may not take back a point we already
 * published for one team, and inside a period it may not move the clock
 * backwards. The authoritative contrast is asserted next to them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boxAvailability,
  detailAvailability,
  emptyListMeaning,
  mergeGames,
  statusRank,
} from "../src/lib/game-state.ts";

function game(overrides = {}) {
  return {
    id: "0012609999",
    status: "live",
    statusText: "进行中",
    period: 3,
    clock: "4:12",
    startTime: "2026-10-10T23:00:00Z",
    label: "常规赛",
    postponed: false,
    away: { id: 1610612744, tricode: "GSW", city: "金州", name: "勇士", fullName: "金州勇士", score: 89, winner: false, record: null, periods: [], logo: "/logos/1610612744.svg", color: "#2E63C8" },
    home: { id: 1610612747, tricode: "LAL", city: "洛杉矶", name: "湖人", fullName: "洛杉矶湖人", score: 94, winner: false, record: null, periods: [], logo: "/logos/1610612747.svg", color: "#7C4DDB" },
    ...overrides,
  };
}

const HEALTHY = { sourceAt: "2026-10-11T02:00:00Z", coverage: "full", scheduleOk: true, scoreboardOk: true };
const LIVE_FEED_DOWN = { sourceAt: null, coverage: "full", scheduleOk: true, scoreboardOk: false };
const SCHEDULE_DOWN = { sourceAt: "2026-10-11T02:00:00Z", coverage: "unknown", scheduleOk: false, scoreboardOk: true };

test("statusRank orders upcoming < live < final", () => {
  assert.ok(statusRank("upcoming") < statusRank("live"));
  assert.ok(statusRank("live") < statusRank("final"));
});

test("a degraded payload cannot move a live game backwards", () => {
  const previous = [game({ status: "live", away: { ...game().away, score: 89 }, home: { ...game().home, score: 94 } })];
  // What the schedule alone says once the live feed stops answering.
  const stale = game({ status: "upcoming", period: 0, clock: null, away: { ...game().away, score: null }, home: { ...game().home, score: null } });

  const { games, heldBack } = mergeGames(previous, [stale], LIVE_FEED_DOWN);

  assert.equal(games.length, 1);
  assert.equal(games[0].status, "live", "a live game must not become upcoming");
  assert.equal(games[0].away.score, 89);
  assert.equal(games[0].home.score, 94);
  assert.equal(heldBack, 1);
});

test("a final score is never silently rolled back either", () => {
  const previous = [game({ status: "final" })];
  const stale = game({ status: "live", away: { ...game().away, score: 88 }, home: { ...game().home, score: 90 } });

  const { games } = mergeGames(previous, [stale], LIVE_FEED_DOWN);

  assert.equal(games[0].status, "final");
});

test("a complete payload is authoritative and always wins", () => {
  const previous = [game({ status: "live" })];
  const corrected = game({ status: "final" });

  const { games, heldBack } = mergeGames(previous, [corrected], HEALTHY);

  assert.equal(games[0].status, "final");
  assert.equal(heldBack, 0);
});

test("a degraded payload does not retire a game it cannot see", () => {
  const previous = [game({ id: "A", status: "live" }), game({ id: "B", status: "final" })];
  // The scoreboard knows nothing about either game, so the list comes back empty.
  const { games } = mergeGames(previous, [], SCHEDULE_DOWN);

  assert.deepEqual(
    games.map((entry) => entry.id).sort(),
    ["A", "B"],
    "known live/final games survive a degraded payload",
  );
});

test("an upcoming game is not carried over by a degraded payload", () => {
  const previous = [game({ id: "A", status: "upcoming" })];
  const { games } = mergeGames(previous, [], SCHEDULE_DOWN);
  assert.equal(games.length, 0);
});

test("the first payload has nothing to merge against", () => {
  const next = [game()];
  assert.deepEqual(mergeGames(null, next, LIVE_FEED_DOWN).games, next);
});

// --- weak sources are second-guessed per team, per period (R2-B3) ----------

test("a weak source may not take a point off either team", () => {
  const previous = [game({ away: { ...game().away, score: 89 }, home: { ...game().home, score: 94 } })];
  const weaker = game({ away: { ...game().away, score: 88 }, home: { ...game().home, score: 90 } });

  const { games, heldBack } = mergeGames(previous, [weaker], LIVE_FEED_DOWN);

  assert.equal(games[0].away.score, 89);
  assert.equal(games[0].home.score, 94);
  assert.equal(heldBack, 1, "two sides protected in one game is still one held-back game");
});

test("a rising total does not excuse one team's score dropping", () => {
  // 89–94 arriving as 88–96 raises the total by one while taking a point off
  // the away team. The old rule compared only the total and accepted it.
  const previous = [game({ away: { ...game().away, score: 89 }, home: { ...game().home, score: 94 } })];
  const weaker = game({ away: { ...game().away, score: 88 }, home: { ...game().home, score: 96 } });

  const { games, heldBack } = mergeGames(previous, [weaker], LIVE_FEED_DOWN);

  assert.equal(games[0].away.score, 89, "the point we already published is not the weak feed's to take back");
  assert.notEqual(games[0].away.score, 88);
  assert.equal(games[0].home.score, 96, "a score the weak round did see may still be added");
  assert.equal(heldBack, 1, "one game held back counts once, not once per protected side");
});

test("the protection follows the side that dropped, whichever side it is", () => {
  // The mirror image of 89–94 → 88–96: here the away team scores and the home
  // team is the one the weak feed takes a point from. Only the side that
  // dropped may be protected — a rule that froze both teams would be wrong.
  const previous = [game({ away: { ...game().away, score: 89 }, home: { ...game().home, score: 94 } })];
  const weaker = game({ away: { ...game().away, score: 93 }, home: { ...game().home, score: 93 } });

  const { games, heldBack } = mergeGames(previous, [weaker], LIVE_FEED_DOWN);

  assert.equal(games[0].away.score, 93, "the away score the weak round did see is kept");
  assert.equal(games[0].home.score, 94, "the home point it lost is protected");
  assert.notEqual(games[0].home.score, 93);
  assert.equal(heldBack, 1);
});

test("a weak source may not run the clock backwards inside a period", () => {
  // Same period, so the clock can only count down: 3:50 → 4:12 is two minutes
  // the feed failed to see, not progress.
  const previous = [game({ period: 3, clock: "3:50", statusText: "第3节 · 3:50" })];
  const weaker = game({ period: 3, clock: "4:12", statusText: "第3节 · 4:12" });

  const { games, heldBack } = mergeGames(previous, [weaker], LIVE_FEED_DOWN);

  assert.equal(games[0].clock, "3:50");
  assert.notEqual(games[0].clock, "4:12");
  assert.equal(games[0].statusText, "第3节 · 3:50", "the status line is folded from the clock and must agree with it");
  assert.equal(heldBack, 1);
});

test("a weak source may still move the clock forward, and score inside the period", () => {
  const previous = [game({ period: 3, clock: "3:50", statusText: "第3节 · 3:50" })];
  const weaker = game({
    period: 3,
    clock: "3:20",
    statusText: "第3节 · 3:20",
    away: { ...game().away, score: 91 },
  });

  const { games, heldBack } = mergeGames(previous, [weaker], LIVE_FEED_DOWN);

  assert.equal(games[0].clock, "3:20");
  assert.equal(games[0].away.score, 91);
  assert.equal(heldBack, 0);
});

test("a new period may reset the clock to a larger value", () => {
  // The clock resets at every period boundary, so 0:50 → 11:40 in Q4 is
  // normal progress and must not be mistaken for a regression.
  const previous = [game({ period: 3, clock: "0:50", statusText: "第3节 · 0:50" })];
  const weaker = game({ period: 4, clock: "11:40", statusText: "第4节 · 11:40" });

  const { games, heldBack } = mergeGames(previous, [weaker], LIVE_FEED_DOWN);

  assert.equal(games[0].period, 4);
  assert.equal(games[0].clock, "11:40");
  assert.equal(games[0].statusText, "第4节 · 11:40");
  assert.equal(heldBack, 0);
});

test("an authoritative round may correct a score downwards and the clock with it", () => {
  // The contrast that keeps the rule honest: when both feeds answered this
  // round the league's own numbers win, even where they are lower.
  const previous = [
    game({
      period: 3,
      clock: "3:50",
      statusText: "第3节 · 3:50",
      away: { ...game().away, score: 89 },
      home: { ...game().home, score: 94 },
    }),
  ];
  const corrected = game({
    period: 3,
    clock: "4:12",
    statusText: "第3节 · 4:12",
    away: { ...game().away, score: 88 },
    home: { ...game().home, score: 96 },
  });

  const { games, heldBack } = mergeGames(previous, [corrected], HEALTHY);

  assert.equal(games[0].away.score, 88, "a complete round is a correction, not a regression");
  assert.equal(games[0].home.score, 96);
  assert.equal(games[0].clock, "4:12");
  assert.equal(games[0].statusText, "第3节 · 4:12");
  assert.equal(heldBack, 0);
});

test("only a full-coverage answer may report 'no games'", () => {
  assert.equal(emptyListMeaning("full"), "none");
  assert.equal(emptyListMeaning("partial"), "unknown", "the live feed cannot speak for a past date");
  assert.equal(emptyListMeaning("unknown"), "unknown");
});

test("a live game with no statistics is not 'not started'", () => {
  const empty = { stats: [], boxScore: { home: { players: [] }, away: { players: [] } } };
  assert.equal(detailAvailability({ status: "upcoming", ...empty }), "not-started");
  assert.equal(detailAvailability({ status: "live", ...empty }), "stats-unavailable");
  assert.equal(detailAvailability({ status: "final", ...empty }), "stats-unavailable");
});

test("statistics present means ready in any state", () => {
  const filled = {
    stats: [{ label: "篮板", away: "40", home: "44" }],
    boxScore: { home: { players: [] }, away: { players: [] } },
  };
  assert.equal(detailAvailability({ status: "live", ...filled }), "ready");
  assert.equal(detailAvailability({ status: "final", ...filled }), "ready");
});

test("an unstarted game with a published box score still counts as ready", () => {
  const box = {
    stats: [],
    boxScore: { home: { players: [{ personId: 1 }] }, away: { players: [] } },
  };
  assert.equal(detailAvailability({ status: "upcoming", ...box }), "ready");
});

// --- boxAvailability: the player table answers for itself (R4) -------------

test("box availability: a player on either side is enough to render a table", () => {
  const onlyAway = {
    stats: [{ label: "篮板", away: "40", home: "44" }],
    boxScore: { home: { players: [] }, away: { players: [{ personId: 7 }] } },
  };
  assert.equal(boxAvailability({ status: "live", ...onlyAway }), "ready");
  assert.equal(
    boxAvailability({ status: "final", ...onlyAway, boxScore: { home: { players: [{ personId: 9 }] }, away: { players: [] } } }),
    "ready",
  );
});

test("box availability: team stats without any player line is 'empty', not a blank table", () => {
  // The exact shape the review reproduced: detailAvailability says "ready"
  // because stats exist, while the table has zero rows to show.
  const statsButNoPlayers = {
    stats: [{ label: "篮板", away: "40", home: "44" }],
    boxScore: { home: { players: [] }, away: { players: [] } },
  };
  assert.equal(detailAvailability({ status: "final", ...statsButNoPlayers }), "ready");
  assert.equal(boxAvailability({ status: "final", ...statsButNoPlayers }), "empty");
  assert.equal(boxAvailability({ status: "live", ...statsButNoPlayers }), "empty");
});

test("box availability keeps 'not started' and 'could not be read' apart", () => {
  const nothing = { stats: [], boxScore: { home: { players: [] }, away: { players: [] } } };
  assert.equal(boxAvailability({ status: "upcoming", ...nothing }), "not-started");
  assert.equal(boxAvailability({ status: "live", ...nothing }), "unavailable");
  assert.equal(boxAvailability({ status: "final", ...nothing }), "unavailable");
});

test("box availability never claims 'empty' when a box score is genuinely published", () => {
  const bothSides = {
    stats: [],
    boxScore: { home: { players: [{ personId: 1 }] }, away: { players: [{ personId: 2 }] } },
  };
  assert.equal(boxAvailability({ status: "live", ...bothSides }), "ready");
});
