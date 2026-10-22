/**
 * "Is there a newer APK?" — the rules, and the one request they need.
 *
 * The app is side-loaded, so a new build is published as a GitHub Release and
 * installed by downloading its `.apk` asset; there is no store installer to ask
 * on our behalf. This module keeps everything that can be reasoned about
 * without a browser in pure functions (version ordering, release payload
 * parsing, the once-a-day throttle) so they are unit tested directly, and takes
 * the `fetch` implementation as an argument for the same reason.
 *
 * Every failure is silence. The repository may still be private (the anonymous
 * API answers 404), the phone may be offline, or GitHub may be rate-limiting —
 * none of that is the reader's problem, and a working app must never show an
 * error about an update it could not look up.
 */

/**
 * The single place the releases endpoint is named: change the repository here
 * (and nowhere else) if the project moves. `releases/latest` excludes drafts
 * and pre-releases, which is exactly what a side-loaded APK wants by default.
 */
export const RELEASES_API_URL =
  "https://api.github.com/repos/jay999280/nba-score/releases/latest";

/** At most one automatic check per day: the prompt is a nudge, not a poll. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A check that cannot finish in this window is treated as unavailable. */
export const CHECK_TIMEOUT_MS = 8_000;

/**
 * Keys are the project's camelCase localStorage style (see `storage.ts`), but
 * they live here rather than in the shared key list: the shape validators and
 * the writer have to stay together to be reviewable as one boundary.
 */
export const UPDATE_STORAGE_KEYS = {
  lastCheckedAt: "updateLastCheckedAt",
  dismissed: "updateDismissed",
} as const;

/** What a release asset list has to offer for a prompt to be useful. */
export interface LatestRelease {
  /** Normalised, without the leading `v`: `1.1.3`. */
  version: string;
  downloadUrl: string;
  prerelease: boolean;
}

/** The part of a release worth putting on screen. */
export interface UpdateInfo {
  version: string;
  downloadUrl: string;
}

/** `{ version, date }` written when the reader hides the row for today. */
export interface UpdateDismissal {
  version: string;
  /** Local calendar key, `YYYY-MM-DD`. */
  date: string;
}

/**
 * The release tag and the build's own version must both look like `1.2.3`
 * (optionally `v`-prefixed, optionally with a pre-release suffix). A tag is
 * allowed to say anything; only the ones we can order are trusted.
 */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const TAG_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface ParsedVersion {
  parts: [number, number, number];
  /** SemVer pre-release identifiers, or null for a normal release. */
  prerelease: string[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

/**
 * Order two versions: negative when `a` is older, positive when newer, 0 when
 * equal. Both `1.1.2` and `v1.1.3` spellings are accepted; a value that is not
 * a version compares as "not newer", because the only callers are a validated
 * release tag and the build's own package version — and refusing to prompt on
 * an unreadable value is the safe answer.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  for (let index = 0; index < left.parts.length; index += 1) {
    const difference = left.parts[index] - right.parts[index];
    if (difference !== 0) return difference;
  }

  // SemVer §11: a pre-release sorts before the release it leads up to, so
  // 1.2.0-rc.1 < 1.2.0. We never prompt for a pre-release anyway, but ordering
  // them correctly keeps "is this newer than what I have?" honest.
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = left.prerelease[index];
    const bPart = right.prerelease[index];
    // A shorter pre-release list is older when all shared parts are equal.
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;

    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) {
      const difference = Number(aPart) - Number(bPart);
      if (difference !== 0) return difference;
    } else if (aNumeric) {
      // Numeric identifiers always sort before alphanumeric ones.
      return -1;
    } else if (bNumeric) {
      return 1;
    } else if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Read a GitHub `releases/latest` payload into the one fact that matters.
 *
 * `null` means "there is no update to offer", not "the payload is broken":
 * a tag we cannot order, no `.apk` asset (the release notes are not installable
 * either), or a malformed body all produce the same silence on screen. Only an
 * `https:` asset URL is accepted — the app should never launch an arbitrary
 * scheme out of release metadata.
 */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (!isRecord(json)) return null;

  const tag = typeof json.tag_name === "string" ? json.tag_name.trim() : "";
  const match = TAG_PATTERN.exec(tag);
  if (!match) return null;

  const assets = Array.isArray(json.assets) ? json.assets : [];
  for (const asset of assets) {
    if (!isRecord(asset)) continue;
    const name = typeof asset.name === "string" ? asset.name.trim() : "";
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url.trim() : "";
    if (!name.toLowerCase().endsWith(".apk")) continue;
    if (!url.startsWith("https://")) continue;
    return { version: match[1], downloadUrl: url, prerelease: json.prerelease === true };
  }
  return null;
}

/**
 * The 24-hour throttle. `lastCheckedAt === null` means "never checked".
 *
 * A timestamp in the future is not evidence a check just happened — the device
 * clock moved, or storage was written by hand — so it triggers a check instead
 * of freezing the feature until the clock catches up.
 */
export function shouldCheck(now: number, lastCheckedAt: number | null): boolean {
  if (lastCheckedAt === null || !Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) return true;
  const elapsed = now - lastCheckedAt;
  return elapsed < 0 || elapsed >= CHECK_INTERVAL_MS;
}

/** localStorage is not trusted: only a positive finite timestamp is accepted. */
export function parseLastCheckedAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Same boundary for the dismissal; a half-written record just stops helping. */
export function parseUpdateDismissal(value: unknown): UpdateDismissal | null {
  if (!isRecord(value)) return null;
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const date = typeof value.date === "string" ? value.date.trim() : "";
  if (version === "" || !DATE_PATTERN.test(date)) return null;
  return { version, date };
}

/**
 * The minimum surface of `fetch` this module needs, so tests can inject a
 * deterministic implementation and a real platform fetch still fits.
 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal; cache?: RequestCache },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface CheckForUpdateOptions {
  /** The version this build was built from (injected by next.config.ts). */
  currentVersion: string;
  /** Real `fetch` in production; a stub in tests. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Ask GitHub for the latest release and return it only if it is a newer,
 * installable, stable build. Any doubt — non-2xx, timeout, offline, CORS,
 * malformed JSON — resolves to `null`, and the caller renders nothing.
 */
export async function checkForUpdate({
  currentVersion,
  fetchImpl,
  timeoutMs = CHECK_TIMEOUT_MS,
}: CheckForUpdateOptions): Promise<UpdateInfo | null> {
  const request = fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof request !== "function" || currentVersion.trim() === "") return null;

  // A hung request must not keep a phone spinning; abort it instead of leaving
  // a promise (and its listeners) alive for the rest of the session.
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await request(RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller?.signal,
      // The 24-hour throttle is ours; an HTTP cache replaying yesterday's
      // answer would make the check report a version the reader already has.
      cache: "no-store",
    });
    if (!response.ok) return null;

    const release = parseLatestRelease(await response.json());
    if (!release) return null;
    // `releases/latest` already skips pre-releases, but a tag pushed as a
    // pre-release is not something to push onto a side-loaded install.
    if (release.prerelease) return null;
    if (compareVersions(release.version, currentVersion) <= 0) return null;

    return { version: release.version, downloadUrl: release.downloadUrl };
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
