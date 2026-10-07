/**
 * Types for the raw NBA Live Data payloads.
 *
 * These describe the upstream JSON only. Nothing outside `src/lib/nba`
 * should import from this file (PRD §24, PRD §38.5).
 */

export interface RawPeriod {
  period: number;
  periodType: string;
  score: number | null;
}

export interface RawScoreboardTeam {
  teamId: number;
  teamName: string;
  teamCity: string;
  teamTricode: string;
  wins: number;
  losses: number;
  score: number;
  periods: RawPeriod[];
}

export interface RawLeader {
  personId: number;
  name: string;
  teamTricode: string;
  points: number;
  rebounds: number;
  assists: number;
}

export interface RawScoreboardGame {
  gameId: string;
  gameCode: string;
  gameStatus: number;
  gameStatusText: string;
  period: number;
  gameClock: string;
  gameTimeUTC: string;
  regulationPeriods: number;
  gameLabel: string;
  gameSubLabel: string;
  homeTeam: RawScoreboardTeam;
  awayTeam: RawScoreboardTeam;
  gameLeaders?: {
    homeLeaders?: RawLeader | null;
    awayLeaders?: RawLeader | null;
  };
}

export interface RawScoreboard {
  meta: { time: string; code: number };
  scoreboard: {
    gameDate: string;
    leagueId: string;
    leagueName: string;
    games: RawScoreboardGame[];
  };
}

export interface RawScheduleTeam {
  teamId: number;
  teamName: string;
  teamCity: string;
  teamTricode: string;
  teamSlug: string;
  wins: number;
  losses: number;
  score: number;
  seed: number;
}

export interface RawScheduleGame {
  gameId: string;
  gameCode: string;
  gameStatus: number;
  gameStatusText: string;
  gameSequence: number;
  /** e.g. "2026-10-03T00:00:00Z" */
  gameDateEst: string;
  /** e.g. "2026-10-03T23:00:00Z" */
  gameDateTimeUTC: string;
  gameDateUTC: string;
  gameTimeUTC: string;
  day: string;
  monthNum: number;
  gameLabel: string;
  gameSubLabel: string;
  arenaName: string;
  arenaCity: string;
  arenaState: string;
  postponedStatus: string;
  homeTeam: RawScheduleTeam;
  awayTeam: RawScheduleTeam;
}

export interface RawSchedule {
  leagueSchedule: {
    seasonYear: string;
    leagueId: string;
    /** `gameDate` is formatted "10/03/2026 00:00:00" */
    gameDates: { gameDate: string; games: RawScheduleGame[] }[];
  };
}

export interface RawBoxScoreTeamStats {
  points: number;
  reboundsTotal: number;
  reboundsOffensive: number;
  assists: number;
  turnovers: number;
  steals: number;
  blocks: number;
  fieldGoalsPercentage: number;
  threePointersPercentage: number;
  freeThrowsPercentage: number;
  fieldGoalsMade: number;
  fieldGoalsAttempted: number;
  threePointersMade: number;
  threePointersAttempted: number;
  freeThrowsMade: number;
  freeThrowsAttempted: number;
  pointsInThePaint: number;
  pointsFastBreak: number;
  pointsFromTurnovers: number;
  benchPoints: number;
  biggestLead: number;
}

export interface RawBoxScorePlayerStats {
  minutes: string;
  points: number;
  reboundsTotal: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  foulsPersonal: number;
  plusMinusPoints: number;
  fieldGoalsMade: number;
  fieldGoalsAttempted: number;
  threePointersMade: number;
  threePointersAttempted: number;
  freeThrowsMade: number;
  freeThrowsAttempted: number;
}

export interface RawBoxScorePlayer {
  personId: number;
  name: string;
  nameI: string;
  firstName: string;
  familyName: string;
  jerseyNum: string;
  position: string;
  starter: string;
  status: string;
  /** "1" when the player saw the floor */
  played: string;
  statistics: RawBoxScorePlayerStats;
}

export interface RawBoxScoreTeam {
  teamId: number;
  teamName: string;
  teamCity: string;
  teamTricode: string;
  score: number;
  periods: RawPeriod[];
  players: RawBoxScorePlayer[];
  statistics: RawBoxScoreTeamStats;
}

export interface RawBoxScore {
  meta: { time: string; code: number };
  game: {
    gameId: string;
    gameCode: string;
    gameStatus: number;
    gameStatusText: string;
    period: number;
    gameClock: string;
    gameTimeUTC: string;
    regulationPeriods: number;
    duration: string;
    attendance: string;
    arena: { arenaName: string; arenaCity: string; arenaState: string };
    officials: { name: string; jerseyNum: string; position: string }[];
    homeTeam: RawBoxScoreTeam;
    awayTeam: RawBoxScoreTeam;
  };
}

export interface RawPlayAction {
  actionNumber: number;
  /** Remaining in the period, e.g. "PT06M21.00S" */
  clock: string;
  period: number;
  teamId: number | null;
  teamTricode?: string;
  /** "2pt" | "3pt" | "freethrow" | "rebound" | "turnover" | "foul" | "steal" | "block" | "timeout" | "violation" | "jumpball" | "substitution" | "period" | "game" | "heave" | "ejection" ... */
  actionType: string;
  /** "Made" context lives in shotResult; subType is e.g. "Layup", "personal", "defensive", "full" */
  subType: string;
  qualifiers: string[];
  personId?: number;
  /** Surname only, e.g. "Alexander-Walker" — resolve via personId */
  playerName?: string;
  playerNameI?: string;
  assistPersonId?: number;
  assistPlayerNameInitial?: string;
  /** Strings, e.g. "3" */
  scoreHome: string;
  scoreAway: string;
  /** "Made" | "Missed" | undefined */
  shotResult?: string;
  shotDistance?: number;
  /** Court units: x 0–100 across, y 0–100 full length */
  x?: number;
  y?: number;
  isFieldGoal?: number;
  description: string;
}

export interface RawPlayByPlay {
  meta: { time: string; code: number };
  game: {
    gameId: string;
    gameStatus?: number;
    actions: RawPlayAction[];
  };
}
