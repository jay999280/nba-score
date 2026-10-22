/**
 * Normalize layer: NBA raw payloads → the internal model (PRD §24).
 *
 * Every upstream quirk (status codes, ISO-8601 clocks, ET-formatted status
 * strings, `played: "1"` flags) is resolved here so that no component ever
 * has to know about it.
 */

import type {
  Game,
  GameDetail,
  GameStatus,
  FlowPoint,
  Leader,
  PeriodScore,
  PlayEvent,
  PlayerLine,
  Shot,
  StatRow,
  TeamBox,
  TeamLeaders,
  TeamSide,
} from "@/lib/types";
import {
  formatPercentage,
  formatShooting,
  parseClock,
  parseMinutes,
  periodLabel,
} from "@/lib/format";
import { teamAccent, teamCityZh, teamLogo, teamNameZh } from "./team-meta";
import { TEAM_CATALOG } from "./team-catalog";
import { playerNameZh } from "./player-names";
import { gameStageFor, gameStageLabel } from "./game-stage";
import type {
  RawBoxScore,
  RawBoxScorePlayer,
  RawBoxScoreTeam,
  RawPeriod,
  RawPlayAction,
  RawPlayByPlay,
  RawScheduleGame,
  RawScoreboardGame,
} from "./raw";

/** The NBA scores a game 1 = scheduled, 2 = in progress, 3 = final. */
export function toStatus(gameStatus: number): GameStatus {
  if (gameStatus === 2) return "live";
  if (gameStatus === 3) return "final";
  return "upcoming";
}

function isPostponed(gameStatusText: string, postponedStatus?: string): boolean {
  return postponedStatus === "P" || /postpon/i.test(gameStatusText);
}

function toRecord(wins: number | undefined, losses: number | undefined): string | null {
  if (typeof wins !== "number" || typeof losses !== "number") return null;
  if (wins + losses === 0) return null;
  return `${wins}-${losses}`;
}

function toPeriods(periods: RawPeriod[] | undefined): PeriodScore[] {
  if (!Array.isArray(periods)) return [];
  return periods
    .filter((period) => period.period > 0)
    .map((period) => ({ period: period.period, score: period.score ?? null }));
}

interface TeamInput {
  teamId: number;
  teamName: string;
  teamCity: string;
  teamTricode: string;
  score?: number | null;
  wins?: number;
  losses?: number;
}

function toTeamSide(input: TeamInput, periods: PeriodScore[], includeRecord = true): TeamSide {
  const tricode = input.teamTricode;
  const city = teamCityZh(tricode, input.teamCity ?? "");
  const name = teamNameZh(tricode, input.teamName ?? "");
  return {
    id: input.teamId,
    tricode,
    city,
    name,
    fullName: `${city}${name}`,
    score: typeof input.score === "number" ? input.score : null,
    winner: false,
    record: includeRecord ? toRecord(input.wins, input.losses) : null,
    periods,
    logo: teamLogo(input.teamId),
    color: teamAccent(tricode),
  };
}

/** Final games mark the higher score as the winner; ties never happen. */
function markWinner(away: TeamSide, home: TeamSide, status: GameStatus): void {
  if (status !== "final") return;
  if (away.score === null || home.score === null || away.score === home.score) return;
  if (away.score > home.score) away.winner = true;
  else home.winner = true;
}

/** "Q4 6:21" / "OT 2:11" — the schedule feed's compact live wording. */
function parseLiveStatusText(text: string): { period: number; clock: string | null } | null {
  const trimmed = (text ?? "").trim();
  const quarter = /^Q(\d)\s+(\d{1,2}:\d{2})$/.exec(trimmed);
  if (quarter) return { period: Number(quarter[1]), clock: quarter[2] };
  const overtime = /^OT(\d?)\s*(\d{1,2}:\d{2})?$/.exec(trimmed);
  if (overtime) {
    return { period: 4 + (overtime[1] ? Number(overtime[1]) : 1), clock: overtime[2] ?? null };
  }
  return null;
}

/** Upstream writes its status lines in English; the interface does not. */
const UPSTREAM_STATUS_ZH: Record<string, string> = {
  Halftime: "中场休息",
  "End of Halftime": "中场休息",
  Overtime: "加时",
  "End of Overtime": "加时结束",
  Postponed: "延期",
  Suspended: "暂停",
  Delayed: "延迟",
};

function statusTextZh(upstreamText: string, period: number): string {
  const text = (upstreamText ?? "").trim();
  if (!text) return periodLabel(period) || "进行中";

  const known = UPSTREAM_STATUS_ZH[text];
  if (known) return known;

  const endOfQuarter = /^End of (\d)(?:st|nd|rd|th) Qtr$/i.exec(text);
  if (endOfQuarter) return `第${endOfQuarter[1]}节结束`;

  if (/^(end of )?(ot|overtime)/i.test(text)) return "加时";

  const quarter = /^Q(\d)\s+(\d{1,2}:\d{2})$/.exec(text);
  if (quarter) return `第${quarter[1]}节 · ${quarter[2]}`;

  if (/^final/i.test(text)) return "已结束";
  if (/postpon/i.test(text)) return "延期";

  return text;
}

/** "第4节 · 6:21" while the clock runs, otherwise the league's own wording. */
function liveStatusText(
  period: number,
  clock: string | null,
  regulationPeriods: number,
  upstreamText: string,
): string {
  if (clock) {
    const label = periodLabel(period, regulationPeriods);
    return label ? `${label} · ${clock}` : clock;
  }
  return statusTextZh(upstreamText, period);
}

function finalStatusText(period: number, regulationPeriods: number): string {
  return period > regulationPeriods ? "已结束 · 加时" : "已结束";
}

/** Today's live scoreboard feed — the only source of in-game scores. */
export function normalizeScoreboardGame(raw: RawScoreboardGame): Game {
  const regulationPeriods = raw.regulationPeriods || 4;
  const stage = gameStageFor(raw.gameId, raw.gameLabel, raw.gameSubLabel);
  const status = toStatus(raw.gameStatus);
  const clock = parseClock(raw.gameClock);
  const postponed = isPostponed(raw.gameStatusText);

  const away = toTeamSide(
    { ...raw.awayTeam, score: status === "upcoming" ? null : raw.awayTeam.score },
    toPeriods(raw.awayTeam.periods),
    stage === "regular-season",
  );
  const home = toTeamSide(
    { ...raw.homeTeam, score: status === "upcoming" ? null : raw.homeTeam.score },
    toPeriods(raw.homeTeam.periods),
    stage === "regular-season",
  );
  markWinner(away, home, status);

  let statusText = "";
  if (status === "live") {
    statusText = liveStatusText(raw.period, clock, regulationPeriods, raw.gameStatusText);
  } else if (status === "final") {
    statusText = finalStatusText(raw.period, regulationPeriods);
  } else if (postponed) {
    statusText = "延期";
  }

  return {
    id: raw.gameId,
    status: postponed && status === "upcoming" ? "upcoming" : status,
    statusText,
    period: raw.period || 0,
    clock,
    startTime: raw.gameTimeUTC,
    label: gameStageLabel(stage, raw.gameLabel),
    stage,
    series: null,
    postponed,
    away,
    home,
  };
}

/** The season schedule — the only source of the full date range. */
export function normalizeScheduleGame(raw: RawScheduleGame): Game {
  const stage = gameStageFor(raw.gameId, raw.gameLabel, raw.gameSubLabel);
  const status = toStatus(raw.gameStatus);
  const postponed = isPostponed(raw.gameStatusText, raw.postponedStatus);

  const away = toTeamSide(
    { ...raw.awayTeam, score: status === "upcoming" ? null : raw.awayTeam.score },
    [],
    stage === "regular-season",
  );
  const home = toTeamSide(
    { ...raw.homeTeam, score: status === "upcoming" ? null : raw.homeTeam.score },
    [],
    stage === "regular-season",
  );
  markWinner(away, home, status);

  let statusText = "";
  let period = 0;
  let clock: string | null = null;

  if (status === "live") {
    // The schedule carries live games too (e.g. after the scoreboard has
    // rolled over to the next game date), just with less resolution.
    const parsed = parseLiveStatusText(raw.gameStatusText);
    if (parsed) {
      period = parsed.period;
      clock = parsed.clock;
      statusText = liveStatusText(period, clock, 4, raw.gameStatusText);
    } else {
      statusText = statusTextZh(raw.gameStatusText, 0);
    }
  } else if (status === "final") {
    statusText = "已结束";
  } else if (postponed) {
    statusText = "延期";
  }

  return {
    id: raw.gameId,
    status,
    statusText,
    period,
    clock,
    startTime: raw.gameDateTimeUTC || raw.gameTimeUTC,
    label: gameStageLabel(stage, raw.gameLabel),
    stage,
    series: null,
    postponed,
    away,
    home,
  };
}

function emptyTeamBox(team: RawBoxScoreTeam): TeamBox {
  return {
    id: team.teamId,
    tricode: team.teamTricode,
    name: teamNameZh(team.teamTricode, team.teamName),
    players: [],
  };
}

function toPlayerLine(player: RawBoxScorePlayer): PlayerLine {
  const stats = player.statistics;
  return {
    personId: player.personId,
    name: playerNameZh(player.name),
    jersey: player.jerseyNum || "",
    position: player.position || "",
    starter: player.starter === "1",
    minutes: parseMinutes(stats.minutes),
    points: stats.points ?? 0,
    rebounds: stats.reboundsTotal ?? 0,
    assists: stats.assists ?? 0,
    fg: formatShooting(stats.fieldGoalsMade, stats.fieldGoalsAttempted),
    threePt: formatShooting(stats.threePointersMade, stats.threePointersAttempted),
    ft: formatShooting(stats.freeThrowsMade, stats.freeThrowsAttempted),
    plusMinus: stats.plusMinusPoints ?? 0,
    steals: stats.steals ?? 0,
    blocks: stats.blocks ?? 0,
    turnovers: stats.turnovers ?? 0,
    fouls: stats.foulsPersonal ?? 0,
  };
}

/** Starters first, then by minutes played — the way a box score reads. */
function sortPlayers(players: RawBoxScorePlayer[]): RawBoxScorePlayer[] {
  const minutesOf = (player: RawBoxScorePlayer): number => {
    const match = /^PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(player.statistics.minutes ?? "");
    if (!match) return -1;
    return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  };
  return [...players].sort((a, b) => {
    if (a.starter !== b.starter) return a.starter === "1" ? -1 : 1;
    return minutesOf(b) - minutesOf(a);
  });
}

function toTeamBox(team: RawBoxScoreTeam): TeamBox {
  const played = (team.players ?? []).filter((player) => player.played === "1");
  return {
    ...emptyTeamBox(team),
    players: sortPlayers(played).map(toPlayerLine),
  };
}

type LeaderKey = "points" | "rebounds" | "assists";

/** Category leader, tie-broken by total production across the other two. */
function pickLeaderBy(players: PlayerLine[], tricode: string, key: LeaderKey): Leader | null {
  if (players.length === 0) return null;
  const total = (player: PlayerLine) => player.points + player.rebounds + player.assists;
  const best = players.reduce((leader, player) => {
    if (player[key] !== leader[key]) return player[key] > leader[key] ? player : leader;
    return total(player) > total(leader) ? player : leader;
  });
  return {
    personId: best.personId,
    name: best.name,
    tricode,
    points: best.points,
    rebounds: best.rebounds,
    assists: best.assists,
  };
}

function pickLeaders(players: PlayerLine[], tricode: string): TeamLeaders {
  return {
    points: pickLeaderBy(players, tricode, "points"),
    rebounds: pickLeaderBy(players, tricode, "rebounds"),
    assists: pickLeaderBy(players, tricode, "assists"),
  };
}

/** Overview shows five high-value comparisons, nothing more (PRD §14). */
function toStatRows(home: RawBoxScoreTeam, away: RawBoxScoreTeam): StatRow[] {
  const homeStats = home.statistics;
  const awayStats = away.statistics;
  return [
    {
      label: "投篮命中率",
      away: formatPercentage(awayStats.fieldGoalsPercentage),
      home: formatPercentage(homeStats.fieldGoalsPercentage),
    },
    {
      label: "三分命中率",
      away: formatPercentage(awayStats.threePointersPercentage),
      home: formatPercentage(homeStats.threePointersPercentage),
    },
    {
      label: "篮板",
      away: String(awayStats.reboundsTotal ?? 0),
      home: String(homeStats.reboundsTotal ?? 0),
    },
    {
      label: "助攻",
      away: String(awayStats.assists ?? 0),
      home: String(homeStats.assists ?? 0),
    },
    {
      label: "失误",
      away: String(awayStats.turnovers ?? 0),
      home: String(homeStats.turnovers ?? 0),
    },
    {
      label: "罚球命中率",
      away: formatPercentage(awayStats.freeThrowsPercentage),
      home: formatPercentage(homeStats.freeThrowsPercentage),
    },
    {
      label: "进攻篮板",
      away: String(awayStats.reboundsOffensive ?? 0),
      home: String(homeStats.reboundsOffensive ?? 0),
    },
    {
      label: "抢断",
      away: String(awayStats.steals ?? 0),
      home: String(homeStats.steals ?? 0),
    },
    {
      label: "盖帽",
      away: String(awayStats.blocks ?? 0),
      home: String(homeStats.blocks ?? 0),
    },
    {
      label: "内线得分",
      away: String(awayStats.pointsInThePaint ?? 0),
      home: String(homeStats.pointsInThePaint ?? 0),
    },
    {
      label: "快攻得分",
      away: String(awayStats.pointsFastBreak ?? 0),
      home: String(homeStats.pointsFastBreak ?? 0),
    },
    {
      label: "利用失误得分",
      away: String(awayStats.pointsFromTurnovers ?? 0),
      home: String(homeStats.pointsFromTurnovers ?? 0),
    },
    {
      label: "替补得分",
      away: String(awayStats.benchPoints ?? 0),
      home: String(homeStats.benchPoints ?? 0),
    },
    {
      label: "最大领先",
      away: String(awayStats.biggestLead ?? 0),
      home: String(homeStats.biggestLead ?? 0),
    },
  ];
}

/**
 * A game with no box score behind it.
 *
 * The detail page still needs a header, so the fixture is described from the
 * schedule alone: teams, status and tip-off, with empty statistics rather than
 * an error (PRD §33).
 */
export function gameDetailFromGame(game: Game, arena: string | null): GameDetail {
  const toBox = (side: TeamSide): TeamBox => ({
    id: side.id,
    tricode: side.tricode,
    name: side.name,
    players: [],
  });

  return {
    ...game,
    arena,
    leaders: {
      home: { points: null, rebounds: null, assists: null },
      away: { points: null, rebounds: null, assists: null },
    },
    matchup: null,
    stats: [],
    boxScore: { home: toBox(game.home), away: toBox(game.away) },
  };
}

export interface BoxScoreContext {
  /** Anything the schedule knows that the box score does not. */
  label?: string | null;
  startTime?: string | null;
}

/**
 * A box score is the richest payload we have, so it carries the detail page
 * on its own: score, periods, leaders, team stats and player lines.
 */
export function normalizeBoxScore(raw: RawBoxScore, context: BoxScoreContext = {}): GameDetail {
  const game = raw.game;
  const stage = gameStageFor(game.gameId, context.label);
  const regulationPeriods = game.regulationPeriods || 4;
  const status = toStatus(game.gameStatus);
  const clock = parseClock(game.gameClock);
  const postponed = isPostponed(game.gameStatusText);

  const away = toTeamSide(
    { ...game.awayTeam, score: status === "upcoming" ? null : game.awayTeam.score },
    toPeriods(game.awayTeam.periods),
    stage === "regular-season",
  );
  const home = toTeamSide(
    { ...game.homeTeam, score: status === "upcoming" ? null : game.homeTeam.score },
    toPeriods(game.homeTeam.periods),
    stage === "regular-season",
  );
  markWinner(away, home, status);

  let statusText = "";
  if (status === "live") {
    statusText = liveStatusText(game.period, clock, regulationPeriods, game.gameStatusText);
  } else if (status === "final") {
    statusText = finalStatusText(game.period, regulationPeriods);
  } else if (postponed) {
    statusText = "延期";
  }

  const homeBox = toTeamBox(game.homeTeam);
  const awayBox = toTeamBox(game.awayTeam);

  return {
    id: game.gameId,
    status,
    statusText,
    period: game.period || 0,
    clock,
    startTime: context.startTime || game.gameTimeUTC,
    label: gameStageLabel(stage, context.label),
    stage,
    series: null,
    postponed,
    away,
    home,
    arena: game.arena?.arenaName || null,
    // Matchup context is filled in by games.ts, which owns the schedule.
    matchup: null,
    leaders: {
      away: pickLeaders(awayBox.players, away.tricode),
      home: pickLeaders(homeBox.players, home.tricode),
    },
    stats: toStatRows(game.homeTeam, game.awayTeam),
    boxScore: { home: homeBox, away: awayBox },
  };
}

/* ------------------------------------------------------------------ *
 * Play-by-play (PRD v0.3): structured Chinese events + score flow.
 *
 * Upstream describes every whistle in English free text; the normalize layer
 * turns each action into a fixed template instead, so the UI never has to
 * parse English and no English ever reaches the screen.
 * ------------------------------------------------------------------ */

const TEAM_BY_ID: Map<number, string> = new Map(TEAM_CATALOG.map((team) => [team.id, team.tricode]));

const FOUL_ZH: Record<string, string> = {
  personal: "个人犯规",
  shooting: "投篮犯规",
  offensive: "进攻犯规",
  technical: "技术犯规",
  flagrant1: "一级恶意犯规",
  flagrant2: "二级恶意犯规",
  defensive: "防守犯规",
  looseball: "争球犯规",
  awayfromplay: "无球犯规",
};

const TURNOVER_ZH: Record<string, string> = {
  "bad pass": "传球失误",
  traveling: "走步",
  "lost ball": "丢球",
  "out-of-bounds": "出界",
  "shot clock": "24秒违例",
  "offensive foul": "进攻犯规",
  palming: "翻腕",
  "double dribble": "二次运球",
  "offensive goaltending": "进攻干扰球",
  "kicked ball": "脚踢球",
};

const VIOLATION_ZH: Record<string, string> = {
  "delay-of-game": "拖延比赛",
  goaltending: "干扰球",
  "kicked ball": "脚踢球",
  lane: "三秒违例",
  "defensive goaltending": "防守干扰球",
  jumpball: "跳球违例",
};

const TIMEOUT_ZH: Record<string, string> = {
  full: "长暂停",
  short: "短暂停",
  official: "官方暂停",
};

/** "N. Alexander-Walker" → surname for display when the roster lookup misses. */
function surnameOf(playerNameI: string | undefined): string | null {
  if (!playerNameI) return null;
  const parts = playerNameI.replace(/^[A-Z]\.\s*/, "").trim();
  return parts || null;
}

function resolveActorName(raw: RawPlayAction, persons: Map<number, string>): string | null {
  if (raw.personId) {
    const full = persons.get(raw.personId);
    if (full) return playerNameZh(full);
  }
  return surnameOf(raw.playerNameI) ?? raw.playerName ?? null;
}

function resolveAssistName(raw: RawPlayAction, persons: Map<number, string>): string | null {
  if (raw.assistPersonId) {
    const full = persons.get(raw.assistPersonId);
    if (full) return playerNameZh(full);
  }
  return raw.assistPlayerNameInitial ?? null;
}

function resolveTeamTricode(raw: RawPlayAction): string | null {
  if (raw.teamTricode) return raw.teamTricode;
  if (raw.teamId) return TEAM_BY_ID.get(raw.teamId) ?? null;
  return null;
}

/** Remaining "6:21" → elapsed game minutes from tip-off. */
function elapsedMinutes(period: number, clock: string | null): number | null {
  if (!clock) return null;
  const match = /^(\d+):(\d{2})$/.exec(clock);
  if (!match) return null;
  const remaining = Number(match[1]) + Number(match[2]) / 60;
  if (period <= 4) return (period - 1) * 12 + (12 - remaining);
  return 48 + (period - 5) * 5 + (5 - remaining);
}

interface DescribedAction {
  text: string;
  detail: string | null;
  scoring: boolean;
}

/**
 * One upstream action → fixed Chinese template, or null to drop the row.
 * Substitutions and period markers never reach the screen: subs are noise
 * (often 100+ per game) and periods become section dividers in the UI.
 */
function describeAction(
  raw: RawPlayAction,
  actor: string | null,
  assist: string | null,
  teamZh: string | null,
): DescribedAction | null {
  const type = raw.actionType;
  const sub = raw.subType ?? "";
  const made = raw.shotResult === "Made";

  switch (type) {
    case "substitution":
    case "period":
    case "game":
      return null;
    case "jumpball":
      return { text: "跳球", detail: null, scoring: false };
    case "timeout": {
      const kind = TIMEOUT_ZH[sub] ?? "暂停";
      return { text: teamZh ? `${teamZh}${kind}` : kind, detail: null, scoring: false };
    }
    case "2pt":
    case "3pt": {
      if (!actor) return null;
      const shot = type === "3pt" ? "三分" : "两分";
      if (!made) return { text: `${actor} ${shot}投失`, detail: null, scoring: false };
      const parts: string[] = [];
      if (assist) parts.push(`助攻 ${assist}`);
      if (typeof raw.shotDistance === "number") parts.push(`${Math.round(raw.shotDistance)}英尺`);
      return { text: `${actor} ${shot}命中`, detail: parts.length ? parts.join(" · ") : null, scoring: true };
    }
    case "freethrow": {
      if (!actor) return null;
      const attempt = /(\d+) of (\d+)/.exec(sub);
      const detail = attempt ? `第${attempt[1]}罚` : null;
      return { text: `${actor} ${made ? "罚球命中" : "罚球投失"}`, detail, scoring: made };
    }
    case "heave":
      if (!actor) return null;
      return { text: `${actor} 超远投篮`, detail: null, scoring: false };
    case "rebound": {
      if (!actor) return null;
      const kind = sub === "offensive" ? "进攻篮板" : "防守篮板";
      return { text: `${actor} ${kind}`, detail: null, scoring: false };
    }
    case "steal":
      if (!actor) return null;
      return { text: `${actor} 抢断`, detail: null, scoring: false };
    case "block":
      if (!actor) return null;
      return { text: `${actor} 盖帽`, detail: null, scoring: false };
    case "turnover": {
      if (!actor) return null;
      return { text: `${actor} ${TURNOVER_ZH[sub] ?? "失误"}`, detail: null, scoring: false };
    }
    case "foul": {
      if (!actor) return null;
      return { text: `${actor} ${FOUL_ZH[sub] ?? "犯规"}`, detail: null, scoring: false };
    }
    case "ejection":
      if (!actor) return null;
      return { text: `${actor} 被驱逐出场`, detail: null, scoring: false };
    case "violation": {
      const kind = VIOLATION_ZH[sub] ?? "违例";
      return { text: actor ? `${actor} ${kind}` : kind, detail: null, scoring: false };
    }
    default:
      return null;
  }
}

/**
 * Full play-by-play feed → events (latest first) plus the score-flow series
 * (oldest first, for the chart). `persons` maps upstream personId → English
 * full name and comes from the box score, which names everyone the feed only
 * identifies by number.
 */
export function normalizePlayByPlay(
  raw: RawPlayByPlay,
  persons: Map<number, string>,
): { events: PlayEvent[]; flow: FlowPoint[]; periods: number[]; shots: Shot[] } {
  const actions = [...(raw.game.actions ?? [])].sort((a, b) => a.actionNumber - b.actionNumber);

  const events: PlayEvent[] = [];
  const flow: FlowPoint[] = [{ t: 0, margin: 0 }];
  const shots: Shot[] = [];
  const periodSet = new Set<number>();

  for (const action of actions) {
    if (action.period > 0) periodSet.add(action.period);

    const home = Number.parseInt(action.scoreHome, 10);
    const away = Number.parseInt(action.scoreAway, 10);
    if (Number.isFinite(home) && Number.isFinite(away)) {
      const t = elapsedMinutes(action.period, parseClock(action.clock));
      if (t !== null) flow.push({ t, margin: home - away });
    }

    const tricode = resolveTeamTricode(action);

    if (
      action.isFieldGoal &&
      typeof action.x === "number" &&
      typeof action.y === "number"
    ) {
      // Feet on one half court: x runs 0–94 along the length (folded, so
      // every shot attacks the same basket), y runs ±25 across the width.
      // Verified against reported shot distances (e.g. corner at raw
      // (6.2, 0.8) computes to 24.6ft, exactly as listed).
      const fx = action.x <= 50 ? action.x : 100 - action.x;
      shots.push({
        x: fx * 0.94,
        y: (action.y - 50) * 0.5,
        made: action.shotResult === "Made",
        teamId: action.teamId ?? null,
        tricode,
      });
    }
    const actor = resolveActorName(action, persons);
    const assist = resolveAssistName(action, persons);
    const teamZh = tricode ? teamNameZh(tricode, "") || null : null;
    const described = describeAction(action, actor, assist, teamZh);
    if (!described) continue;

    const clock = parseClock(action.clock);
    const clockMatch = clock ? /^(\d+):(\d{2})$/.exec(clock) : null;
    const remaining = clockMatch ? Number(clockMatch[1]) + Number(clockMatch[2]) / 60 : null;
    const margin =
      Number.isFinite(home) && Number.isFinite(away) ? Math.abs(home - away) : null;
    const clutch =
      action.period >= 4 && remaining !== null && remaining <= 2 && margin !== null && margin <= 5;

    events.push({
      id: action.actionNumber,
      period: action.period,
      clock,
      teamId: action.teamId ?? null,
      tricode,
      color: described.scoring && tricode ? teamAccent(tricode) : "#8A8A8E",
      scoring: described.scoring,
      clutch,
      text: described.text,
      detail: described.detail,
      awayScore: Number.isFinite(away) ? away : null,
      homeScore: Number.isFinite(home) ? home : null,
    });
  }

  events.reverse();
  return { events, flow, periods: [...periodSet].sort((a, b) => a - b), shots };
}
