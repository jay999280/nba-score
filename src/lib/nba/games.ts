/**
 * The service layer.
 *
 * It owns the merge rules between the two upstream feeds:
 *  - the season schedule says which games exist on a date, and what they ended
 *    up as;
 *  - the live scoreboard says what is happening right now.
 *
 * They fail independently, so every result also carries a `Freshness` record
 * saying what the payload is actually entitled to claim. "The schedule is
 * missing" and "there are no games" are different answers, and only one of
 * them may be shown as an all-clear.
 */

import { parseUpstreamTime } from "@/lib/format";
import { classifyFreshness } from "@/lib/game-state";
import type {
  Coverage,
  Freshness,
  Game,
  GameDetail,
  GameStatus,
  PlaysResponse,
  PlaysState,
} from "@/lib/types";
import {
  gameDetailFromGame,
  normalizeBoxScore,
  normalizePlayByPlay,
  normalizeScoreboardGame,
  toStatus,
} from "./normalize";
import type { RawBoxScore, RawPlayByPlay, RawScoreboard } from "./raw";
import { isRawBoxScore, isRawPlayByPlay, isRawScoreboard } from "./guards";
import {
  gamesInWindowState,
  getMatchupContext,
  getScheduleIndexState,
  type ScheduleEntry,
  type ScheduleIndexState,
  type ScheduleIndex,
} from "./schedule";
import { playoffSeriesFor } from "./series";
import { gameStageFor, gameStageLabel } from "./game-stage";
import { SOURCE, UpstreamError, fetchSource, primeSource } from "./source";

/** The scoreboard is shared by every visitor, so the freshest copy is enough. */
const SCOREBOARD_TTL_SECONDS = 5;
/** In-game box scores move on every possession. */
const BOXSCORE_LIVE_TTL_SECONDS = 5;
/** A finished box score is immutable. */
const BOXSCORE_FINAL_TTL_SECONDS = 60 * 60;
/** Play-by-play arrives possession by possession, like the box score. */
const PLAYS_LIVE_TTL_SECONDS = 5;
/** A finished play-by-play never changes again. */
const PLAYS_FINAL_TTL_SECONDS = 60 * 60;

export function isValidGameId(gameId: string): boolean {
  return /^\d{10}$/.test(gameId);
}

/**
 * The upstream's own data time, as a valid ISO string.
 *
 * The feeds write `"2026-10-10 01:14:25.1425"` — UTC without a zone marker —
 * which `Date.parse` would read as local time. Every `sourceAt` this service
 * returns is normalized here so that no caller has to know about the quirk.
 */
function sourceAtOf(payload: { meta?: { time?: unknown } } | null | undefined): string | null {
  return parseUpstreamTime(payload?.meta?.time)?.toISOString() ?? null;
}

/**
 * Assemble one payload's freshness record.
 *
 * Explicit at every return path on purpose: a payload that cannot say where it
 * came from would be shown as if it were live, which is the defect this record
 * exists to prevent.
 */
function freshnessFor(input: {
  sourceAt: string | null;
  coverage: Coverage;
  scoreboardOk: boolean;
  scheduleOk: boolean;
  degraded?: boolean;
  lastGood?: boolean;
  /**
   * The schedule is still on its way. A late feed is not a failed feed: the
   * payload says "not complete yet" without accusing the source of failing.
   */
  schedulePending?: boolean;
}): Freshness {
  const { kind, revalidateFailed } = classifyFreshness({
    scoreboardOk: input.scoreboardOk,
    scheduleOk: input.scheduleOk,
    degraded: input.degraded,
    lastGood: input.lastGood,
    pending: input.schedulePending,
  });

  return {
    sourceAt: input.sourceAt,
    coverage: input.coverage,
    scoreboardOk: input.scoreboardOk,
    scheduleOk: input.scheduleOk,
    kind,
    revalidateFailed,
    cachedAt: null,
    ...(input.schedulePending ? { schedulePending: true } : {}),
  };
}

/** The schedule is optional for a detail page, but its state is not. */
async function scheduleState(): Promise<ScheduleIndexState | null> {
  return getScheduleIndexState().catch(() => null);
}

async function loadScoreboard(): Promise<RawScoreboard | null> {
  try {
    return await fetchSource<RawScoreboard>(
      SOURCE.scoreboard,
      SCOREBOARD_TTL_SECONDS,
      15_000,
      isRawScoreboard,
    );
  } catch {
    // Live scores are an enhancement: without them the schedule still answers.
    return null;
  }
}

function liveById(
  scoreboard: RawScoreboard | null,
): Map<string, RawScoreboard["scoreboard"]["games"][number]> {
  return new Map((scoreboard?.scoreboard?.games ?? []).map((game) => [game.gameId, game]));
}

function withinWindow(game: Game, fromMs: number, toMs: number): boolean {
  const time = Date.parse(game.startTime);
  return time >= fromMs && time < toMs;
}

export interface GamesPayload {
  games: Game[];
  freshness: Freshness;
}

export interface ListGamesOptions {
  /**
   * How long to wait for the season schedule before answering from the live
   * scoreboard alone.
   *
   * The schedule is a multi-megabyte document and the scoreboard is ten
   * kilobytes describing today, so on a cold start the app would rather paint
   * today's scores at once and complete the list a moment later than hold the
   * screen on a skeleton until the big document lands. Omit to always wait.
   */
  scheduleDeadlineMs?: number;
}

/** Wait for the schedule, but not longer than the caller's budget. */
function withScheduleBudget<T>(
  promise: Promise<{ status: "ready"; value: T } | { status: "failed" }>,
  deadlineMs: number | undefined,
): Promise<{ status: "ready"; value: T } | { status: "failed" } | { status: "pending" }> {
  if (deadlineMs === undefined) return promise;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "pending" }), deadlineMs);
    promise.then((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}

/**
 * Every game whose tip-off falls inside `[from, to)`, oldest first.
 *
 * The window is computed by the browser from the device's own time zone, so a
 * game is listed on the local calendar day it actually starts on (PRD §6, §28).
 *
 * `options.scheduleDeadlineMs` trades completeness for latency: when the
 * schedule misses the budget the live scoreboard answers alone and the payload
 * carries `schedulePending`, which the client uses to poll again shortly rather
 * than presenting the short list as the whole truth of the day.
 */
export async function listGames(
  from: string,
  to: string,
  options: ListGamesOptions = {},
): Promise<GamesPayload> {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    throw new UpstreamError("Invalid date window");
  }

  // Both feeds start at once; only the schedule is allowed to be late.
  const scheduleOutcome = withScheduleBudget(
    gamesInWindowState(from, to).then(
      (value) => ({ status: "ready" as const, value }),
      () => ({ status: "failed" as const }),
    ),
    options.scheduleDeadlineMs,
  );
  const scoreboardPromise = loadScoreboard();

  const outcome = await scheduleOutcome;
  const scoreboard = await scoreboardPromise;

  const scheduleWindow = outcome.status === "ready" ? outcome.value : null;
  const schedulePending = outcome.status === "pending";
  const schedule = scheduleWindow?.entries ?? null;
  const scheduleDegraded = scheduleWindow?.degraded ?? false;
  const scheduleOk = schedule !== null;
  const scoreboardOk = scoreboard !== null;
  const sourceAt = sourceAtOf(scoreboard);

  // Preferred path: the schedule enumerates the date, the scoreboard refines it.
  if (schedule) {
    return {
      games: overlaySchedule(schedule, liveById(scoreboard), scheduleWindow!.index),
      freshness: freshnessFor({
        sourceAt,
        coverage: "full",
        scheduleOk,
        scoreboardOk,
        // A kept schedule, or a scoreboard that did not answer, means some of
        // this list is not from this round — even though the window is covered.
        degraded: scheduleDegraded || !scoreboardOk,
      }),
    };
  }

  // The 5 MB schedule is unavailable (and any kept copy is past its window),
  // or it is simply slower than the caller's patience. Fall back to what the
  // live feed knows — but be honest about how little that is.
  if (scoreboard) {
    const now = Date.now();
    const coversNow = fromMs <= now && now < toMs;
    return {
      games: scoreboard.scoreboard.games
        .map(normalizeScoreboardGame)
        .filter((game) => withinWindow(game, fromMs, toMs))
        .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)),
      freshness: freshnessFor({
        sourceAt,
        // The scoreboard describes the present. Asked about a past or future
        // date it can return an empty list without meaning "nothing happened",
        // so that answer is ignorance — never an all-clear.
        coverage: coversNow ? "partial" : "unknown",
        scheduleOk,
        scoreboardOk,
        // A schedule that missed the budget is late, not broken: calling this a
        // failed refresh would put a degraded-source warning on every cold start.
        degraded: schedulePending ? false : true,
        schedulePending,
      }),
    };
  }

  throw new UpstreamError("NBA data source unavailable");
}

function overlaySchedule(
  entries: ScheduleEntry[],
  live: Map<string, RawScoreboard["scoreboard"]["games"][number]>,
  index: ScheduleIndex,
): Game[] {
  return entries.map((entry) => {
    const liveGame = live.get(entry.game.id);
    const game = liveGame ? normalizeScoreboardGame(liveGame) : entry.game;
    // Schedule-only labels identify Cup stages when the scoreboard omits them.
    const stage = gameStageFor(game.id, entry.game.label ?? game.label);
    return withSeries({ ...game, stage, label: gameStageLabel(stage, entry.game.label ?? game.label) }, index);
  });
}

function withSeries<T extends Game>(game: T, index: ScheduleIndex | null): T {
  if (!index || game.stage !== "playoffs") return { ...game, series: null };
  // The box/scoreboard may already have the final while the schedule is older.
  const updated = { ...index, entries: index.entries.map((entry) =>
    entry.game.id === game.id ? { ...entry, game } : entry,
  ) };
  return { ...game, series: playoffSeriesFor(game, updated) };
}

export interface DetailPayload {
  game: GameDetail;
  freshness: Freshness;
}

/**
 * How long the detail page will wait for season context.
 *
 * The box score is the page's own document and is worth waiting for; the
 * schedule only supplies the label, the venue and the pre-game context. On a
 * first launch it can still be megabytes behind, and blocking the page on it
 * would repeat the home screen's original bug on every card tap.
 */
const DETAIL_SCHEDULE_BUDGET_MS = 900;

/** Resolve with the promise's value, or `null` once the budget is spent. */
function withinBudget<T>(promise: Promise<T | null>, budgetMs: number): Promise<T | null> {
  return settleWithin(promise, budgetMs).then((settled) => settled.value);
}

/**
 * Wait for a value, but not past the budget — and say whether the budget ran
 * out. On the detail page "the schedule is late" and "the schedule failed" are
 * different answers: one is completed two seconds later, the other is reported.
 */
function settleWithin<T>(promise: Promise<T | null>, budgetMs: number): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    const timer = setTimeout(() => resolve({ value: null, pending: true }), budgetMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value, pending: false });
      },
      () => {
        clearTimeout(timer);
        resolve({ value: null, pending: false });
      },
    );
  });
}

interface Settled<T> {
  value: T | null;
  /** The budget ran out before the promise settled. */
  pending: boolean;
}

/** One game with everything the detail page shows. */
export async function getGameDetail(gameId: string): Promise<DetailPayload> {
  // Both reads start together: season context must never serialise in front of
  // the document the reader actually opened.
  const stateWait = settleWithin(scheduleState(), DETAIL_SCHEDULE_BUDGET_MS);
  const rawPromise = fetchSource<RawBoxScore>(
    SOURCE.boxScore(gameId),
    BOXSCORE_LIVE_TTL_SECONDS,
    15_000,
    isRawBoxScore,
  ).catch(() => null);

  const raw = await rawPromise;
  const { value: state, pending: schedulePending } = await stateWait;
  const entry = state?.index.byId.get(gameId) ?? null;
  const scheduleDegraded = state?.degraded ?? false;
  const scheduleOk = entry !== null;

  if (raw) {
    const detail = normalizeBoxScore(raw, {
      label: entry?.game.label ?? null,
      startTime: entry?.game.startTime ?? null,
    });

    if (detail.status === "final") {
      primeSource(SOURCE.boxScore(gameId), BOXSCORE_FINAL_TTL_SECONDS);
    }

    detail.matchup = await withinBudget(
      getMatchupContext(detail.id, detail.home.id, detail.away.id, detail.startTime),
      DETAIL_SCHEDULE_BUDGET_MS,
    );
    return {
      game: withSeries(detail, state?.index ?? null),
      freshness: freshnessFor({
        sourceAt: sourceAtOf(raw),
        coverage: "full",
        scoreboardOk: true,
        scheduleOk,
        // A schedule that missed the budget is late, not broken.
        degraded: !schedulePending && (scheduleDegraded || !scheduleOk),
        schedulePending,
      }),
    };
  }

  // There is no box score to read. Before tip-off upstream has not written one
  // yet; once a game is under way or over, its absence means we could not read
  // it. The UI separates those two (`detailAvailability`), so the payload only
  // has to state the facts.
  const live = entry ? null : await findLiveGame(gameId);
  const fixture = entry?.game ?? live?.game ?? null;

  if (!fixture) {
    throw new UpstreamError(`No data available for game ${gameId}`);
  }

  const fallback = gameDetailFromGame(fixture, entry?.arena ?? null);
  fallback.matchup = await withinBudget(
    getMatchupContext(fallback.id, fallback.home.id, fallback.away.id, fallback.startTime),
    DETAIL_SCHEDULE_BUDGET_MS,
  );
  const fromLive = live !== null;

  return {
    game: withSeries(fallback, state?.index ?? null),
    freshness: freshnessFor({
      sourceAt: live?.sourceAt ?? null,
      coverage: scheduleOk && fromLive ? "full" : scheduleOk || fromLive ? "partial" : "unknown",
      // The fixture itself is real either way; what is missing is everything
      // the detail page wanted from the feeds that did not answer.
      scheduleOk,
      scoreboardOk: fromLive,
      // The pre-game page is built from the schedule: a schedule still in
      // flight is completed by the next poll, not reported as a failure.
      degraded: !schedulePending && (scheduleDegraded || !scheduleOk),
      schedulePending,
    }),
  };
}

/** The live feed as a last resort for a game the schedule does not list. */
async function findLiveGame(gameId: string): Promise<{ game: Game; sourceAt: string | null } | null> {
  const scoreboard = await loadScoreboard();
  const match = scoreboard?.scoreboard.games.find((game) => game.gameId === gameId);
  if (!match) return null;
  return { game: normalizeScoreboardGame(match), sourceAt: sourceAtOf(scoreboard) };
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

export interface PlaysPayload extends Omit<PlaysResponse, "freshness"> {
  freshness: Freshness;
}

/**
 * Structured events + score flow for the Plays tab.
 *
 * Upstream publishes nothing before tip-off, so an unstarted game is
 * `not-published` rather than an error. Once the game is under way, an empty
 * feed is `unavailable` — a failure, not a calm "not yet".
 *
 * What this must never do is *guess* that a game has not started. The status
 * therefore comes from a feed that actually named it (box score, then
 * play-by-play, then the schedule); if no feed knows the id at all, this is an
 * upstream failure — the route turns it into a 502 — rather than a fabricated
 * pre-game page with a healthy-looking `scheduleOk: true`.
 */
export async function getGamePlays(gameId: string): Promise<PlaysPayload> {
  const [box, pbp, schedule] = await Promise.all([
    fetchSource<RawBoxScore>(SOURCE.boxScore(gameId), BOXSCORE_LIVE_TTL_SECONDS, 15_000, isRawBoxScore).catch(
      () => null,
    ),
    fetchSource<RawPlayByPlay>(
      SOURCE.playByPlay(gameId),
      PLAYS_LIVE_TTL_SECONDS,
      15_000,
      isRawPlayByPlay,
    ).catch(() => null),
    scheduleState(),
  ]);

  const entry = schedule?.index.byId.get(gameId) ?? null;

  // Nothing answered and nothing knows the id: there is no honest payload to
  // build. Saying "not started" here is exactly the defect R6-c describes.
  if (box === null && pbp === null && entry === null) {
    throw new UpstreamError(`NBA data source unavailable for game ${gameId}`);
  }

  const rawStatus =
    box !== null
      ? box.game.gameStatus
      : typeof pbp?.game.gameStatus === "number"
        ? pbp.game.gameStatus
        : null;
  const status: GameStatus =
    rawStatus !== null ? toStatus(rawStatus) : (entry?.game.status ?? "upcoming");

  const boxOk = box !== null;
  const pbpOk = pbp !== null;
  const scheduleOk = entry !== null;
  const started = status !== "upcoming";

  const freshness = freshnessFor({
    sourceAt: sourceAtOf(box) ?? sourceAtOf(pbp),
    coverage: boxOk && pbpOk && scheduleOk ? "full" : boxOk || pbpOk || scheduleOk ? "partial" : "unknown",
    scoreboardOk: boxOk || pbpOk,
    scheduleOk,
    // A feed that came back empty once the game is under way is a failed read,
    // not a quiet "nothing yet"; a kept schedule is not this round's answer.
    degraded: (schedule?.degraded ?? false) || !scheduleOk || (started && (!boxOk || !pbpOk)),
  });

  if (!pbp || pbp.game.actions.length === 0) {
    const state: PlaysState = started ? "unavailable" : "not-published";
    return { gameId, state, status, events: [], flow: [], periods: [], shots: [], freshness };
  }

  const { events, flow, periods, shots } = normalizePlayByPlay(pbp, personNames(box));

  if (status === "final") {
    primeSource(SOURCE.playByPlay(gameId), PLAYS_FINAL_TTL_SECONDS);
    primeSource(SOURCE.boxScore(gameId), BOXSCORE_FINAL_TTL_SECONDS);
  }

  return { gameId, state: "ready", status, events, flow, periods, shots, freshness };
}
