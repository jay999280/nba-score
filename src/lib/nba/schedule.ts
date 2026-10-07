/**
 * The season schedule, indexed once per process.
 *
 * `scheduleLeagueV2_1.json` is a ~5 MB document covering every game of the
 * current season, which is what makes date switching possible — the live
 * scoreboard only ever describes the current game date.
 */

import { SOURCE, fetchSource } from "./source";
import { normalizeScheduleGame } from "./normalize";
import type { RawSchedule, RawScheduleGame } from "./raw";
import type { Game, GameResult, MatchupContext, TeamForm } from "@/lib/types";

/** The schedule changes only when the league reschedules a game. */
const SCHEDULE_TTL_SECONDS = 6 * 60 * 60;

export interface ScheduleEntry {
  game: Game;
  /** The league's own game date, US Eastern, `YYYY-MM-DD`. */
  etDate: string;
  /** Tip-off, ISO UTC */
  startTime: string;
  arena: string | null;
}

export interface ScheduleIndex {
  entries: ScheduleEntry[];
  byId: Map<string, ScheduleEntry>;
}

let indexPromise: Promise<ScheduleIndex> | null = null;
let indexExpires = 0;

/** `10/03/2026 00:00:00` → `2026-10-03`. */
function toDateKey(rawDate: string): string {
  const [datePart] = rawDate.split(" ");
  const [month, day, year] = datePart.split("/");
  if (!month || !day || !year) return rawDate;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function buildIndex(schedule: RawSchedule): ScheduleIndex {
  const entries: ScheduleEntry[] = [];
  const byId = new Map<string, ScheduleEntry>();

  for (const gameDate of schedule.leagueSchedule?.gameDates ?? []) {
    const etDate = toDateKey(gameDate.gameDate);
    for (const rawGame of gameDate.games as RawScheduleGame[]) {
      const game = normalizeScheduleGame(rawGame);
      const entry: ScheduleEntry = {
        game,
        etDate,
        startTime: game.startTime,
        arena: rawGame.arenaName || null,
      };
      entries.push(entry);
      byId.set(game.id, entry);
    }
  }

  return { entries, byId };
}

export async function getScheduleIndex(): Promise<ScheduleIndex> {
  const now = Date.now();
  if (indexPromise && indexExpires > now) {
    return indexPromise;
  }

  const task = fetchSource<RawSchedule>(SOURCE.schedule, SCHEDULE_TTL_SECONDS, 45_000)
    .then(buildIndex)
    .catch((error) => {
      // Never memoize a failure: the next request should retry upstream.
      indexPromise = null;
      indexExpires = 0;
      throw error;
    });

  indexPromise = task;
  indexExpires = now + SCHEDULE_TTL_SECONDS * 1000;
  return task;
}

/** Games whose tip-off falls inside `[from, to)`, oldest first. */
export async function gamesInWindow(from: string, to: string): Promise<ScheduleEntry[]> {
  const { entries } = await getScheduleIndex();
  const start = Date.parse(from);
  const end = Date.parse(to);
  return entries
    .filter((entry) => {
      const time = Date.parse(entry.startTime);
      return time >= start && time < end;
    })
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

export async function findScheduleEntry(gameId: string): Promise<ScheduleEntry | null> {
  try {
    const { byId } = await getScheduleIndex();
    return byId.get(gameId) ?? null;
  } catch {
    return null;
  }
}

function resultFor(game: Game, teamId: number): GameResult | null {
  const mine = game.home.id === teamId ? game.home : game.away;
  const theirs = game.home.id === teamId ? game.away : game.home;
  if (mine.score === null || theirs.score === null || mine.score === theirs.score) return null;
  return mine.score > theirs.score ? "W" : "L";
}

/**
 * Pre-game context from the season file: each side's recent form plus the
 * season head-to-head. Only finished games strictly before this tip-off
 * count, so the current game can never leak into its own preview.
 */
export async function getMatchupContext(
  gameId: string,
  homeId: number,
  awayId: number,
  startTime: string,
): Promise<MatchupContext | null> {
  let entries: ScheduleEntry[];
  try {
    ({ entries } = await getScheduleIndex());
  } catch {
    return null;
  }

  const startMs = Date.parse(startTime);
  if (Number.isNaN(startMs)) return null;

  const past = entries.filter(
    (entry) =>
      entry.game.id !== gameId &&
      entry.game.status === "final" &&
      !entry.game.postponed &&
      Date.parse(entry.startTime) < startMs,
  );
  const byDateDesc = [...past].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));

  const formFor = (teamId: number): TeamForm => {
    const results: GameResult[] = [];
    for (const entry of byDateDesc) {
      if (results.length >= 5) break;
      if (entry.game.home.id !== teamId && entry.game.away.id !== teamId) continue;
      const result = resultFor(entry.game, teamId);
      if (result) results.push(result);
    }
    let streak: TeamForm["streak"] = null;
    if (results.length > 0) {
      let count = 1;
      while (count < results.length && results[count] === results[0]) count++;
      streak = { result: results[0], count };
    }
    return { last5: results, streak };
  };

  const meetings = past.filter(
    (entry) =>
      (entry.game.home.id === homeId && entry.game.away.id === awayId) ||
      (entry.game.home.id === awayId && entry.game.away.id === homeId),
  );

  let seriesHome = 0;
  let seriesAway = 0;
  for (const entry of meetings) {
    const result = resultFor(entry.game, homeId);
    if (result === "W") seriesHome += 1;
    else if (result === "L") seriesAway += 1;
  }

  return {
    home: formFor(homeId),
    away: formFor(awayId),
    seriesHome,
    seriesAway,
    meetings: meetings.length,
  };
}
