/**
 * The service layer behind the Internal API.
 *
 * It owns the merge rules between the two upstream feeds:
 *  - the season schedule says which games exist on a date, and what they ended
 *    up as;
 *  - the live scoreboard says what is happening right now.
 */

import type { Game, GameDetail, GameStatus, PlaysResponse } from "@/lib/types";
import {
  gameDetailFromGame,
  normalizeBoxScore,
  normalizePlayByPlay,
  normalizeScoreboardGame,
  toStatus,
} from "./normalize";
import type { RawBoxScore, RawPlayByPlay, RawScoreboard } from "./raw";
import { findScheduleEntry, gamesInWindow, getMatchupContext, type ScheduleEntry } from "./schedule";
import { SOURCE, UpstreamError, fetchSource, primeSource } from "./source";

/** The scoreboard is shared by every visitor, so the freshest copy is enough. */
const SCOREBOARD_TTL_SECONDS = 5;
/** In-game box scores move on every possession. */
const BOXSCORE_LIVE_TTL_SECONDS = 10;
/** A finished box score is immutable. */
const BOXSCORE_FINAL_TTL_SECONDS = 60 * 60;
/** Play-by-play arrives possession by possession, like the box score. */
const PLAYS_LIVE_TTL_SECONDS = 10;
/** A finished play-by-play never changes again. */
const PLAYS_FINAL_TTL_SECONDS = 60 * 60;

export function isValidGameId(gameId: string): boolean {
  return /^\d{10}$/.test(gameId);
}

async function loadScoreboard(): Promise<RawScoreboard | null> {
  try {
    return await fetchSource<RawScoreboard>(SOURCE.scoreboard, SCOREBOARD_TTL_SECONDS);
  } catch {
    // Live scores are an enhancement: without them the schedule still answers.
    return null;
  }
}

function withinWindow(game: Game, fromMs: number, toMs: number): boolean {
  const time = Date.parse(game.startTime);
  return time >= fromMs && time < toMs;
}

/**
 * Every game whose tip-off falls inside `[from, to)`, oldest first.
 *
 * The window is computed by the browser from the device's own time zone, so a
 * game is listed on the local calendar day it actually starts on (PRD §6, §28).
 */
export async function listGames(from: string, to: string): Promise<Game[]> {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    throw new UpstreamError("Invalid date window");
  }

  const [schedule, scoreboard] = await Promise.all([
    gamesInWindow(from, to).then(
      (entries) => entries,
      () => null,
    ),
    loadScoreboard(),
  ]);

  const liveById = new Map(
    (scoreboard?.scoreboard.games ?? []).map((game) => [game.gameId, game]),
  );

  // Preferred path: the schedule enumerates the date, the scoreboard refines it.
  if (schedule) {
    return overlaySchedule(schedule, liveById);
  }

  // The 5 MB schedule is unavailable: fall back to whatever the live feed
  // describes for the requested window rather than failing the whole page.
  if (scoreboard) {
    return scoreboard.scoreboard.games
      .map(normalizeScoreboardGame)
      .filter((game) => withinWindow(game, fromMs, toMs))
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  }

  throw new UpstreamError("NBA data source unavailable");
}

function overlaySchedule(
  entries: ScheduleEntry[],
  liveById: Map<string, RawScoreboard["scoreboard"]["games"][number]>,
): Game[] {
  return entries.map((entry) => {
    const live = liveById.get(entry.game.id);
    return live ? normalizeScoreboardGame(live) : entry.game;
  });
}

/** One game with everything the detail page shows. */
export async function getGameDetail(gameId: string): Promise<GameDetail> {
  const entry = await findScheduleEntry(gameId);

  const raw = await fetchSource<RawBoxScore>(
    SOURCE.boxScore(gameId),
    BOXSCORE_LIVE_TTL_SECONDS,
  ).catch(() => null);

  if (raw) {
    const detail = normalizeBoxScore(raw, {
      label: entry?.game.label ?? null,
      startTime: entry?.game.startTime ?? null,
    });

    if (detail.status === "final") {
      primeSource(SOURCE.boxScore(gameId), BOXSCORE_FINAL_TTL_SECONDS);
    }

    detail.matchup = await getMatchupContext(detail.id, detail.home.id, detail.away.id, detail.startTime);
    return detail;
  }

  // There is no box score to read: before tip-off upstream has not written one
  // yet, and for long-past games it is gone. Describe the fixture instead.
  const fixture = entry?.game ?? (await findLiveGame(gameId));

  if (!fixture) {
    throw new UpstreamError(`No data available for game ${gameId}`);
  }

  const fallback = gameDetailFromGame(fixture, entry?.arena ?? null);
  fallback.matchup = await getMatchupContext(fallback.id, fallback.home.id, fallback.away.id, fallback.startTime);
  return fallback;
}

/** The live feed as a last resort for a game the schedule does not list. */
async function findLiveGame(gameId: string): Promise<Game | null> {
  const scoreboard = await loadScoreboard();
  const match = scoreboard?.scoreboard.games.find((game) => game.gameId === gameId);
  return match ? normalizeScoreboardGame(match) : null;
}

/** personId → English full name, so the feed's numbers become people. */
function personNames(box: RawBoxScore | null): Map<number, string> {
  const map = new Map<number, string>();
  if (!box) return map;
  for (const side of [box.game.homeTeam, box.game.awayTeam]) {
    for (const player of side.players) {
      const full = `${player.firstName ?? ""} ${player.familyName ?? ""}`.trim() || player.name;
      map.set(player.personId, full);
    }
  }
  return map;
}

/**
 * Structured events + score flow for the Plays tab.
 *
 * Upstream publishes nothing before tip-off, so an unstarted game answers
 * with `available: false` instead of an error — the UI shows a calm empty
 * state rather than a failure.
 */
export async function getGamePlays(gameId: string): Promise<Omit<PlaysResponse, "updatedAt">> {
  const [box, pbp] = await Promise.all([
    fetchSource<RawBoxScore>(SOURCE.boxScore(gameId), BOXSCORE_LIVE_TTL_SECONDS).catch(() => null),
    fetchSource<RawPlayByPlay>(SOURCE.playByPlay(gameId), PLAYS_LIVE_TTL_SECONDS).catch(() => null),
  ]);

  const status: GameStatus = box
    ? toStatus(box.game.gameStatus)
    : ((await findScheduleEntry(gameId))?.game.status ?? "upcoming");

  if (!pbp || !pbp.game.actions?.length) {
    return { gameId, available: false, status, events: [], flow: [], periods: [], shots: [] };
  }

  const { events, flow, periods, shots } = normalizePlayByPlay(pbp, personNames(box));

  if (status === "final") {
    primeSource(SOURCE.playByPlay(gameId), PLAYS_FINAL_TTL_SECONDS);
    primeSource(SOURCE.boxScore(gameId), BOXSCORE_FINAL_TTL_SECONDS);
  }

  return { gameId, available: true, status, events, flow, periods, shots };
}
