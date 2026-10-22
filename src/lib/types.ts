/**
 * Internal data model.
 *
 * The NBA's raw payloads must never leak past the normalize layer (PRD §24),
 * so every component in this app speaks only the types below.
 */

export type GameStatus = "live" | "upcoming" | "final";

export type GameStage = "preseason" | "regular-season" | "playoffs" | "play-in" | "nba-cup-final" | "all-star" | "summer-league" | "unknown";

export interface PlayoffSeries {
  homeWins: number;
  awayWins: number;
  gameNumber: number | null;
  round: string | null;
  source: "schedule" | "upstream";
}

export interface TeamStanding {
  teamId: number;
  tricode: string;
  name: string;
  conference: "East" | "West";
  rank: number | null;
  wins: number;
  losses: number;
  winPct: number | null;
  gamesBehind: string | null;
}

export interface StandingsResponse {
  season: string;
  source?: "ESPN" | "NBA schedule";
  sourceAt: string | null;
  fetchedAt: string;
  state: "ready" | "not-started";
  stale: boolean;
  teams: TeamStanding[];
}

export interface PeriodScore {
  period: number;
  score: number | null;
}

export interface TeamSide {
  id: number;
  /** "LAL" */
  tricode: string;
  /** "Los Angeles" */
  city: string;
  /** "Lakers" */
  name: string;
  /** "Los Angeles Lakers" */
  fullName: string;
  /** null before tip-off */
  score: number | null;
  winner: boolean;
  /** "3-1" for the current season, null when the season record is empty */
  record: string | null;
  periods: PeriodScore[];
  /** Crest path served by our own API, derived from the team id */
  logo: string;
  /** Brand accent used sparingly: logo tint, hover, favorite marker (PRD §19) */
  color: string;
}

export interface Game {
  id: string;
  status: GameStatus;
  /** Human status: "Final", "Q4 · 6:21", "7:30 PM", "Halftime", "Postponed" */
  statusText: string;
  /** 1-4, >4 for overtime, 0 when unknown */
  period: number;
  /** "6:21" countdown within the period, null when not applicable */
  clock: string | null;
  /** Tip-off in ISO UTC */
  startTime: string;
  /** "Regular Season" | "Preseason" | "Playoffs", null when unknown */
  label: string | null;
  /** Optional only for cached payloads from earlier app versions. */
  stage?: GameStage;
  /** This playoff series through this game; never regular-season head-to-head. */
  series?: PlayoffSeries | null;
  postponed: boolean;
  home: TeamSide;
  away: TeamSide;
}

export interface Leader {
  personId: number;
  name: string;
  tricode: string;
  points: number;
  rebounds: number;
  assists: number;
}

export interface StatRow {
  label: string;
  home: string;
  away: string;
}

export interface PlayerLine {
  personId: number;
  name: string;
  jersey: string;
  position: string;
  starter: boolean;
  minutes: string;
  points: number;
  rebounds: number;
  assists: number;
  /** "8-17" */
  fg: string;
  /** "3-8" */
  threePt: string;
  /** "4-5" */
  ft: string;
  plusMinus: number;
  steals: number;
  blocks: number;
  turnovers: number;
  fouls: number;
}

export interface TeamBox {
  id: number;
  tricode: string;
  name: string;
  players: PlayerLine[];
}

export interface TeamLeaders {
  points: Leader | null;
  rebounds: Leader | null;
  assists: Leader | null;
}

export type GameResult = "W" | "L";

export interface TeamForm {
  /** Most recent first, up to five */
  last5: GameResult[];
  streak: { result: GameResult; count: number } | null;
}

export interface MatchupContext {
  home: TeamForm;
  away: TeamForm;
  /** Season head-to-head finals, from this game's home-team perspective */
  seriesHome: number;
  seriesAway: number;
  meetings: number;
}

export interface GameDetail extends Game {
  arena: string | null;
  leaders: { home: TeamLeaders; away: TeamLeaders };
  /** Past form + head-to-head, null when the schedule is unreachable */
  matchup: MatchupContext | null;
  /** Team stat comparison, ordered for Overview (PRD §14) */
  stats: StatRow[];
  boxScore: { home: TeamBox; away: TeamBox };
}

/**
 * How much of a request the payload can actually vouch for (v0.9).
 *
 * The distinction matters because the two upstream feeds fail independently:
 * the schedule enumerates the whole season, the scoreboard only describes the
 * present. When the schedule is missing, "no games in this window" is a claim
 * we are not entitled to make — that is `unknown`, not an empty list.
 *
 * - `full`    — the authoritative schedule answered this window.
 * - `partial` — only the live scoreboard answered, and it covers this window.
 * - `unknown` — only the live scoreboard answered, and it says nothing about
 *               this window (a historical or future date).
 */
export type Coverage = "full" | "partial" | "unknown";

/**
 * How much this round's payload is entitled to claim (v0.9).
 *
 * Coverage says *how much* of the question was answered; kind says *how* the
 * answer was obtained. A cached or kept copy can cover the whole window and
 * still be hours old, so the two facts are tracked separately — the interface
 * needs both to avoid presenting stale scores as live ones.
 *
 * - `live`        — every feed this payload needs answered this round.
 * - `cache`       — the service worker's offline copy (marked `X-DSH-From-Cache`).
 * - `last-good`   — nothing answered, so a copy kept from an earlier round is shown.
 * - `partial`     — only some of the feeds answered this round.
 * - `unavailable` — nothing can be confirmed.
 */
export type FreshnessKind = "live" | "cache" | "last-good" | "partial" | "unavailable";

/**
 * Freshness and provenance for one payload. Deliberately not a timestamp the
 * client invents: `sourceAt` is the upstream's own data time — always a valid
 * ISO string, normalized by `parseUpstreamTime` — and the client's receive
 * time is tracked separately by the polling hook.
 */
export interface Freshness {
  /** Upstream's own data time (ISO UTC), null when the source does not date itself. */
  sourceAt: string | null;
  coverage: Coverage;
  /** The live scoreboard feed answered this round. */
  scoreboardOk: boolean;
  /** The season schedule feed answered this round. */
  scheduleOk: boolean;
  /** How this round's payload was obtained. */
  kind: FreshnessKind;
  /** The last upstream refresh failed and this payload is a copy from before it. */
  revalidateFailed: boolean;
  /**
   * The slower feed is still loading.
   *
   * The season schedule is a multi-megabyte document that cannot arrive as fast
   * as the live scoreboard, so the list is answered from the scoreboard first
   * and completed when the schedule lands. That is a *not yet*, never a failed
   * read: presenting it as degraded would put a "数据源未返回" warning on an
   * ordinary cold start, and presenting the list as complete would claim more
   * than the payload can vouch for. Both are why this is its own flag.
   */
  schedulePending?: boolean;
  /** When the offline copy was written (ISO), null for a live read. */
  cachedAt?: string | null;
}

function isFreshnessKind(value: unknown): value is FreshnessKind {
  return (
    value === "live" ||
    value === "cache" ||
    value === "last-good" ||
    value === "partial" ||
    value === "unavailable"
  );
}

/**
 * Fill a freshness record in from whatever shape it arrived in.
 *
 * `kind` and `revalidateFailed` are required on the model, but three sources
 * can hand over an older shape: a payload the service worker cached before the
 * upgrade, a test fixture written by hand, and a server running the previous
 * build during a deploy. Rather than asserting at every read site, callers
 * pass the value through here. The argument is `unknown` on purpose: a
 * malformed body must degrade to `unavailable`, never throw inside a render.
 *
 * Missing fields are derived conservatively — the only guess is
 * `scoreboardOk && scheduleOk` meaning this round succeeded.
 */
export function normalizeFreshness(input: unknown): Freshness {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  const coverage: Coverage =
    raw.coverage === "full" || raw.coverage === "partial" || raw.coverage === "unknown"
      ? raw.coverage
      : "unknown";
  const scoreboardOk = raw.scoreboardOk === true;
  const scheduleOk = raw.scheduleOk === true;
  const sourceAt = typeof raw.sourceAt === "string" && raw.sourceAt.length > 0 ? raw.sourceAt : null;
  const cachedAt = typeof raw.cachedAt === "string" && raw.cachedAt.length > 0 ? raw.cachedAt : null;

  const kind: FreshnessKind = isFreshnessKind(raw.kind)
    ? raw.kind
    : scoreboardOk && scheduleOk
      ? "live"
      : scoreboardOk || scheduleOk
        ? "partial"
        : "unavailable";

  const revalidateFailed =
    typeof raw.revalidateFailed === "boolean"
      ? raw.revalidateFailed
      : kind === "last-good" || kind === "unavailable" || kind === "cache";

  const schedulePending = raw.schedulePending === true ? true : undefined;

  return {
    sourceAt,
    coverage,
    scoreboardOk,
    scheduleOk,
    kind,
    revalidateFailed,
    cachedAt,
    ...(schedulePending ? { schedulePending } : {}),
  };
}

export interface GamesResponse {
  /** Local calendar date the window belongs to, as requested by the client */
  date: string;
  games: Game[];
  freshness: Freshness;
}

export interface GameDetailResponse {
  game: GameDetail;
  freshness: Freshness;
}

export interface PlayEvent {
  /** Upstream actionNumber, stable within a game */
  id: number;
  period: number;
  /** "6:21" remaining in the period, null when unknown */
  clock: string | null;
  teamId: number | null;
  tricode: string | null;
  /** Team accent for scoring plays, neutral otherwise */
  color: string;
  scoring: boolean;
  /** Fourth quarter or overtime, last 2:00, margin within 5 */
  clutch: boolean;
  /** Structured Chinese, e.g. "卢卡·东契奇 三分命中" */
  text: string;
  /** Assist, distance and similar, or null */
  detail: string | null;
  /** Running total, away first like the period table; null when unknown */
  awayScore: number | null;
  homeScore: number | null;
}

export interface FlowPoint {
  /** Elapsed game minutes from tip-off */
  t: number;
  /** Home minus away */
  margin: number;
}

export interface Shot {
  /** Feet from the attacking baseline, 0–47 */
  x: number;
  /** Feet from center court, -25–25 */
  y: number;
  made: boolean;
  teamId: number | null;
  tricode: string | null;
}

/**
 * Why the plays feed has nothing, when it has nothing.
 *
 * "Upstream has not written this file yet" (before tip-off) and "we could not
 * read it" (once the game is under way) are different facts, and the UI must
 * not tell a reader that a live game "has not started".
 */
export type PlaysState = "ready" | "not-published" | "unavailable";

export interface PlaysResponse {
  gameId: string;
  state: PlaysState;
  status: GameStatus;
  /** Latest first, grouped by the UI */
  events: PlayEvent[];
  /** Oldest first, for the chart */
  flow: FlowPoint[];
  /** Field-goal attempts with coordinates, for the shot chart */
  shots: Shot[];
  /** Periods present in the data, ascending */
  periods: number[];
  freshness: Freshness;
}

/* ------------------------------------------------------------------ *
 * Pre-game season comparison and probable lineups (v1.2)
 *
 * Both blocks exist only for a game that has not started, and both are built
 * from sources the NBA feeds do not carry: ESPN's public season statistics and
 * roster, plus the box score of each team's most recent completed game.
 * ------------------------------------------------------------------ */

/**
 * One row of the two-column pre-game comparison.
 *
 * Values are formatted strings, not numbers: the comparison mixes counting
 * stats ("115.9") with percentages ("46.2%"), and the service layer is the one
 * place that knows how each source encodes them. `null` means "this side has no
 * value" — the interface renders it as an em dash plus an explanatory line, so
 * a missing source can never look like a zero.
 */
export interface SeasonComparisonRow {
  /** Stable key for tests and for React list identity. */
  key: string;
  label: string;
  away: string | null;
  home: string | null;
}

/**
 * - `ready`      — at least one side has regular-season numbers.
 * - `no-games`   — neither side has completed a regular-season game this season.
 * - `unavailable`— games exist, but the statistics feed did not answer.
 */
export type SeasonComparisonState = "ready" | "no-games" | "unavailable";

/**
 * - `ready`      — this side has regular-season numbers.
 * - `no-games`   — the team has not completed a regular-season game yet.
 * - `unavailable`— games exist, but the statistics feed did not answer.
 */
export type SeasonComparisonSide = "ready" | "no-games" | "unavailable";

/** This season's regular-season comparison for the two teams about to play. */
export interface SeasonComparison {
  /** NBA season label, e.g. "2026-27". */
  season: string;
  state: SeasonComparisonState;
  /** Ordered for the UI; empty unless `state === "ready"`. */
  rows: SeasonComparisonRow[];
  /** Why each side is blank or populated, so the UI can say which one is missing why. */
  sides: { away: SeasonComparisonSide; home: SeasonComparisonSide };
}

/** One player in a pre-game lineup, with this season's per-game averages. */
export interface LineupPlayer {
  /** ESPN athlete id when the player could be matched to the ESPN roster; "" otherwise. */
  espnId: string;
  name: string;
  /** As published: "PG"/"SG"/"SF"/"PF"/"C" after a completed game, "G"/"F"/"C" from the roster. */
  position: string;
  jersey: string;
  /** Per-game averages; null when the player has no regular-season statistics yet. */
  points: number | null;
  rebounds: number | null;
  assists: number | null;
}

/**
 * - `last-game`  — the five starters of the team's most recent completed game.
 * - `roster`     — no completed game yet, so the season roster supplies a
 *                  positional list (explicitly not an official starting five).
 * - `unavailable`— neither the box score nor the roster could be read.
 */
export type LineupBasis = "last-game" | "roster" | "unavailable";

/** The completed game a `last-game` lineup was taken from. */
export interface LineupSourceGame {
  id: string;
  startTime: string;
  opponentTricode: string;
  /** Chinese competition label, e.g. "季前赛" / "常规赛". */
  label: string | null;
}

export interface TeamLineup {
  teamId: number;
  basis: LineupBasis;
  /** Set only for `last-game`. */
  sourceGame: LineupSourceGame | null;
  /**
   * Completed games (any competition stage) the season schedule already knows
   * for this team. Zero explains a roster fallback as "the season has not
   * produced a game yet"; the interface needs that distinction to say why.
   */
  completedGames: number;
  players: LineupPlayer[];
}

/**
 * Payload of `GET /api/games/[gameId]/lineups`.
 *
 * The lazy roster block and the eagerly loaded comparison share one endpoint so
 * the Web API and the native (in-WebView) service layer return the same shape;
 * the optional `section` query narrows which half is computed. When a section is
 * omitted the corresponding fields are empty (`state: "unavailable"` / basis
 * `unavailable`), never fabricated.
 */
export interface LineupsResponse {
  gameId: string;
  season: string;
  comparison: SeasonComparison;
  lineups: { away: TeamLineup; home: TeamLineup };
}

/** Which half of {@link LineupsResponse} a request needs. */
export type LineupsSection = "comparison" | "lineups";
