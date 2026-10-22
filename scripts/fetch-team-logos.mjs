/**
 * Downloads the 30 club crests into `public/logos/<id>.svg`.
 *
 * The app used to point every crest at `/api/logo/<teamId>`, which is a
 * server-side proxy — and the Android build has no server, so the APK asked
 * its own WebView for a route that does not exist and every crest rendered as
 * a broken image. Fetching them once and shipping them inside the bundle
 * removes the runtime dependency entirely: no domain, no CDN, no network.
 *
 * Provenance: cdn.nba.com (needs a browser User-Agent and a Referer) with the
 * league's own S3 mirror as the fallback origin. Run this only when the roster
 * or the artwork changes; the output is committed.
 *
 *   node scripts/fetch-team-logos.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT_DIR = "public/logos";

const ORIGINS = [
  "https://cdn.nba.com/logos/nba",
  "https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/NBA/logos/nba",
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.nba.com/",
  Accept: "image/svg+xml,image/*,*/*",
};

/** One source of truth for who is in the league: the picker's own catalog. */
function teamIds() {
  const source = readFileSync("src/lib/nba/team-catalog.ts", "utf8");
  return [...source.matchAll(/\bid:\s*(\d{6,12})\b/g)].map((match) => Number(match[1]));
}

async function download(teamId) {
  for (const origin of ORIGINS) {
    const url = `${origin}/${teamId}/global/L/logo.svg`;
    try {
      const response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;

      const svg = await response.text();
      // A 403 body is HTML that also arrives with status 200 from some edges.
      if (!svg.includes("<svg")) continue;

      return { svg, url };
    } catch {
      // Try the next origin.
    }
  }
  return null;
}

const ids = teamIds();
if (ids.length !== 30) {
  console.error(`Expected 30 teams in the catalog, found ${ids.length}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const failures = [];
for (const id of ids) {
  const result = await download(id);
  if (!result) {
    failures.push(id);
    console.error(`  ${id}  FAILED`);
    continue;
  }
  const body = result.svg.trim() + "\n";
  writeFileSync(`${OUT_DIR}/${id}.svg`, body, "utf8");
  console.log(`  ${id}  ${(body.length / 1024).toFixed(1)} KiB  ${result.url.split("/")[2]}`);
}

console.log(`\n${ids.length - failures.length}/${ids.length} crests written to ${OUT_DIR}/`);
if (failures.length > 0) {
  console.error(`Missing: ${failures.join(", ")}`);
  process.exit(1);
}
