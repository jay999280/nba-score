import { TEAM_CATALOG } from "./team-catalog";
import type { RawEspnStandings } from "./standings-raw";
import type { TeamStanding } from "@/lib/types";

const ESPN_TO_NBA_TRICODE: Record<string, string> = {
  ATL: "ATL", BOS: "BOS", BKN: "BKN", CHA: "CHA", CHI: "CHI",
  CLE: "CLE", DAL: "DAL", DEN: "DEN", DET: "DET", GS: "GSW",
  HOU: "HOU", IND: "IND", LAC: "LAC", LAL: "LAL", MEM: "MEM",
  MIA: "MIA", MIL: "MIL", MIN: "MIN", NO: "NOP", NY: "NYK",
  OKC: "OKC", ORL: "ORL", PHI: "PHI", PHX: "PHX", POR: "POR",
  SAC: "SAC", SA: "SAS", TOR: "TOR", UTAH: "UTA", WSH: "WAS",
};

const TEAM_BY_TRICODE = new Map(TEAM_CATALOG.map((team) => [team.tricode, team]));

export function isRawEspnStandings(value: unknown, expectedEspnSeason: number): value is RawEspnStandings {
  if (!isObject(value) || !isObject(value.season) || value.season.year !== expectedEspnSeason || !Array.isArray(value.children) || value.children.length !== 2) return false;
  if (typeof value.season.displayName === "string" && value.season.displayName !== `${expectedEspnSeason - 1}-${String(expectedEspnSeason).slice(-2)}`) return false;
  const conferences = new Map<string, unknown>();
  for (const child of value.children) {
    if (!isObject(child) || (child.abbreviation !== "East" && child.abbreviation !== "West")) return false;
    const standings = child.standings;
    if (!isObject(standings) || standings.season !== expectedEspnSeason || standings.seasonType !== 2 || !Array.isArray(standings.entries)) return false;
    if (conferences.has(child.abbreviation)) return false;
    conferences.set(child.abbreviation, standings.entries);
  }
  return conferences.size === 2 && ["East", "West"].every((name) => {
    const entries = conferences.get(name);
    return Array.isArray(entries) && entries.length === 15 && entries.every(hasRequiredEntryStats);
  });
}

/**
 * Translate ESPN's explicitly regular-season standings. Source entry order is
 * retained for tie-break order; rank comes from ESPN's playoffSeed field.
 */
export function normalizeEspnStandings(value: unknown, expectedEspnSeason: number): TeamStanding[] {
  if (!isRawEspnStandings(value, expectedEspnSeason)) {
    throw new Error(`Malformed or wrong-season ESPN standings for ${expectedEspnSeason}`);
  }

  const all: TeamStanding[] = [];
  const ids = new Set<number>();
  for (const conference of value.children) {
    const conf = conference.abbreviation;
    for (const entry of conference.standings.entries) {
      if (!isObject(entry) || !isObject(entry.team) || !Array.isArray(entry.stats)) {
        throw new Error("Malformed ESPN standings entry");
      }
      const nbaTricode = ESPN_TO_NBA_TRICODE[entry.team.abbreviation];
      const team = nbaTricode ? TEAM_BY_TRICODE.get(nbaTricode) : undefined;
      if (!team || ids.has(team.id)) throw new Error("Unknown or duplicate team in ESPN standings");
      ids.add(team.id);

      const wins = statNumber(entry.stats, "wins");
      const losses = statNumber(entry.stats, "losses");
      const pct = statNumber(entry.stats, "winPercent");
      const sourceRank = statNumber(entry.stats, "playoffSeed");
      if (!Number.isInteger(wins) || wins < 0 || !Number.isInteger(losses) || losses < 0 || !Number.isFinite(pct) || pct < 0 || pct > 1) {
        throw new Error("Invalid record in ESPN standings");
      }
      const rank = Number.isInteger(sourceRank) && sourceRank >= 1 && sourceRank <= 15 ? sourceRank : null;
      const gamesBehind = statDisplay(entry.stats, "gamesBehind");

      all.push({
        teamId: team.id,
        tricode: team.tricode,
        name: team.name,
        conference: conf,
        rank,
        wins,
        losses,
        winPct: pct,
        gamesBehind: gamesBehind === "-" || gamesBehind === "—" ? null : gamesBehind,
      });
    }
  }
  if (all.length !== 30 || ids.size !== 30) throw new Error("ESPN standings must contain all 30 NBA teams");
  return all;
}

function statNumber(stats: unknown[], name: string): number {
  const stat = stats.find((item) => isObject(item) && item.name === name);
  return isObject(stat) && typeof stat.value === "number" && Number.isFinite(stat.value) ? stat.value : Number.NaN;
}

function hasRequiredEntryStats(entry: unknown): boolean {
  if (!isObject(entry) || !isObject(entry.team) || typeof entry.team.abbreviation !== "string" || !Array.isArray(entry.stats)) return false;
  const stats: unknown[] = entry.stats;
  return ["wins", "losses", "winPercent", "playoffSeed"].every((name) =>
    stats.some((stat) => isObject(stat) && stat.name === name && typeof stat.value === "number"),
  );
}

function statDisplay(stats: unknown[], name: string): string | null {
  const stat = stats.find((item) => isObject(item) && item.name === name);
  if (!isObject(stat)) return null;
  if (typeof stat.displayValue === "string") return stat.displayValue;
  if (typeof stat.value === "number" && Number.isFinite(stat.value)) return String(stat.value);
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
