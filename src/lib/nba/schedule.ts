/**
 * The season schedule, indexed once per process.
 *
 * `scheduleLeagueV2_1.json` is a ~5 MB document covering every game of the
 * current season, which is what makes date switching possible — the live
 * scoreboard only ever describes the current game date.
 */

import { SOURCE, fetchSource } from "./source";
import { parseUpstreamTime } from "@/lib/format";
import { isRawSchedule } from "./guards";
import { normalizeScheduleGame } from "./normalize";
import { gameStageFor } from "./game-stage";
import { loadPersistedSchedule, savePersistedSchedule } from "./schedule-store";
import type { RawSchedule, RawScheduleGame } from "./raw";
import type { Game, GameResult, MatchupContext, TeamForm } from "@/lib/types";

/** The schedule changes only when the league reschedules a game. */
const SCHEDULE_TTL_SECONDS = 6 * 60 * 60;

/**
 * How long a kept copy may still answer *after* its normal lifetime has run
 * out. A refresh failure is usually transient, so throwing away a perfectly
 * good schedule on the first 403 costs the reader every date switch; serving
 * yesterday's schedule forever is worse, because a rescheduled game would
 * never appear. The grace window is the compromise, and past it the schedule
 * is simply unavailable — callers must say so rather than guess.
 */
export const SCHEDULE_LAST_GOOD_GRACE_MS = 30 * 60_000;

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
  season: string;
  sourceAt: string | null;
}

let indexPromise: Promise<ScheduleIndex> | null = null;
let indexExpires = 0;
/** The last successful build, kept only as a bounded fallback. */
let lastGood: { index: ScheduleIndex; fetchedAt: number } | null = null;
/**
 * One restore attempt per process. On a phone this is the difference between a
 * cold start that paints from the last run and one that waits for a 7 MB
 * download — but a failed or empty read must not be retried on every poll.
 */
let restorePromise: Promise<{ index: ScheduleIndex; fetchedAt: number } | null> | null = null;
/** Callers that arrive while the index is being restored or fetched share it. */
let bootstrapPromise: Promise<ScheduleIndexState> | null = null;

/** `10/03/2026 00:00:00` → `2026-10-03`. */
function toDateKey(rawDate: string): string {
  const [datePart] = rawDate.split(" ");
  const [month, day, year] = datePart.split("/");
  if (!month || !day || !year) return rawDate;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function indexFromEntries(
  entries: ScheduleEntry[],
  season: string,
  sourceAt: string | null,
): ScheduleIndex {
  const byId = new Map<string, ScheduleEntry>();
  for (const entry of entries) byId.set(entry.game.id, entry);
  return { entries, byId, season, sourceAt };
}

function buildIndex(schedule: RawSchedule): ScheduleIndex {
  const entries: ScheduleEntry[] = [];

  for (const gameDate of schedule.leagueSchedule?.gameDates ?? []) {
    const etDate = toDateKey(gameDate.gameDate);
    for (const rawGame of gameDate.games as RawScheduleGame[]) {
      const game = normalizeScheduleGame(rawGame);
      entries.push({
        game,
        etDate,
        startTime: game.startTime,
        arena: rawGame.arenaName || null,
      });
    }
  }

  return indexFromEntries(entries, schedule.leagueSchedule.seasonYear, parseUpstreamTime(schedule.meta?.time)?.toISOString() ?? null);
}

/** The index stored by the previous run, while it is still inside its lifetime. */
function restoredSchedule(): Promise<{ index: ScheduleIndex; fetchedAt: number } | null> {
  if (!restorePromise) {
    restorePromise = loadPersistedSchedule()
      .then((record) => {
        if (!record) return null;
        return {
          index: indexFromEntries(record.entries, record.season, record.sourceAt),
          fetchedAt: record.fetchedAt,
        };
      })
      .catch(() => null);
  }
  return restorePromise;
}

export interface ScheduleIndexState {
  index: ScheduleIndex;
  /**
   * True when this index is a copy kept from an earlier round because the
   * refresh failed. Callers must forward it into `Freshness` — a degraded
   * schedule can be missing a rescheduled game, and only the reader can
   * decide whether that matters.
   */
  degraded: boolean;
}

/** The kept copy, while it is still inside its normal lifetime plus the grace window. */
function keptCopyOrThrow(error: unknown): ScheduleIndexState {
  const usableUntil = (lastGood?.fetchedAt ?? 0) + SCHEDULE_TTL_SECONDS * 1000 + SCHEDULE_LAST_GOOD_GRACE_MS;
  if (lastGood && Date.now() <= usableUntil) {
    return { index: lastGood.index, degraded: true };
  }
  throw error;
}

/**
 * The schedule index and whether it is this round's read.
 *
 * A failure is never memoized: the next request retries upstream, so a CDN
 * that comes back is picked up immediately. The kept copy does not change
 * that — it only means the failure does not have to become the reader's
 * problem for the next half hour.
 */
export async function getScheduleIndexState(): Promise<ScheduleIndexState> {
  const now = Date.now();

  if (indexPromise && indexExpires > now) {
    try {
      return { index: await indexPromise, degraded: false };
    } catch (error) {
      return keptCopyOrThrow(error);
    }
  }

  if (!bootstrapPromise) {
    const task = bootstrapIndex();
    bootstrapPromise = task;
    const settle = () => {
      if (bootstrapPromise === task) bootstrapPromise = null;
    };
    task.then(settle, settle);
  }
  return bootstrapPromise;
}

/**
 * Fill the index, cheapest source first: memory (handled by the caller), then
 * the copy this device stored on its last run, then upstream.
 *
 * The stored copy is used inside the same six-hour lifetime the in-memory one
 * gets, and is reported as a normal read — it is the same payload, only
 * younger. Past its lifetime the network answers, and a failure there falls
 * back to the bounded last-good window exactly as before.
 */
async function bootstrapIndex(): Promise<ScheduleIndexState> {
  const restored = await restoredSchedule();
  if (restored) {
    const expires = restored.fetchedAt + SCHEDULE_TTL_SECONDS * 1000;
    if (expires > Date.now()) {
      lastGood = { index: restored.index, fetchedAt: restored.fetchedAt };
      indexPromise = Promise.resolve(restored.index);
      indexExpires = expires;
      return { index: restored.index, degraded: false };
    }
  }

  const now = Date.now();
  const task = fetchSource<RawSchedule>(
    SOURCE.schedule,
    SCHEDULE_TTL_SECONDS,
    45_000,
    isRawSchedule,
  ).then((raw) => {
    const index = buildIndex(raw);
    const fetchedAt = Date.now();
    lastGood = { index, fetchedAt };
    // Persisting costs a disk write nobody is waiting for; the next cold start
    // is the one that benefits.
    void savePersistedSchedule({
      entries: index.entries,
      season: index.season,
      sourceAt: index.sourceAt,
      fetchedAt,
    });
    return index;
  });

  indexPromise = task;
  indexExpires = now + SCHEDULE_TTL_SECONDS * 1000;

  try {
    return { index: await task, degraded: false };
  } catch (error) {
    indexPromise = null;
    indexExpires = 0;
    return keptCopyOrThrow(error);
  }
}

export async function getScheduleIndex(): Promise<ScheduleIndex> {
  return (await getScheduleIndexState()).index;
}

function windowOf(index: ScheduleIndex, from: string, to: string): ScheduleEntry[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return index.entries
    .filter((entry) => {
      const time = Date.parse(entry.startTime);
      return time >= start && time < end;
    })
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/** Games whose tip-off falls inside `[from, to)`, oldest first, with provenance. */
export async function gamesInWindowState(
  from: string,
  to: string,
): Promise<{ entries: ScheduleEntry[]; degraded: boolean; index: ScheduleIndex }> {
  const { index, degraded } = await getScheduleIndexState();
  return { entries: windowOf(index, from, to), degraded, index };
}

/** Games whose tip-off falls inside `[from, to)`, oldest first. */
export async function gamesInWindow(from: string, to: string): Promise<ScheduleEntry[]> {
  return (await gamesInWindowState(from, to)).entries;
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
      Date.parse(entry.startTime) < startMs &&
      (entry.game.stage ?? gameStageFor(entry.game.id, entry.game.label)) ===
        gameStageFor(gameId),
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
