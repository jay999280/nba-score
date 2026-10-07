/**
 * Internal data model.
 *
 * The NBA's raw payloads must never leak past the normalize layer (PRD §24),
 * so every component in this app speaks only the types below.
 */

export type GameStatus = "live" | "upcoming" | "final";

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

export interface GamesResponse {
  /** Local calendar date the window belongs to, as requested by the client */
  date: string;
  games: Game[];
  updatedAt: string;
}

export interface GameDetailResponse {
  game: GameDetail;
  updatedAt: string;
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

export interface PlaysResponse {
  gameId: string;
  /** False before tip-off (upstream publishes nothing yet) */
  available: boolean;
  status: GameStatus;
  /** Latest first, grouped by the UI */
  events: PlayEvent[];
  /** Oldest first, for the chart */
  flow: FlowPoint[];
  /** Field-goal attempts with coordinates, for the shot chart */
  shots: Shot[];
  /** Periods present in the data, ascending */
  periods: number[];
  updatedAt: string;
}
