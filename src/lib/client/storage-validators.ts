/**
 * Validators for everything this app reads back out of localStorage.
 *
 * Kept in a plain module with no React import so the rules can be unit tested
 * directly — they are the boundary that stops a hand-edited or half-written
 * value from taking the page down (a legal-JSON `{"bad":true}` under
 * `favoriteTeams` used to crash the whole app with `filter is not a function`).
 *
 * A rejected value falls back to the caller's default; the damaged key is
 * ignored rather than deleted, so one bad preference never clears the rest.
 */

import { TEAM_CATALOG } from "@/lib/nba/team-catalog";

/** Stable empty list, so a rejected value does not produce a new array. */
export const NO_FAVORITES: number[] = [];

const VALID_TEAM_IDS = new Set(TEAM_CATALOG.map((team) => team.id));

/** Unknown ids are dropped rather than trusted; duplicates collapse. */
export function parseFavoriteIds(value: unknown): number[] {
  if (!Array.isArray(value)) return NO_FAVORITES;

  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry === "number" && VALID_TEAM_IDS.has(entry)) seen.add(entry);
  }
  if (seen.size === 0) return NO_FAVORITES;

  const ids = [...seen];
  const unchanged = ids.length === value.length && ids.every((id, index) => id === value[index]);
  // Same shape in, same reference out — keeps the memoization honest.
  return unchanged ? (value as number[]) : ids;
}

export type Theme = "dark" | "light";

/** Only the two defined values are accepted. */
export function parseTheme(value: unknown): Theme {
  return value === "dark" ? "dark" : "light";
}

/** Stored as a boolean; anything else reads as "off", the safe default. */
export function parseSpoiler(value: unknown): boolean {
  return value === true;
}
