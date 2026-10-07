/**
 * Chinese names for NBA players.
 *
 * The league's feed only carries English names and its rosters turn over
 * constantly, so a small generated dictionary does the lookup:
 * `scripts/build-player-names.mjs` refreshes `player-names.json` from a Chinese
 * NBA source, keyed by the normalized English name.
 *
 * The lookup can only ever fail towards the original English name — a player is
 * never labelled as somebody else.
 */

import dictionary from "./player-names.json";

const NAMES: Record<string, string> = dictionary.names;

/** "Luka Dončić" → "lukadoncic" */
export function playerNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** "Derrick Jones Jr." is listed without the suffix upstream. */
const SUFFIX = /(jr|sr|ii|iii|iv)$/;

/** Chinese name when we have one, otherwise the name the league gave us. */
export function playerNameZh(name: string): string {
  const key = playerNameKey(name);
  return NAMES[key] ?? NAMES[key.replace(SUFFIX, "")] ?? name;
}
