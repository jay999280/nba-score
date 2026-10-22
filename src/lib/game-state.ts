/**
 * Pure rules that decide what a payload is allowed to claim (v0.9).
 *
 * These live apart from the hooks and the components because they are the
 * part worth asserting on: a degraded payload must never be able to move a
 * game backwards, and an empty list must not be reported as "no games today"
 * when we simply do not know. Everything here is a pure function.
 */

import { normalizeFreshness } from "./types";
import type {
  Coverage,
  Freshness,
  FreshnessKind,
  Game,
  GameDetail,
  GameStatus,
  TeamSide,
} from "./types";

/** How far a game has progressed. Only ever used to refuse a backwards move. */
export function statusRank(status: GameStatus): number {
  return status === "final" ? 2 : status === "live" ? 1 : 0;
}

export interface MergeResult {
  games: Game[];
  /**
   * How many games were refused the payload's claim. Counted **per game**, not
   * per field: a game whose score was corrected on one side, on both sides, or
   * whose clock was held back all add exactly 1, and a game carried over
   * because the weaker payload no longer lists it adds 1 as well.
   */
  heldBack: number;
}

/** The signals that decide what a payload may claim (see `classifyFreshness`). */
export interface FreshnessSignals {
  /** The live feed answered this round (scoreboard for lists, box/PBP for detail). */
  scoreboardOk: boolean;
  /** The season schedule answered this round. */
  scheduleOk: boolean;
  /** The payload being returned is a copy kept from an earlier round. */
  lastGood?: boolean;
  /** A feed that should have answered this round did not. */
  degraded?: boolean;
  /**
   * The slower feed is still on its way. A fast answer that is expected to be
   * completed shortly: not a success (the list is not complete yet) and not a
   * failure (nothing went wrong).
   */
  pending?: boolean;
}

/**
 * How much a payload is entitled to claim, from what actually answered.
 *
 * Kept apart from the service layer so the rule itself can be asserted on: a
 * copy kept from an earlier round must never be classified as this round's
 * success, however complete it looks.
 */
export function classifyFreshness(signals: FreshnessSignals): {
  kind: FreshnessKind;
  revalidateFailed: boolean;
} {
  const kept = signals.lastGood === true || signals.degraded === true;
  const anyOk = signals.scoreboardOk || signals.scheduleOk;

  if (signals.scoreboardOk && signals.scheduleOk && !kept) {
    return { kind: "live", revalidateFailed: false };
  }
  // A feed that is merely late must not be libelled as a failed refresh: the
  // interface would then warn about a degraded source on every cold start,
  // which is exactly the banner-blindness the freshness notices exist to avoid.
  if (signals.pending === true && signals.scoreboardOk) {
    return { kind: "partial", revalidateFailed: false };
  }
  if (anyOk) return { kind: "partial", revalidateFailed: kept };
  if (signals.lastGood) return { kind: "last-good", revalidateFailed: true };
  return { kind: "unavailable", revalidateFailed: true };
}

/**
 * Is this payload only part of the picture?
 *
 * Either the window is not fully covered, or a feed that normally answers did
 * not. Both are things the interface has to say out loud on a non-empty list,
 * because an incomplete list shown as a complete one is a false all-clear.
 */
export function isPartialFreshness(freshness: Freshness): boolean {
  const record = normalizeFreshness(freshness);
  return record.coverage !== "full" || !record.scoreboardOk || !record.scheduleOk;
}

/** Live games move on every possession; three polling cycles is already behind. */
export const LIVE_STALE_MS = 90_000;
/** Nothing about an unstarted game changes inside ten minutes. */
export const UPCOMING_STALE_MS = 10 * 60_000;

/**
 * Is the payload too old to be presented as the current state?
 *
 * Age is judged against the rhythm the game itself moves at, not one number
 * for everything: a live game that is 90 seconds behind is stale, an upcoming
 * one is not stale until ten minutes have passed, and a **final** is never
 * called broken merely for being old — a finished score is immutable, so only
 * a failed revalidation (or a copy known to be kept/cached) can make it stale.
 * That last rule is what keeps "已结束" games from sprouting failure warnings
 * hours later.
 */
export function isStaleFreshness(freshness: Freshness, status: GameStatus, now = Date.now()): boolean {
  const record = normalizeFreshness(freshness);

  if (record.kind === "last-good" || record.kind === "unavailable") return true;
  if (record.revalidateFailed) return true;
  if (status === "final") return false;
  if (record.kind === "cache") return true;

  const at = record.sourceAt ? Date.parse(record.sourceAt) : Number.NaN;
  if (!Number.isFinite(at)) return true;
  const age = now - at;
  return status === "live" ? age > LIVE_STALE_MS : age > UPCOMING_STALE_MS;
}

/**
 * Reconcile a fresh list with the last-good one.
 *
 * The schedule and the live scoreboard fail independently. When the scoreboard
 * is missing, the schedule alone still describes the fixture, and its status
 * can lag reality: a game that was 89–94 a moment ago comes back as
 * "upcoming / no score". Publishing that would move the reader backwards and
 * dress it up as a fresh success, so a more advanced known state wins.
 *
 * The reverse rule matters just as much: when both feeds answered this round,
 * the payload is authoritative and a *corrected* score must be accepted even
 * when it is lower than the one we showed (the league fixes its own feed), and
 * a status must be allowed to advance. Only a degraded round is second-guessed.
 *
 * Second-guessing is per team and per period, not on the total: a weaker round
 * may add points it saw, but it may not take back a point we already published
 * for either side, and inside one period it may not move the clock backwards.
 * A larger total is no evidence that each half of it is right.
 */
export function mergeGames(
  previous: Game[] | null,
  next: Game[],
  freshness: Freshness,
): MergeResult {
  if (!previous || previous.length === 0) return { games: next, heldBack: 0 };

  const record = normalizeFreshness(freshness);
  // An authoritative answer always wins outright — nothing to reconcile.
  if (record.kind === "live" && !record.revalidateFailed) return { games: next, heldBack: 0 };

  const before = new Map(previous.map((game) => [game.id, game]));
  let heldBack = 0;

  const merged = next.map((game) => {
    const earlier = before.get(game.id);
    if (!earlier) return game;
    const reconciled = reconcileGame(earlier, game);
    if (reconciled.heldBack) heldBack += 1;
    return reconciled.game;
  });

  // Games the degraded source no longer mentions, but which we know are under
  // way or finished, are carried over rather than silently dropped.
  const seen = new Set(merged.map((game) => game.id));
  for (const game of previous) {
    if (seen.has(game.id)) continue;
    if (game.status === "upcoming") continue;
    merged.push(game);
    heldBack += 1;
  }

  return { games: merged, heldBack };
}

/**
 * The score a weaker payload is allowed to claim for one side.
 *
 * A degraded feed can miss a possession that has already happened, so a *lower*
 * number than the one we already published is not a correction — it is lost
 * information. The rule is per side, never on the total: 89–94 arriving as
 * 88–96 raises the total while still taking a point off the away team, and a
 * higher total is no evidence at all that the away number is right, so the
 * away score stays at 89 while the home score is free to grow. Only a complete
 * round may lower a score, because only a complete round is a correction.
 */
function holdScore(nextScore: number | null, earlierScore: number | null): number | null {
  if (nextScore === null) return earlierScore;
  if (earlierScore === null) return nextScore;
  return nextScore < earlierScore ? earlierScore : nextScore;
}

/** "4:12" → 252 seconds. `null` when the string is not a clock the normalizer produced. */
function clockSeconds(clock: string | null): number | null {
  if (clock === null) return null;
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(clock.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The clock a weaker payload is allowed to claim.
 *
 * Inside one period the clock only counts down, so a *larger* reading in the
 * same period is not progress but a loss of game time — 3:50 arriving as 4:12
 * is two minutes the feed failed to see, and the earlier reading stands. In a
 * *new* period the clock legitimately resets to 12:00, so a larger value there
 * is normal and must not be mistaken for a regression. A period we cannot place
 * (0) keeps the earlier clock, and a clock we cannot parse falls back to what
 * the payload says rather than guessing.
 */
function pickClock(next: Game, earlier: Game): string | null {
  if (next.clock === null) return earlier.clock;
  if (earlier.clock === null) return next.clock;
  if (next.period <= 0 || next.period < earlier.period) return earlier.clock;
  if (next.period > earlier.period) return next.clock;

  const nextSeconds = clockSeconds(next.clock);
  const earlierSeconds = clockSeconds(earlier.clock);
  if (nextSeconds === null || earlierSeconds === null) return next.clock;
  return nextSeconds > earlierSeconds ? earlier.clock : next.clock;
}

function pickPeriods(nextPeriods: TeamSide["periods"], earlierPeriods: TeamSide["periods"], keepEarlier: boolean) {
  if (keepEarlier && earlierPeriods.length > 0) return earlierPeriods;
  return nextPeriods.length > 0 ? nextPeriods : earlierPeriods;
}

function reconcileSide(
  nextSide: TeamSide,
  earlierSide: TeamSide,
  mine: number | null,
  theirs: number | null,
  scoresChanged: boolean,
): TeamSide {
  const winner =
    mine !== null && theirs !== null && mine !== theirs
      ? mine > theirs
      : scoresChanged
        ? false
        : nextSide.winner;

  return {
    ...nextSide,
    score: mine,
    winner,
    // A missing value must not erase a known one.
    record: nextSide.record ?? earlierSide.record,
    periods: pickPeriods(nextSide.periods, earlierSide.periods, scoresChanged),
  };
}

/**
 * One game, when the payload is not authoritative. Every rule here is a
 * "do not lose information" rule: no backwards status, no score that drops
 * without a complete round to vouch for it, no clock that runs backwards inside
 * a period, and no null overwriting a known score, period or clock.
 */
function reconcileGame(earlier: Game, next: Game): { game: Game; heldBack: boolean } {
  if (statusRank(next.status) < statusRank(earlier.status)) {
    return { game: earlier, heldBack: true };
  }

  const awayScore = holdScore(next.away.score, earlier.away.score);
  const homeScore = holdScore(next.home.score, earlier.home.score);

  const period = next.period > 0 ? Math.max(next.period, earlier.period) : earlier.period;
  const clock = pickClock(next, earlier);

  // If the period or clock had to come from the earlier copy, its status line
  // is the one that matches the numbers we are showing: `liveStatusText` folds
  // the clock into that text ("第3节 · 4:12"), so a held-back clock shown with
  // the payload's own text would print two different times for one game.
  const staleProgress = period !== next.period || next.clock === null || clock !== next.clock;
  const statusText = staleProgress
    ? earlier.statusText || next.statusText
    : next.statusText || earlier.statusText;

  const scoresChanged = awayScore !== next.away.score || homeScore !== next.home.score;
  const away = reconcileSide(next.away, earlier.away, awayScore, homeScore, scoresChanged);
  const home = reconcileSide(next.home, earlier.home, homeScore, awayScore, scoresChanged);

  const heldBack =
    scoresChanged || period !== next.period || clock !== next.clock || statusText !== next.statusText;

  if (!heldBack) return { game: next, heldBack: false };
  return {
    game: {
      ...next,
      statusText,
      period,
      clock,
      label: next.label ?? earlier.label,
      away,
      home,
    },
    heldBack: true,
  };
}

/**
 * What an empty list actually means. Only a full-coverage answer is entitled
 * to say "there are no games"; anything less is an admission that we could not
 * check, and the reader deserves that wording instead of a false all-clear.
 */
export function emptyListMeaning(coverage: Coverage): "none" | "unknown" {
  return coverage === "full" ? "none" : "unknown";
}

export type DetailAvailability =
  /** Box score and team stats are present. */
  | "ready"
  /** The game has not started; upstream has published nothing yet. */
  | "not-started"
  /** The game is under way or over, but its statistics could not be read. */
  | "stats-unavailable";

/**
 * Which of the three states the detail page is in.
 *
 * A live or finished game with no statistics must never fall back to the
 * "not started yet" panel: that is a different, wrong statement. Before
 * tip-off the empty state is the truth; afterwards it is a failure to load.
 */
export function detailAvailability(game: Pick<GameDetail, "status" | "stats" | "boxScore">): DetailAvailability {
  const hasBox =
    game.boxScore.home.players.length > 0 || game.boxScore.away.players.length > 0;
  const hasStats = game.stats.length > 0;

  if (hasBox || hasStats) return "ready";
  return game.status === "upcoming" ? "not-started" : "stats-unavailable";
}

export type BoxAvailability =
  /** At least one side has player lines. */
  | "ready"
  /** The game has not started; upstream has published nothing yet. */
  | "not-started"
  /** Team stats are there, but no player line is: the table is empty, not blank. */
  | "empty"
  /** The game is under way or over, but the player statistics could not be read. */
  | "unavailable";

/**
 * Availability of the player table **alone**.
 *
 * `detailAvailability` answers for the whole detail page, and it is right to:
 * one populated section is enough to render the page. The box score is a
 * different question. Team stats can arrive while every `players` array is
 * still empty, and the table then shows its header and nothing else — which
 * reads as "these players scored nothing" instead of "this data did not
 * arrive". Only the table's own inputs decide here.
 *
 * `not-started` and `unavailable` keep the page-level distinction intact: a
 * game that has not begun has genuinely published nothing, while a live or
 * finished game with no statistics is a read failure, and saying "not started"
 * about it would be false.
 */
export function boxAvailability(
  game: Pick<GameDetail, "status" | "stats" | "boxScore">,
): BoxAvailability {
  const hasPlayers =
    game.boxScore.home.players.length > 0 || game.boxScore.away.players.length > 0;
  if (hasPlayers) return "ready";

  if (game.stats.length > 0) return "empty";

  return detailAvailability(game) === "not-started" ? "not-started" : "unavailable";
}

/** How the interface should present a payload's provenance. */
export type FreshnessTone =
  /** Nothing to say: fresh, complete, answered this round. */
  | "none"
  /** The list is real but incomplete, or a feed that normally answers did not. */
  | "partial"
  /** A copy kept from an earlier round, or an offline cache hit. */
  | "stale"
  /** Nothing could be read at all. */
  | "unavailable";

export interface FreshnessNotice {
  tone: FreshnessTone;
  /** Appended to the source-time line, e.g. "· 离线缓存". */
  badge: string;
  /** The one-line explanation; empty when `tone` is "none". */
  label: string;
}

/** The two game fields the age rule looks at. */
export interface FreshnessSubject {
  status: GameStatus;
  /** Tip-off, ISO. */
  startTime?: string;
}

/**
 * Is one game's data old enough to be called out?
 *
 * Same as `isStaleFreshness`, with one refinement learned from the real feed:
 * **an unstarted game whose tip-off is still in the future is not "behind".**
 *
 * Upstream's `meta.time` is not reliably current — measured against
 * `cdn.nba.com` on 2026-10-10 it read `01:31Z` while the wall clock was
 * `17:31Z`, sixteen hours behind, on a payload whose fixtures were correctly
 * listed as tonight's games. Judging an upcoming game by that timestamp put a
 * permanent "数据源更新已经落后" banner on an ordinary home page, which is a
 * false alarm and would train the reader to ignore the notice entirely.
 *
 * The refinement does not weaken the real case: when a live feed fails and the
 * schedule reports a game that has *already tipped off* as upcoming, its
 * startTime is in the past, so the age rule still fires. Only "it has not
 * started yet, and nothing about it can have changed" is exempt.
 */
function isSubjectStale(
  record: Freshness,
  subject: FreshnessSubject,
  now: number,
): boolean {
  if (record.kind === "last-good" || record.kind === "unavailable") return true;
  if (record.revalidateFailed) return true;
  if (record.kind === "cache") return true;
  if (subject.status === "final") return false;

  if (subject.status === "upcoming" && subject.startTime) {
    const tipoff = Date.parse(subject.startTime);
    if (Number.isFinite(tipoff) && tipoff > now) return false;
  }

  return isStaleFreshness(record, subject.status, now);
}

/** The Chinese badge for each provenance kind, or "" when there is nothing to add. */
function badgeFor(kind: FreshnessKind): string {
  switch (kind) {
    case "cache":
      return "离线缓存";
    case "last-good":
      return "此后未更新";
    case "unavailable":
      return "无法访问数据源";
    case "partial":
      return "部分数据源未返回";
    default:
      return "";
  }
}

/**
 * Decide what a payload must admit about itself.
 *
 * `sourceAt` is the only timestamp allowed here — the client's own receive
 * time says when *we* fetched, which is not when the score became true, and
 * showing it as "更新于" is exactly the substitution the review rejected.
 * Age is judged by `isSubjectStale`, so a finished game is not flagged for
 * being old, a live one is flagged within 90 seconds, and a game that has not
 * tipped off yet is not flagged at all.
 *
 * `subjects` is the set of games whose states matter; pass a single entry for
 * one game's payload.
 */
export function freshnessNotice(
  freshness: Freshness,
  subjects: FreshnessSubject[],
  now = Date.now(),
): FreshnessNotice {
  const record = normalizeFreshness(freshness);
  const badge = badgeFor(record.kind);

  if (record.kind === "unavailable") {
    return { tone: "unavailable", badge, label: "暂时读不到数据源，稍后自动重试" };
  }

  /**
   * A payload that is still being completed is not stale. The slow feed is
   * *late*, not missing, and the fast feed this answer is built from replied
   * just now — warning about age here would be a false alarm on every cold
   * start, and a warning nobody believes is worse than no warning.
   */
  if (record.schedulePending) {
    return { tone: "partial", badge: "", label: "赛程还在加载，先显示实时比分" };
  }

  /**
   * A list can be ready and still be behind: one game's live scoreboard may be
   * an hour old while another about to tip off is current. Judging the payload
   * by its *most advanced* state would hide that, so the fastest-moving game on
   * screen decides whether the list as a whole is presentable as current.
   */
  const stale = subjects.some((subject) => isSubjectStale(record, subject, now));
  if (stale) {
    const why =
      record.kind === "cache"
        ? "离线缓存，比分可能已经变化"
        : record.kind === "last-good" || record.revalidateFailed
          ? "本次刷新没有成功，显示的是上一次读到的数据"
          : "数据源更新已经落后";
    return { tone: "stale", badge, label: why };
  }

  if (isPartialFreshness(record)) {
    return { tone: "partial", badge, label: "只有部分数据源返回，列表可能不完整" };
  }

  return { tone: "none", badge, label: "" };
}
