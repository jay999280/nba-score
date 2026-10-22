import type { Game, PlayoffSeries } from "@/lib/types";
import { gameStageFor } from "./game-stage";
import type { ScheduleIndex } from "./schedule";

interface PlayoffGameCode {
  seasonYear: string;
  seriesKey: string;
  gameNumber: number;
  round: string;
}

/** NBA playoff ids encode season, series, and game number (last digit). */
function playoffCode(gameId: string): PlayoffGameCode | null {
  const match = /^(004)(\d{2})(\d{3})\d([1-7])$/.exec(gameId);
  if (!match) return null;
  const [, , year, seriesCode, number] = match;
  const code = Number(seriesCode);
  const roundByCode: Record<number, string> = {
    1: "首轮",
    2: "分区半决赛",
    3: "分区决赛",
    4: "总决赛",
  };
  const round = roundByCode[code];
  if (!round) return null;
  return {
    seasonYear: `20${year}`,
    seriesKey: gameId.slice(0, 9),
    gameNumber: Number(number),
    round,
  };
}

function indexMatchesSeason(index: ScheduleIndex, seasonYear: string): boolean {
  return new RegExp(`^${seasonYear}-\\d{2}$`).test(index.season);
}

/**
 * Derive this playoff series from the official season schedule. The schedule
 * must contain each game through the requested game number, so a partial or
 * older cache cannot be mistaken for a 0-0 series.
 */
export function playoffSeriesFor(game: Game, index: ScheduleIndex): PlayoffSeries | null {
  const stage = game.stage ?? gameStageFor(game.id, game.label);
  if (stage !== "playoffs") return null;
  const code = playoffCode(game.id);
  const current = index.byId.get(game.id);
  if (!code || !current || !indexMatchesSeason(index, code.seasonYear)) return null;

  const seriesEntries = index.entries.filter((entry) => entry.game.id.startsWith(code.seriesKey));
  const entriesByGameNumber = new Map<number, (typeof seriesEntries)[number]>();
  for (const entry of seriesEntries) {
    const itemCode = playoffCode(entry.game.id);
    if (itemCode?.seriesKey === code.seriesKey) entriesByGameNumber.set(itemCode.gameNumber, entry);
  }
  for (let number = 1; number <= code.gameNumber; number++) {
    const entry = entriesByGameNumber.get(number);
    if (!entry) return null;
    const { home, away } = entry.game;
    if (
      home.id === 0 || away.id === 0 ||
      !(
        (home.id === game.home.id && away.id === game.away.id) ||
        (home.id === game.away.id && away.id === game.home.id)
      )
    ) return null;
  }

  const startMs = Date.parse(game.startTime);
  if (!Number.isFinite(startMs)) return null;
  let homeWins = 0;
  let awayWins = 0;
  for (let number = 1; number <= code.gameNumber; number++) {
    const entry = entriesByGameNumber.get(number)!;
    const resultGame = number === code.gameNumber ? game : entry.game;
    const completedAt = Date.parse(entry.startTime);
    if (!Number.isFinite(completedAt) || completedAt > startMs) {
      if (number < code.gameNumber) return null;
      continue;
    }
    if (number < code.gameNumber && !isCompletedGame(resultGame)) return null;
    if (number === code.gameNumber && !isCompletedGame(resultGame)) continue;
    const past = resultGame;
    if (past.home.id === game.home.id) {
      if (past.home.score! > past.away.score!) homeWins++;
      else awayWins++;
    } else {
      if (past.away.score! > past.home.score!) homeWins++;
      else awayWins++;
    }
  }

  return {
    homeWins,
    awayWins,
    gameNumber: code.gameNumber,
    round: code.round,
    source: "schedule",
  };
}

function isCompletedGame(game: Game): boolean {
  return game.status === "final" && !game.postponed &&
    typeof game.home.score === "number" && Number.isFinite(game.home.score) &&
    typeof game.away.score === "number" && Number.isFinite(game.away.score) &&
    game.home.score !== game.away.score;
}
