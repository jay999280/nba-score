/**
 * ESPN's public JSON endpoints, wrapped for the service layer.
 *
 * The app's own feeds (NBA Live Data) do not carry season statistics or any
 * pre-game lineup information, so the pre-game comparison reads ESPN's public
 * site/core APIs. Everything here goes through `fetchSourceUrls`, which means
 * the same code works on both targets: on the Web a Next route handler performs
 * the request server-side, and in the Android WebView `data-source.ts` has
 * swapped the underlying requester for Capacitor's native HTTP bridge (ESPN
 * sends no CORS headers and answers a browser `fetch` with 403).
 *
 * Two ESPN shapes are read here and they are not interchangeable:
 *
 *  - **team statistics** (`/seasons/{season}/types/2/teams/{id}/statistics`)
 *    publishes totals in `value` and per-game numbers in `perGameValue`, plus
 *    a more precise `avgPoints`/`avgRebounds`/… pair of averages;
 *  - **athlete statistics** (`/…/athletes/{id}/statistics`) publishes the
 *    season TOTAL in `value` and the per-game average in `avgPoints`/
 *    `avgRebounds`/`avgAssists`. `perGameValue` is null on this endpoint, so a
 *    single-game player's total and average look identical — using `value`
 *    would silently show a full-season total as an average.
 *
 * Player ids differ between the two providers (the NBA box score carries a
 * `personId`, ESPN uses its own athlete id), so the roster is what maps a name
 * to an ESPN id; see `lineups.ts`.
 */

import { fetchSourceUrls } from "./source";
import { isRawEspnStandings } from "./standings-normalize";

const CORE_BASE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";
const SITE_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

const REQUEST_TIMEOUT_MS = 15_000;

/** A roster changes on trades and call-ups, not minute to minute. */
const ROSTER_TTL_SECONDS = 30 * 60;
/** A completed game never rewrites a player's season line. */
const ATHLETE_STATS_TTL_SECONDS = 30 * 60;
/** Team aggregates move after every game; ten minutes is the asked-for cadence. */
const TEAM_STATS_TTL_SECONDS = 10 * 60;
/**
 * Deliberately the same five-minute window `standings.ts` uses, and the same
 * cache key, so the pre-game page's existing standings read and this one share
 * one upstream document instead of downloading it twice.
 */
const STANDINGS_TTL_SECONDS = 5 * 60;

/**
 * NBA team id → ESPN team id.
 *
 * Keyed by the app's own (NBA) ids on purpose: matching on the three-letter
 * code would be wrong because ESPN's abbreviations differ from the league's
 * ("GS"/"GSW", "NY"/"NYK", "NO"/"NOP", "SA"/"SAS", "UTAH"/"UTA", "WSH"/"WAS").
 * Verified against `site.api.espn.com/.../teams` on 2026-10-22.
 */
const ESPN_TEAM_BY_NBA_TEAM: Readonly<Record<number, number>> = {
  1610612737: 1, // ATL
  1610612751: 17, // BKN
  1610612738: 2, // BOS
  1610612766: 30, // CHA
  1610612741: 4, // CHI
  1610612739: 5, // CLE
  1610612742: 6, // DAL
  1610612743: 7, // DEN
  1610612765: 8, // DET
  1610612744: 9, // GS
  1610612745: 10, // HOU
  1610612754: 11, // IND
  1610612746: 12, // LAC
  1610612747: 13, // LAL
  1610612763: 29, // MEM
  1610612748: 14, // MIA
  1610612749: 15, // MIL
  1610612750: 16, // MIN
  1610612740: 3, // NO
  1610612752: 18, // NY
  1610612760: 25, // OKC
  1610612753: 19, // ORL
  1610612755: 20, // PHI
  1610612756: 21, // PHX
  1610612757: 22, // POR
  1610612759: 24, // SA
  1610612758: 23, // SAC
  1610612761: 28, // TOR
  1610612762: 26, // UTAH
  1610612764: 27, // WSH
};

export function espnTeamIdFor(nbaTeamId: number): number | null {
  return ESPN_TEAM_BY_NBA_TEAM[nbaTeamId] ?? null;
}

/* ------------------------------------------------------------------ *
 * Raw shapes (kept inside src/lib/nba, PRD §24)
 * ------------------------------------------------------------------ */

/** One row of an ESPN statistics split; both endpoints use this shape. */
export interface EspnStat {
  name: string;
  value: number | null;
  displayValue: string | null;
  perGameValue: number | null;
  perGameDisplayValue: string | null;
  rank: number | null;
}

export type EspnStatIndex = Map<string, EspnStat>;

/** The fields of a roster entry this feature uses. */
export interface EspnRosterAthlete {
  espnId: string;
  displayName: string;
  jersey: string;
  /** "G" | "F" | "C" on this feed. */
  position: string;
}

/** One team's opponent scoring, for the "points allowed" comparison row. */
export interface EspnPointsAllowed {
  gamesPlayed: number;
  pointsAgainstPerGame: number | null;
}

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ESPN omits fields it has no value for (`perGameValue` is often absent on
// averages, `rank` on most team stats), so "missing" and "null" both normalize
// to null instead of failing the whole payload.
function isNumberOrNullish(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringOrNullish(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isStatRow(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    isNumberOrNullish(value.value) &&
    isStringOrNullish(value.displayValue) &&
    isNumberOrNullish(value.perGameValue) &&
    isStringOrNullish(value.perGameDisplayValue)
  );
}

/** `{ splits: { categories: [{ name, stats: [...] }] } }` — team and athlete alike. */
function isEspnStatisticsPayload(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || !isObject(value.splits)) return false;
  const categories = value.splits.categories;
  return (
    Array.isArray(categories) &&
    categories.length > 0 &&
    categories.every(
      (category) => isObject(category) && typeof category.name === "string" && Array.isArray(category.stats) && category.stats.every(isStatRow),
    )
  );
}

/** `{ athletes: [{ id, displayName, position: { abbreviation }, jersey }] }` */
function isEspnRoster(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || !Array.isArray(value.athletes)) return false;
  return value.athletes.every(
    (athlete) =>
      isObject(athlete) &&
      typeof athlete.id === "string" &&
      athlete.id.length > 0 &&
      typeof athlete.displayName === "string" &&
      athlete.displayName.length > 0 &&
      // A malformed position would normalize into a blank player row, which is
      // the one thing the interface must never render as a real player.
      (athlete.position === undefined || isObject(athlete.position)),
  );
}

/* ------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------ */

function teamStatisticsUrl(espnSeason: number, espnTeamId: number): string {
  return `${CORE_BASE}/seasons/${espnSeason}/types/2/teams/${espnTeamId}/statistics`;
}

function athleteStatisticsUrl(espnSeason: number, athleteId: string): string {
  return `${CORE_BASE}/seasons/${espnSeason}/types/2/athletes/${athleteId}/statistics`;
}

function rosterUrl(espnTeamId: number): string {
  return `${SITE_BASE}/teams/${espnTeamId}/roster`;
}

/**
 * The standings document `standings.ts` already reads.
 *
 * Both the URL and the cache key are replicated exactly on purpose: the
 * standings page (and the pre-game header) fetch this document in the same
 * page load, and `fetchSourceUrls` de-duplicates identical keys, so the only
 * thing the comparison pays for is the extra request when nothing else fetched
 * it. It is the only verified ESPN document that carries opponent scoring
 * (`avgPointsAgainst`); the team-statistics endpoint does not.
 */
function regularStandingsUrl(espnSeason: number, seasonLabel: string): { key: string; url: string } {
  const query = new URLSearchParams({
    region: "us",
    lang: "en",
    contentorigin: "espn",
    season: String(espnSeason),
    seasontype: "2",
  });
  return {
    key: `espn-regular-standings-${seasonLabel}`,
    url: `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/standings?${query.toString()}`,
  };
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function statIndexFrom(value: unknown): EspnStatIndex {
  const index: EspnStatIndex = new Map();
  // Structure is already guaranteed by the guard that produced this value.
  const categories = (value as { splits: { categories: { stats: Record<string, unknown>[] }[] } }).splits
    .categories;
  for (const category of categories) {
    for (const stat of category.stats) {
      index.set(stat.name as string, {
        name: stat.name as string,
        value: numberOrNull(stat.value),
        displayValue: stringOrNull(stat.displayValue),
        perGameValue: numberOrNull(stat.perGameValue),
        perGameDisplayValue: stringOrNull(stat.perGameDisplayValue),
        rank: numberOrNull(stat.rank),
      });
    }
  }
  return index;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** This season's team statistics, per game where the source publishes averages. */
export async function fetchTeamStatistics(
  espnSeason: number,
  espnTeamId: number,
): Promise<EspnStatIndex> {
  const raw = await fetchSourceUrls<unknown>(
    `espn-team-stats-${espnSeason}-${espnTeamId}`,
    [teamStatisticsUrl(espnSeason, espnTeamId)],
    TEAM_STATS_TTL_SECONDS,
    REQUEST_TIMEOUT_MS,
    isEspnStatisticsPayload,
  );
  return statIndexFrom(raw);
}

/**
 * The season roster, positionally labelled.
 *
 * ESPN answers 200 with an `athletes` array for a valid team id, so a failure
 * here is a real failure — the caller decides whether to degrade.
 */
export async function fetchRoster(espnTeamId: number): Promise<EspnRosterAthlete[]> {
  const raw = await fetchSourceUrls<unknown>(
    `espn-roster-${espnTeamId}`,
    [rosterUrl(espnTeamId)],
    ROSTER_TTL_SECONDS,
    REQUEST_TIMEOUT_MS,
    isEspnRoster,
  );
  const athletes = (raw as { athletes: Record<string, unknown>[] }).athletes;
  return athletes.map((athlete) => {
    const position = isObject(athlete.position) ? athlete.position : {};
    return {
      espnId: athlete.id as string,
      displayName: athlete.displayName as string,
      jersey: stringOrNull(athlete.jersey) ?? "",
      position: stringOrNull(position.abbreviation) ?? "",
    };
  });
}

/**
 * One athlete's season statistics, or `null` when the player has none.
 *
 * ESPN answers 404 `{"message":"No stats found."}` for a player without a
 * regular-season appearance — including every player on a team that has not
 * played yet. That is a normal "nothing to show", not a source failure, so it
 * is turned into `null` instead of being reported as a read error.
 */
export async function fetchAthleteStatistics(
  espnSeason: number,
  athleteId: string,
): Promise<EspnStatIndex | null> {
  try {
    const raw = await fetchSourceUrls<unknown>(
      `espn-athlete-stats-${espnSeason}-${athleteId}`,
      [athleteStatisticsUrl(espnSeason, athleteId)],
      ATHLETE_STATS_TTL_SECONDS,
      REQUEST_TIMEOUT_MS,
      isEspnStatisticsPayload,
    );
    return statIndexFrom(raw);
  } catch {
    return null;
  }
}

/**
 * Every team's opponents' points per game, from the regular-season standings.
 *
 * The comparison needs "points allowed" and ESPN publishes it here only. Stats
 * are keyed by ESPN team id (`team.id`), which the standings normalizer does not
 * need and therefore does not expose; the payload was already validated against
 * the requested season, so this traversal only reads what it validates first.
 */
export async function fetchPointsAllowed(
  espnSeason: number,
  seasonLabel: string,
): Promise<Map<number, EspnPointsAllowed>> {
  const { key, url } = regularStandingsUrl(espnSeason, seasonLabel);
  const raw = await fetchSourceUrls<unknown>(
    key,
    [url],
    STANDINGS_TTL_SECONDS,
    REQUEST_TIMEOUT_MS,
    (value) => isRawEspnStandings(value, espnSeason),
  );

  const byTeam = new Map<number, EspnPointsAllowed>();
  const children = (raw as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return byTeam;

  for (const child of children) {
    if (!isObject(child) || !isObject(child.standings)) continue;
    const entries = child.standings.entries;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isObject(entry) || !isObject(entry.team) || !Array.isArray(entry.stats)) continue;
      const espnId = Number.parseInt(String(entry.team.id ?? ""), 10);
      if (!Number.isInteger(espnId)) continue;
      const winsStat = entry.stats.find((stat) => isObject(stat) && stat.name === "wins");
      const lossesStat = entry.stats.find((stat) => isObject(stat) && stat.name === "losses");
      const againstStat = entry.stats.find((stat) => isObject(stat) && stat.name === "avgPointsAgainst");
      const wins = isObject(winsStat) ? numberOrNull(winsStat.value) : null;
      const losses = isObject(lossesStat) ? numberOrNull(lossesStat.value) : null;
      byTeam.set(espnId, {
        gamesPlayed: (wins ?? 0) + (losses ?? 0),
        pointsAgainstPerGame: isObject(againstStat) ? numberOrNull(againstStat.value) : null,
      });
    }
  }
  return byTeam;
}

/* ------------------------------------------------------------------ *
 * Value helpers
 * ------------------------------------------------------------------ */

/**
 * A per-game number from a team/athlete statistics index.
 *
 * `averageName` is the precise average ESPN publishes ("avgPoints"); the base
 * statistic's `perGameValue` is the fallback, and a total divided by games
 * played is the last resort so a value is never invented from a total.
 */
export function statPerGame(
  index: EspnStatIndex,
  averageName: string,
  totalName: string,
): number | null {
  const average = index.get(averageName)?.value;
  if (typeof average === "number" && Number.isFinite(average)) return average;

  const stat = index.get(totalName);
  if (!stat) return null;
  if (typeof stat.perGameValue === "number" && Number.isFinite(stat.perGameValue)) {
    return stat.perGameValue;
  }
  const games = index.get("gamesPlayed")?.value;
  if (typeof stat.value === "number" && Number.isFinite(stat.value) && typeof games === "number" && games > 0) {
    return stat.value / games;
  }
  return null;
}

/** A percentage as the source displays it, e.g. "46.2" — already ×100. */
export function statPercentage(index: EspnStatIndex, name: string): string | null {
  const value = index.get(name)?.displayValue;
  return value ?? null;
}
