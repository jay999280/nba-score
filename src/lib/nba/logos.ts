/**
 * Team crests.
 *
 * The browser is never pointed at the NBA CDN directly (PRD §25): crests are
 * served from our own origin and cached there for a week, which also removes
 * the HTTP/2 flakiness some networks show towards `cdn.nba.com`.
 */

const LOGO_ORIGINS = [
  "https://cdn.nba.com/logos/nba",
  "https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/NBA/logos/nba",
] as const;

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://www.nba.com/",
  Accept: "image/svg+xml,image/*,*/*",
};

/** Crests never change, so they are memoized for the process lifetime. */
const cache = new Map<number, string>();

export function isValidTeamId(teamId: string): boolean {
  return /^\d{6,12}$/.test(teamId);
}

export async function getTeamLogo(teamId: number): Promise<string | null> {
  const cached = cache.get(teamId);
  if (cached) return cached;

  for (const origin of LOGO_ORIGINS) {
    try {
      const response = await fetch(`${origin}/${teamId}/global/L/logo.svg`, {
        headers: HEADERS,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;

      const svg = await response.text();
      if (!svg.includes("<svg")) continue;

      cache.set(teamId, svg);
      return svg;
    } catch {
      // Try the next origin.
    }
  }

  return null;
}
