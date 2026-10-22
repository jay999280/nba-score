/**
 * Pre-game season comparison + probable lineups: the service layer.
 *
 * Two questions the pre-game page asks, and two different ways to answer them:
 *
 *  - **How do the teams compare this season?** ESPN's team statistics (one
 *    request per team) plus the opponent scoring only the standings document
 *    publishes (one request for both sides). Read eagerly: two small documents.
 *  - **Who is likely to start?** The five starters in the box score of each
 *    team's most recent completed game, which needs that box score, the ESPN
 *    roster (to map a name to an ESPN athlete id) and one statistics read per
 *    player. Expensive, so the route and the client keep it lazy.
 *
 * Everything degrades on its own block: a comparison that cannot be read never
 * blocks the lineups and vice versa. Nothing here invents a value —— a missing
 * number stays `null` and the interface says which side (or which source) is
 * missing, which is the whole point of the "no blank panels" requirement.
 */

import type {
  LineupBasis,
  LineupPlayer,
  LineupsResponse,
  LineupsSection,
  SeasonComparison,
  SeasonComparisonRow,
  SeasonComparisonSide,
  TeamLineup,
} from "@/lib/types";
import {
  espnTeamIdFor,
  fetchAthleteStatistics,
  fetchPointsAllowed,
  fetchRoster,
  fetchTeamStatistics,
  statPerGame,
  statPercentage,
  type EspnPointsAllowed,
  type EspnRosterAthlete,
  type EspnStatIndex,
} from "./espn";
import { isRawBoxScore } from "./guards";
import { playerNameKey, playerNameZh } from "./player-names";
import type { RawBoxScore } from "./raw";
import { getScheduleIndexState, type ScheduleEntry } from "./schedule";
import { SOURCE, UpstreamError, fetchSource } from "./source";
import { seasonContext } from "./standings";

/** A finished box score never changes again. */
const FINAL_BOXSCORE_TTL_SECONDS = 60 * 60;
const BOXSCORE_TIMEOUT_MS = 15_000;
/** Five starters, as the product asks. */
const STARTERS_PER_TEAM = 5;
/** Never more than four player-statistics reads in flight, across both teams. */
const ATHLETE_STATS_CONCURRENCY = 4;

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

/** A slot-based limiter: at most `limit` tasks run at once. */
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const resume = waiting.shift();
      // A queued task takes over this slot, so `active` must not drop.
      if (resume) resume();
      else active -= 1;
    }
  };
}

/** One decimal for averages ("115.9"), whole numbers untouched ("106"). */
function formatAverage(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function roundAverage(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

/* ------------------------------------------------------------------ *
 * Season comparison
 * ------------------------------------------------------------------ */

interface ComparisonSide {
  /** ESPN's team statistics, null when the source could not answer (incl. no games). */
  stats: EspnStatIndex | null;
  /** Opponent points per game from the standings document. */
  pointsAllowed: number | null;
  /** Completed regular-season games the schedule itself already knows about. */
  regularSeasonGames: number;
}

/**
 * Completed regular-season games for one team, newest first.
 *
 * The game being previewed is excluded defensively: this service is only asked
 * for unstarted games today, but a caller that asked about a finished one must
 * not get that game's own starters back as "the previous game".
 */
function completedRegularSeasonGames(
  entries: readonly ScheduleEntry[],
  teamId: number,
  gameId: string,
  now: number,
): ScheduleEntry[] {
  const games: { entry: ScheduleEntry; start: number }[] = [];
  for (const entry of entries) {
    const game = entry.game;
    if (game.id === gameId || game.status !== "final" || game.postponed) continue;
    if (game.stage !== "regular-season") continue;
    if (game.home.id !== teamId && game.away.id !== teamId) continue;
    const start = Date.parse(game.startTime);
    if (!Number.isFinite(start) || start >= now) continue;
    games.push({ entry, start });
  }
  return games.sort((a, b) => b.start - a.start).map(({ entry }) => entry);
}

/** The most recent completed game of any competition stage (preseason included). */
function latestCompletedGame(
  entries: readonly ScheduleEntry[],
  teamId: number,
  gameId: string,
  now: number,
): ScheduleEntry[] {
  const games: { entry: ScheduleEntry; start: number }[] = [];
  for (const entry of entries) {
    const game = entry.game;
    if (game.id === gameId || game.status !== "final" || game.postponed) continue;
    if (game.home.id !== teamId && game.away.id !== teamId) continue;
    const start = Date.parse(game.startTime);
    if (!Number.isFinite(start) || start >= now) continue;
    games.push({ entry, start });
  }
  return games.sort((a, b) => b.start - a.start).map(({ entry }) => entry);
}

/**
 * Build the seven-row comparison.
 *
 * Rows are fixed so both teams are always asked the same questions; a side
 * unable to answer leaves `null`, never a zero.
 */
function comparisonRows(away: ComparisonSide, home: ComparisonSide): SeasonComparisonRow[] {
  const sideValue = (
    side: ComparisonSide,
    perGame: { averageName: string; totalName: string } | null,
    percentageName: string | null,
  ): string | null => {
    if (!side.stats) return null;
    if (perGame) {
      return formatAverage(statPerGame(side.stats, perGame.averageName, perGame.totalName));
    }
    if (percentageName) {
      const percent = statPercentage(side.stats, percentageName);
      return percent ? `${percent}%` : null;
    }
    return null;
  };

  const row = (
    key: string,
    label: string,
    awayValue: string | null,
    homeValue: string | null,
  ): SeasonComparisonRow => ({ key, label, away: awayValue, home: homeValue });

  return [
    row(
      "points",
      "场均得分",
      sideValue(away, { averageName: "avgPoints", totalName: "points" }, null),
      sideValue(home, { averageName: "avgPoints", totalName: "points" }, null),
    ),
    // The team-statistics document has no opponent scoring at all; the value is
    // taken from the standings document (`avgPointsAgainst`), where a team with
    // no games played has nothing to report.
    row(
      "points-allowed",
      "场均失分",
      formatAverage(away.pointsAllowed),
      formatAverage(home.pointsAllowed),
    ),
    row(
      "field-goal-pct",
      "投篮命中率",
      sideValue(away, null, "fieldGoalPct"),
      sideValue(home, null, "fieldGoalPct"),
    ),
    row(
      "three-point-pct",
      "三分命中率",
      sideValue(away, null, "threePointPct"),
      sideValue(home, null, "threePointPct"),
    ),
    row(
      "rebounds",
      "场均篮板",
      sideValue(away, { averageName: "avgRebounds", totalName: "rebounds" }, null),
      sideValue(home, { averageName: "avgRebounds", totalName: "rebounds" }, null),
    ),
    row(
      "assists",
      "场均助攻",
      sideValue(away, { averageName: "avgAssists", totalName: "assists" }, null),
      sideValue(home, { averageName: "avgAssists", totalName: "assists" }, null),
    ),
    row(
      "turnovers",
      "场均失误",
      sideValue(away, { averageName: "avgTurnovers", totalName: "turnovers" }, null),
      sideValue(home, { averageName: "avgTurnovers", totalName: "turnovers" }, null),
    ),
  ];
}

async function loadComparison(input: {
  season: string;
  espnSeason: number;
  scheduleEntries: readonly ScheduleEntry[];
  awayTeamId: number;
  homeTeamId: number;
  gameId: string;
  now: number;
}): Promise<SeasonComparison> {
  const empty = (): SeasonComparison => ({
    season: input.season,
    state: "unavailable",
    rows: [],
    sides: { away: "unavailable", home: "unavailable" },
  });

  try {
    const awayEspnId = espnTeamIdFor(input.awayTeamId);
    const homeEspnId = espnTeamIdFor(input.homeTeamId);

    const [awayStats, homeStats, pointsAllowed] = await Promise.all([
      awayEspnId === null
        ? Promise.resolve(null)
        : fetchTeamStatistics(input.espnSeason, awayEspnId).catch(() => null),
      homeEspnId === null
        ? Promise.resolve(null)
        : fetchTeamStatistics(input.espnSeason, homeEspnId).catch(() => null),
      // One document covers both teams; a failure only costs the "points
      // allowed" row, so it must never fail the whole block.
      fetchPointsAllowed(input.espnSeason, input.season).catch(
        () => new Map<number, EspnPointsAllowed>(),
      ),
    ]);

    const allowedFor = (espnTeamId: number | null): number | null => {
      if (espnTeamId === null) return null;
      const entry = pointsAllowed.get(espnTeamId);
      if (!entry || entry.gamesPlayed <= 0) return null;
      return entry.pointsAgainstPerGame;
    };

    const away: ComparisonSide = {
      stats: awayStats,
      pointsAllowed: allowedFor(awayEspnId),
      regularSeasonGames: completedRegularSeasonGames(
        input.scheduleEntries,
        input.awayTeamId,
        input.gameId,
        input.now,
      ).length,
    };
    const home: ComparisonSide = {
      stats: homeStats,
      pointsAllowed: allowedFor(homeEspnId),
      regularSeasonGames: completedRegularSeasonGames(
        input.scheduleEntries,
        input.homeTeamId,
        input.gameId,
        input.now,
      ).length,
    };

    const missing = { away: away.stats === null, home: home.stats === null };
    const sideState = (side: ComparisonSide): SeasonComparisonSide =>
      side.stats !== null ? "ready" : side.regularSeasonGames === 0 ? "no-games" : "unavailable";
    const sides = { away: sideState(away), home: sideState(home) };

    if (missing.away && missing.home) {
      const anyGamesPlayed = away.regularSeasonGames > 0 || home.regularSeasonGames > 0;
      return {
        season: input.season,
        // A team that has not played yet has no statistics to read, so the
        // source answering 404 is the season's state, not a failed request.
        state: anyGamesPlayed ? "unavailable" : "no-games",
        rows: [],
        sides,
      };
    }

    return {
      season: input.season,
      state: "ready",
      rows: comparisonRows(away, home),
      sides,
    };
  } catch {
    return empty();
  }
}

/* ------------------------------------------------------------------ *
 * Lineups
 * ------------------------------------------------------------------ */

interface StartersDraft {
  teamId: number;
  basis: LineupBasis;
  sourceGame: TeamLineup["sourceGame"];
  completedGames: number;
  players: LineupPlayer[];
}

function emptyTeamLineup(teamId: number): TeamLineup {
  return {
    teamId,
    basis: "unavailable",
    sourceGame: null,
    completedGames: 0,
    players: [],
  };
}

/**
 * The five from the box score, plus the ESPN roster so each name can be mapped
 * to an ESPN athlete id (the two providers use different player ids).
 *
 * A player that cannot be matched still appears — with no ESPN id and therefore
 * no season averages. Showing the real name the NBA feed published is better
 * than dropping the fifth row.
 */
function startersFromBoxScore(
  raw: RawBoxScore,
  teamId: number,
  rosterByName: Map<string, EspnRosterAthlete>,
): LineupPlayer[] | null {
  const side = raw.game.homeTeam.teamId === teamId ? raw.game.homeTeam : raw.game.awayTeam;
  const starters = (side.players ?? [])
    .filter((player) => player.starter === "1")
    .slice(0, STARTERS_PER_TEAM);
  if (starters.length === 0) return null;

  return starters.map((player) => {
    const englishName = `${player.firstName ?? ""} ${player.familyName ?? ""}`.trim() || player.name;
    const athlete = rosterByName.get(playerNameKey(englishName));
    return {
      espnId: athlete?.espnId ?? "",
      name: playerNameZh(englishName),
      position: player.position || athlete?.position || "",
      jersey: player.jerseyNum || athlete?.jersey || "",
      points: null,
      rebounds: null,
      assists: null,
    };
  });
}

/** "PG" → "G", "SF" → "F", "C" → "C". */
function positionGroup(position: string): "G" | "F" | "C" | null {
  const value = position.trim().toUpperCase();
  if (value.startsWith("G")) return "G";
  if (value.startsWith("F")) return "F";
  if (value.startsWith("C")) return "C";
  return null;
}

/** Where the five roster-fallback players come from: two guards, two forwards, one center. */
const ROSTER_SPOTS: readonly { group: "G" | "F" | "C"; count: number }[] = [
  { group: "G", count: 2 },
  { group: "F", count: 2 },
  { group: "C", count: 1 },
];

/**
 * Pick five out of the roster by position.
 *
 * The roster is published in alphabetical order, not as a depth chart, so this
 * is deliberately a list ("阵容名单"), not a claim about who will start. The
 * interface says so; the ordering rule only has to be deterministic and to
 * cover the positions a five needs.
 */
export function rosterFive(athletes: readonly EspnRosterAthlete[]): EspnRosterAthlete[] {
  const picked: EspnRosterAthlete[] = [];
  const used = new Set<string>();

  for (const spot of ROSTER_SPOTS) {
    let taken = 0;
    for (const athlete of athletes) {
      if (taken >= spot.count) break;
      if (used.has(athlete.espnId) || positionGroup(athlete.position) !== spot.group) continue;
      picked.push(athlete);
      used.add(athlete.espnId);
      taken += 1;
    }
  }
  // A short position group must not shrink the row count: fill from whatever
  // is left, in roster order.
  for (const athlete of athletes) {
    if (picked.length >= STARTERS_PER_TEAM) break;
    if (used.has(athlete.espnId)) continue;
    picked.push(athlete);
    used.add(athlete.espnId);
  }
  return picked.slice(0, STARTERS_PER_TEAM);
}

function rosterLineupPlayers(athletes: readonly EspnRosterAthlete[]): LineupPlayer[] {
  return athletes.map((athlete) => ({
    espnId: athlete.espnId,
    name: playerNameZh(athlete.displayName),
    position: athlete.position,
    jersey: athlete.jersey,
    points: null,
    rebounds: null,
    assists: null,
  }));
}

/**
 * One team's lineup draft: who, and from which evidence.
 *
 * Order of preference: last completed game → roster. A box score that did not
 * arrive falls through to the roster too, and `completedGames` tells the
 * interface which sentence to show.
 */
async function draftTeamLineup(input: {
  gameId: string;
  teamId: number;
  entries: readonly ScheduleEntry[];
  espnSeason: number;
  now: number;
}): Promise<StartersDraft> {
  const espnTeamId = espnTeamIdFor(input.teamId);
  const completedGames = latestCompletedGame(input.entries, input.teamId, input.gameId, input.now);

  const loadRoster = async (): Promise<EspnRosterAthlete[] | null> => {
    if (espnTeamId === null) return null;
    return fetchRoster(espnTeamId).catch(() => null);
  };

  const last = completedGames[0] ?? null;
  if (last) {
    const raw = await fetchSource<RawBoxScore>(
      SOURCE.boxScore(last.game.id),
      FINAL_BOXSCORE_TTL_SECONDS,
      BOXSCORE_TIMEOUT_MS,
      isRawBoxScore,
    ).catch(() => null);

    if (raw) {
      const roster = await loadRoster();
      const rosterByName = new Map<string, EspnRosterAthlete>();
      for (const athlete of roster ?? []) {
        rosterByName.set(playerNameKey(athlete.displayName), athlete);
      }
      const players = startersFromBoxScore(raw, input.teamId, rosterByName);
      if (players) {
        const opponent = last.game.home.id === input.teamId ? last.game.away : last.game.home;
        return {
          teamId: input.teamId,
          basis: "last-game",
          sourceGame: {
            id: last.game.id,
            startTime: last.game.startTime,
            opponentTricode: opponent.tricode,
            label: last.game.label ?? null,
          },
          completedGames: completedGames.length,
          players,
        };
      }
    }
  }

  const roster = await loadRoster();
  if (!roster || roster.length === 0) {
    return {
      teamId: input.teamId,
      basis: "unavailable",
      sourceGame: null,
      completedGames: completedGames.length,
      players: [],
    };
  }

  return {
    teamId: input.teamId,
    basis: "roster",
    sourceGame: null,
    completedGames: completedGames.length,
    players: rosterLineupPlayers(rosterFive(roster)),
  };
}

/** Read one player's per-game averages; a 404 is "no season data", not an error. */
async function addSeasonAverages(
  players: LineupPlayer[],
  espnSeason: number,
  run: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<LineupPlayer[]> {
  return Promise.all(
    players.map(async (player) => {
      if (!player.espnId) return player;
      const stats = await run(() => fetchAthleteStatistics(espnSeason, player.espnId));
      if (!stats) return player;
      return {
        ...player,
        points: roundAverage(statPerGame(stats, "avgPoints", "points")),
        rebounds: roundAverage(statPerGame(stats, "avgRebounds", "rebounds")),
        assists: roundAverage(statPerGame(stats, "avgAssists", "assists")),
      };
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export interface LineupsOptions {
  /**
   * Which half to compute. Omitted by the native client's single call and by
   * anyone who wants the complete payload; the Web route narrows it so the
   * eager comparison does not pay for ten player-statistics reads.
   */
  section?: LineupsSection;
}

const unavailableComparison = (season: string): SeasonComparison => ({
  season,
  state: "unavailable",
  rows: [],
  sides: { away: "unavailable", home: "unavailable" },
});

/**
 * The pre-game comparison and the two probable lineups for one game.
 *
 * Throws only when the game itself cannot be located in the season schedule:
 * an unknown fixture has no honest team ids to answer for. Every richer block
 * degrades to an explicit missing state instead of failing the request.
 */
export async function getLineups(gameId: string, options: LineupsOptions = {}): Promise<LineupsResponse> {
  const state = await getScheduleIndexState();
  const entry = state.index.byId.get(gameId);
  if (!entry) throw new UpstreamError(`No fixture for game ${gameId}`);

  const { season, espnSeason } = seasonContext(state.index.season);
  const awayTeam = entry.game.away;
  const homeTeam = entry.game.home;
  const now = Date.now();
  const entries = state.index.entries;

  const comparison = async (): Promise<SeasonComparison> =>
    loadComparison({
      season,
      espnSeason,
      scheduleEntries: entries,
      awayTeamId: awayTeam.id,
      homeTeamId: homeTeam.id,
      gameId,
      now,
    });

  const draft = async (teamId: number): Promise<StartersDraft> =>
    draftTeamLineup({ gameId, teamId, entries, espnSeason, now }).catch(() => ({
      teamId,
      basis: "unavailable" as const,
      sourceGame: null,
      completedGames: 0,
      players: [],
    }));

  if (options.section === "comparison") {
    return {
      gameId,
      season,
      comparison: await comparison().catch(() => unavailableComparison(season)),
      lineups: { away: emptyTeamLineup(awayTeam.id), home: emptyTeamLineup(homeTeam.id) },
    };
  }

  // One limiter for the whole request: at most four athlete-statistics reads
  // in flight even though both sides are assembled concurrently.
  const limiter = createLimiter(ATHLETE_STATS_CONCURRENCY);
  const resolveTeams = async (): Promise<{ away: TeamLineup; home: TeamLineup }> => {
    const [awayDraft, homeDraft] = await Promise.all([draft(awayTeam.id), draft(homeTeam.id)]);
    const [awayPlayers, homePlayers] = await Promise.all([
      addSeasonAverages(awayDraft.players, espnSeason, limiter),
      addSeasonAverages(homeDraft.players, espnSeason, limiter),
    ]);
    const toTeamLineup = (value: StartersDraft, players: LineupPlayer[]): TeamLineup => ({
      teamId: value.teamId,
      basis: value.basis,
      sourceGame: value.sourceGame,
      completedGames: value.completedGames,
      players,
    });
    return {
      away: toTeamLineup(awayDraft, awayPlayers),
      home: toTeamLineup(homeDraft, homePlayers),
    };
  };

  if (options.section === "lineups") {
    return {
      gameId,
      season,
      comparison: unavailableComparison(season),
      lineups: await resolveTeams(),
    };
  }

  const [comparisonValue, lineups] = await Promise.all([
    comparison().catch(() => unavailableComparison(season)),
    resolveTeams(),
  ]);
  return { gameId, season, comparison: comparisonValue, lineups };
}
