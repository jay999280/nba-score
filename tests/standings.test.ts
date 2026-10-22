import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { TEAM_CATALOG } from "../src/lib/nba/team-catalog.ts";
import { isRawEspnStandings, normalizeEspnStandings } from "../src/lib/nba/standings-normalize.ts";
import { isSeasonNotStarted, seasonContext } from "../src/lib/nba/standings.ts";

const ESPN_CODES: Record<string, string> = {
  GSW: "GS", NOP: "NO", NYK: "NY", SAS: "SA", UTA: "UTAH", WAS: "WSH",
};
const EAST = new Set(["ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DET", "IND", "MIA", "MIL", "NYK", "ORL", "PHI", "TOR", "WAS"]);

function rawStandings(season = 2027) {
  const children = (["East", "West"] as const).map((conference) => ({
    abbreviation: conference,
    standings: {
      season,
      seasonType: 2,
      entries: TEAM_CATALOG.filter((team) => (EAST.has(team.tricode) ? "East" : "West") === conference).map((team, index) => ({
        team: { abbreviation: ESPN_CODES[team.tricode] ?? team.tricode, displayName: `${team.city} ${team.name}` },
        stats: [
          { name: "wins", value: 0, displayValue: "0" },
          { name: "losses", value: 0, displayValue: "0" },
          { name: "winPercent", value: 0, displayValue: ".000" },
          { name: "gamesBehind", value: 0, displayValue: "-" },
          { name: "playoffSeed", value: index + 1, displayValue: String(index + 1) },
        ],
      })),
    },
  }));
  return { season: { year: season, displayName: season === 2027 ? "2026-27" : "2025-26" }, children };
}

test("season context binds NBA schedule start year to ESPN's ending year", () => {
  assert.deepEqual(seasonContext("2026"), { season: "2026-27", espnSeason: 2027 });
  assert.deepEqual(seasonContext("2026-27"), { season: "2026-27", espnSeason: 2027 });
  assert.throws(() => seasonContext("2025-27"), /Inconsistent/);
});

test("not-started requires a fresh schedule, a regular fixture, and time before its tip", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const entry = {
    game: {
      id: "0022600001",
      status: "upcoming" as const,
      label: "Regular Season",
      postponed: false,
      startTime: "2026-10-22T00:00:00Z",
    },
  };
  const sourceAt = "2026-10-12T11:30:00Z";
  assert.equal(isSeasonNotStarted([entry], sourceAt, now), true);
  assert.equal(isSeasonNotStarted([], sourceAt, now), false, "empty schedules cannot prove the season is unopened");
  assert.equal(isSeasonNotStarted([entry], "2026-10-11T00:00:00Z", now), false, "old schedules cannot prove no game started");
  assert.equal(isSeasonNotStarted([{ ...entry, game: { ...entry.game, startTime: "2026-10-12T11:59:00Z" } }], sourceAt, now), false,
    "a live or already-started first fixture is beyond not-started");
});

test("captured live ESPN regular-season response matches the checked schema", () => {
  const samplePath = resolve("tests/fixtures/espn-regular-season-2026-27-standings.json");
  const liveSample: unknown = JSON.parse(readFileSync(samplePath, "utf8"));
  assert.equal(isRawEspnStandings(liveSample, 2027), true);
  const normalized = normalizeEspnStandings(liveSample, 2027);
  assert.equal(normalized.length, 30);
  assert.ok(normalized.every((team) => team.wins === 0 && team.losses === 0 && team.rank === null));
});

test("normalizer keeps ESPN conference ordering and source playoff seed for tied records", () => {
  const raw = rawStandings();
  const east = raw.children[0].standings.entries;
  // Same W-L and percentage: ESPN's source order and seed express its tiebreak order.
  for (const entry of east.slice(2, 4)) {
    entry.stats[0].value = 42;
    entry.stats[1].value = 40;
    entry.stats[2].value = 42 / 82;
  }
  const normalized = normalizeEspnStandings(raw, 2027);
  assert.equal(normalized.length, 30);
  assert.deepEqual(normalized.slice(2, 4).map((team) => [team.tricode, team.rank]), [
    ["BKN", 3], ["CHA", 4],
  ]);
  assert.equal(normalized[0].name, "老鹰");
});

test("wrong season and preseason standings are rejected", () => {
  assert.equal(isRawEspnStandings(rawStandings(2026), 2027), false);
  const preseason = rawStandings();
  preseason.children[0].standings.seasonType = 1;
  assert.equal(isRawEspnStandings(preseason, 2027), false);
  assert.throws(() => normalizeEspnStandings(preseason, 2027), /wrong-season/);
});

test("malformed or incomplete source cannot masquerade as a 30-team ranking", () => {
  const missingTeam = rawStandings();
  missingTeam.children[0].standings.entries.pop();
  assert.equal(isRawEspnStandings(missingTeam, 2027), false);

  const malformed = rawStandings();
  malformed.children[0].standings.entries[0].stats = [];
  assert.throws(() => normalizeEspnStandings(malformed, 2027));

  const notANumber = rawStandings();
  notANumber.children[0].standings.entries[0].stats[2].value = Number.NaN;
  assert.throws(() => normalizeEspnStandings(notANumber, 2027));
});
