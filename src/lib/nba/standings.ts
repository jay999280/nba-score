import type { StandingsResponse, TeamStanding } from "@/lib/types";
import type { Game } from "@/lib/types";
import { getScheduleIndexState } from "./schedule";
import { fetchSourceUrls, UpstreamError } from "./source";
import { TEAM_CATALOG } from "./team-catalog";
import { gameStageFor } from "./game-stage";
import { isRawEspnStandings, normalizeEspnStandings } from "./standings-normalize";

const SOURCE_URL = "https://site.web.api.espn.com/apis/v2/sports/basketball/nba/standings";
const SOURCE_TTL_SECONDS = 5 * 60;
export const STANDINGS_LAST_GOOD_GRACE_MS = 15 * 60_000;
const SCHEDULE_MAX_AGE_FOR_NOT_STARTED_MS = 7 * 60 * 60_000;

// NBA conference membership, keyed by the app's canonical tricode.
const EAST_TRICODES = new Set([
  "ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DET", "IND", "MIA", "MIL",
  "NYK", "ORL", "PHI", "TOR", "WAS",
]);

let lastGood: { response: StandingsResponse; freshUntil: number; usableUntil: number } | null = null;
let currentRequest: { season: string; promise: Promise<StandingsResponse> } | null = null;

/** NBA schedule seasonYear is the start year; ESPN's season is the ending year. */
export function seasonContext(scheduleSeason: string): { season: string; espnSeason: number } {
  const value = scheduleSeason.trim();
  const match = /^(\d{4})(?:-(\d{2}|\d{4}))?$/.exec(value);
  if (!match) throw new UpstreamError(`Unrecognized NBA schedule season: ${scheduleSeason}`);
  const startYear = Number(match[1]);
  const espnSeason = match[2] ? Number(match[2].length === 2 ? `${String(startYear + 1).slice(0, 2)}${match[2]}` : match[2]) : startYear + 1;
  if (espnSeason !== startYear + 1) throw new UpstreamError(`Inconsistent NBA schedule season: ${scheduleSeason}`);
  return { season: `${startYear}-${String(espnSeason).slice(-2)}`, espnSeason };
}

/** A current official schedule can prove no regular-season game has started only before its earliest fixture. */
export function isSeasonNotStarted(
  entries: readonly { game: Pick<Game, "id" | "status" | "label" | "postponed" | "startTime"> }[],
  scheduleSourceAt: string | null,
  now = Date.now(),
): boolean {
  if (!scheduleSourceAt) return false;
  const sourceAt = Date.parse(scheduleSourceAt);
  if (!Number.isFinite(sourceAt) || now - sourceAt < -5 * 60_000 || now - sourceAt > SCHEDULE_MAX_AGE_FOR_NOT_STARTED_MS) return false;
  const fixtures = entries
    .filter(({ game }) => gameStageFor(game.id, game.label) === "regular-season" && !game.postponed)
    .map(({ game }) => Date.parse(game.startTime));
  return fixtures.length > 0 && fixtures.every(Number.isFinite) && now < Math.min(...fixtures);
}

/** Current regular-season standings. Throws when neither a fresh source nor a bounded kept copy can answer. */
export async function getStandings(): Promise<StandingsResponse> {
  let scheduleState;
  try {
    scheduleState = await getScheduleIndexState();
  } catch (error) {
    return keptCopyOrThrow(error, null);
  }

  let context: ReturnType<typeof seasonContext>;
  try {
    context = seasonContext(scheduleState.index.season);
  } catch (error) {
    return keptCopyOrThrow(error, null);
  }

  if (currentRequest?.season === context.season) return currentRequest.promise;
  if (lastGood?.response.season === context.season && Date.now() < lastGood.usableUntil) {
    if (Date.now() < lastGood.freshUntil) return lastGood.response;
    // The normal five-minute source window has elapsed: refresh below unless
    // the schedule itself is degraded, in which case only a bounded stale copy
    // can safely be tied to the last known season.
    if (scheduleState.degraded) return { ...lastGood.response, stale: true };
  }
  if (scheduleState.degraded) return keptCopyOrThrow(new UpstreamError("NBA schedule is stale"), context.season);

  const task = loadStandings(context.season, context.espnSeason, scheduleState.index.entries, scheduleState.index.sourceAt)
    .then((response) => {
      const now = Date.now();
      lastGood = {
        response,
        freshUntil: now + SOURCE_TTL_SECONDS * 1000,
        usableUntil: now + SOURCE_TTL_SECONDS * 1000 + STANDINGS_LAST_GOOD_GRACE_MS,
      };
      return response;
    })
    .catch((error: unknown) => keptCopyOrThrow(error, context.season))
    .finally(() => {
      if (currentRequest?.promise === task) currentRequest = null;
    });
  currentRequest = { season: context.season, promise: task };
  return task;
}

async function loadStandings(
  season: string,
  espnSeason: number,
  entries: Awaited<ReturnType<typeof getScheduleIndexState>>["index"]["entries"],
  scheduleSourceAt: string | null,
): Promise<StandingsResponse> {
  if (isSeasonNotStarted(entries, scheduleSourceAt)) {
    return notStartedResponse(season, scheduleSourceAt);
  }

  const key = `espn-regular-standings-${season}`;
  const query = new URLSearchParams({ region: "us", lang: "en", contentorigin: "espn", season: String(espnSeason), seasontype: "2" });
  const urls = [`${SOURCE_URL}?${query.toString()}`];
  const raw = await fetchSourceUrls<unknown>(
    key,
    urls,
    SOURCE_TTL_SECONDS,
    15_000,
    (value) => isRawEspnStandings(value, espnSeason),
  );
  const teams = normalizeEspnStandings(raw, espnSeason);
  if (teams.every((team) => team.wins + team.losses === 0)) {
    return {
      season, source: "ESPN", sourceAt: null, fetchedAt: new Date().toISOString(),
      state: "not-started", stale: false,
      teams: teams.map((team) => ({ ...team, rank: null, winPct: null })),
    };
  }
  for (const conference of ["East", "West"] as const) {
    const ranks = teams.filter((team) => team.conference === conference).map((team) => team.rank);
    if (ranks.length !== 15 || ranks.some((rank) => rank === null) || new Set(ranks).size !== 15) {
      throw new UpstreamError(`ESPN standings for ${season} have no complete ${conference} ranking`);
    }
  }
  return {
    season,
    source: "ESPN",
    sourceAt: null,
    fetchedAt: new Date().toISOString(),
    state: "ready",
    stale: false,
    teams,
  };
}

function notStartedResponse(season: string, sourceAt: string | null): StandingsResponse {
  const teams: TeamStanding[] = TEAM_CATALOG.map((team) => ({
    teamId: team.id,
    tricode: team.tricode,
    name: team.name,
    conference: EAST_TRICODES.has(team.tricode) ? "East" : "West",
    rank: null,
    wins: 0,
    losses: 0,
    winPct: null,
    gamesBehind: null,
  }));
  return {
    season,
    source: "NBA schedule",
    sourceAt,
    fetchedAt: new Date().toISOString(),
    state: "not-started",
    stale: false,
    teams,
  };
}

function keptCopyOrThrow(error: unknown, season: string | null): StandingsResponse {
  if (lastGood && lastGood.response.season === season && Date.now() <= lastGood.usableUntil) {
    return { ...lastGood.response, stale: true };
  }
  throw error instanceof Error ? error : new UpstreamError(String(error));
}
