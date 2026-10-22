/**
 * Structural guards for upstream payloads (v0.9).
 *
 * `JSON.parse` succeeding only proves the bytes were JSON. A changed or
 * truncated structure would otherwise be accepted as a valid — and possibly
 * empty — season, which reads to the reader as "no games today", and a payload
 * of `[null]` would crash the normalize layer *after* having been written to
 * the cache. These guards are still deliberately shallow: enough to tell "a
 * payload of the expected kind, with the fields we actually dereference" from
 * "something else", without inventing a schema framework.
 *
 * For a game entry that means the fields the window filter and the normalizer
 * need before anything can render at all: an id, a status, **both sides
 * identifiable by a numeric `teamId`**, and a **parseable tip-off**. A row
 * without them normalizes into a nameless team with a NaN start time, i.e. a
 * blank card that no date can ever select. Optional fields stay optional —
 * `wins`/`losses`/`periods`/`arenaName`/`gameLabel` may all be missing.
 *
 * The line they must not cross: a **legal empty array stays legal**. `games: []`
 * and `players: []` are real answers ("no games today", "no box score yet"),
 * and rejecting them would turn a calm empty state into an error. What is
 * rejected is a *container* whose contents cannot be read at all — `[null]`,
 * a missing array, or a team object with nothing in it.
 *
 * The stricter entry checks are measured against the real feed, not guessed:
 * the 2026-27 schedule read on 2026-10-11 (174 dates, 1,274 games) passes them
 * unchanged, including its 14 TBD team blocks (`teamId: 0`, empty names) for the
 * Emirates NBA Cup knockout games.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A tip-off the date window can actually parse.
 *
 * `windowOf` (and the scoreboard fallback) filter on `Date.parse(startTime)`,
 * and every comparison against `NaN` is false: a game with an unusable start
 * time is not listed late, it is listed *never*. `""` and junk are equally
 * unusable here.
 */
function isParseableTime(value: unknown): boolean {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

/** The fields every normalizer reads before a game can be identified at all. */
function hasGameIdentity(value: unknown): value is Record<string, unknown> {
  return isObject(value) && isNonEmptyString(value.gameId) && typeof value.gameStatus === "number";
}

/**
 * A team block whose id the model can carry.
 *
 * Zero is deliberately allowed: the real 2026-27 schedule uses
 * `{teamId: 0, teamName: "", teamTricode: "", ...}` for the Emirates NBA Cup
 * knockout games whose participants are still "TBD" — a legal placeholder, with
 * a real tip-off and status 1. Rejecting it would reject the whole season over
 * 14 placeholder team blocks (measured 2026-10-11). A *missing* or non-numeric
 * id is different: it normalizes into a team the interface cannot identify.
 */
function hasIdentifiableTeam(value: unknown): boolean {
  return isObject(value) && typeof value.teamId === "number" && Number.isFinite(value.teamId);
}

/** Both sides of a game are dereferenced by every normalizer, so both must exist. */
function hasBothIdentifiableTeams(value: Record<string, unknown>): boolean {
  return hasIdentifiableTeam(value.homeTeam) && hasIdentifiableTeam(value.awayTeam);
}

/**
 * The tip-off `normalizeScheduleGame` will actually put on the model.
 *
 * It reads `gameDateTimeUTC || gameTimeUTC`, so a non-empty-but-unparseable
 * preferred field is *not* saved by a good fallback — the fallback is never
 * read, and the model carries a NaN start time. The guard therefore mirrors the
 * normalizer's choice instead of accepting "one of the two is parseable".
 */
function hasUsableScheduleTime(value: Record<string, unknown>): boolean {
  if (isNonEmptyString(value.gameDateTimeUTC)) return isParseableTime(value.gameDateTimeUTC);
  return isParseableTime(value.gameTimeUTC);
}

/**
 * A team block is readable when it either carries the array we iterate or at
 * least one field we can display. `players: []` is readable — an empty box
 * score is a fact. `{}` is not: it would normalize into a blank, nameless team.
 */
function isReadableTeamBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (Array.isArray(value.players)) return true;
  return (
    typeof value.score === "number" ||
    typeof value.teamId === "number" ||
    isObject(value.statistics) ||
    Array.isArray(value.periods)
  );
}

/** `liveData/scoreboard/todaysScoreboard_00.json` */
export function isRawScoreboard(value: unknown): boolean {
  if (!isObject(value)) return false;
  const board = value.scoreboard;
  if (!isObject(board) || !Array.isArray(board.games)) return false;
  return board.games.every(
    (game) =>
      hasGameIdentity(game) &&
      hasBothIdentifiableTeams(game) &&
      // The scoreboard's own start time is the only one it carries.
      isParseableTime(game.gameTimeUTC),
  );
}

/** `staticData/scheduleLeagueV2_1.json` */
export function isRawSchedule(value: unknown): boolean {
  if (!isObject(value)) return false;
  const league = value.leagueSchedule;
  if (!isObject(league) || !Array.isArray(league.gameDates)) return false;
  // `gameDate` is dereferenced unguarded by the index builder, so it has to be
  // there. Each entry must also carry what the window filter and the
  // normalizer read before a game can appear anywhere: an id, a status, both
  // teams and a tip-off. Measured against the real 2026-27 feed (174 dates,
  // 1,274 games) on 2026-10-11 — it passes, but only because those four fields
  // are genuinely always present; the season is rejected as a whole if one row
  // is not, which is why the check stops at them.
  return league.gameDates.every(
    (gameDate) =>
      isObject(gameDate) &&
      isNonEmptyString(gameDate.gameDate) &&
      Array.isArray(gameDate.games) &&
      gameDate.games.every(
        (game) => hasGameIdentity(game) && hasBothIdentifiableTeams(game) && hasUsableScheduleTime(game),
      ),
  );
}

/** `liveData/boxscore/boxscore_<gameId>.json` */
export function isRawBoxScore(value: unknown): boolean {
  if (!isObject(value)) return false;
  const game = value.game;
  if (!isObject(game)) return false;
  return isReadableTeamBlock(game.homeTeam) && isReadableTeamBlock(game.awayTeam);
}

/** `liveData/playbyplay/playbyplay_<gameId>.json` */
export function isRawPlayByPlay(value: unknown): boolean {
  if (!isObject(value)) return false;
  const game = value.game;
  if (!isObject(game) || !Array.isArray(game.actions)) return false;
  // An empty action list is legal (nothing published yet); a null inside it is not.
  return game.actions.every(isObject);
}
