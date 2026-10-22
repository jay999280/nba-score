/**
 * The update check's rules.
 *
 * Everything here is the part that can be wrong without a phone: how versions
 * are ordered, what a GitHub release payload means, and when a check is allowed
 * to run. The request itself is exercised with an injected `fetch`, so the
 * suite stays offline and deterministic (no network, no browser).
 *
 * The failures that matter are the quiet ones: a malformed tag must not prompt,
 * a release without an `.apk` must not prompt (there is nothing to install),
 * and every HTTP/network problem must resolve to `null` instead of an error.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHECK_INTERVAL_MS,
  RELEASES_API_URL,
  checkForUpdate,
  compareVersions,
  parseLastCheckedAt,
  parseLatestRelease,
  parseUpdateDismissal,
  shouldCheck,
  type FetchLike,
} from "../src/lib/client/update-check.ts";

const APK_URL =
  "https://github.com/jay999280/nba-score/releases/download/v1.1.3/nba-score.apk";

/** A payload shaped like `GET /repos/:owner/:repo/releases/latest`. */
function releaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: "v1.1.3",
    prerelease: false,
    assets: [{ name: "nba-score.apk", browser_download_url: APK_URL }],
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  init: { headers: Record<string, string>; signal?: AbortSignal; cache?: RequestCache };
}

/** A `fetch` stand-in that records calls and answers from `answer`. */
function stubFetch(answer: (url: string) => { ok?: boolean; body?: unknown; fail?: boolean }): {
  fetchImpl: FetchLike;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const result = answer(url);
    if (result.fail) throw new TypeError("Failed to fetch");
    return { ok: result.ok ?? true, json: async () => result.body };
  };
  return { fetchImpl, calls };
}

function bytes(payload: unknown): string {
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

test("versions order numerically, not as strings", () => {
  assert.ok(compareVersions("1.1.2", "1.1.3") < 0);
  assert.ok(compareVersions("1.1.3", "1.1.2") > 0);
  assert.equal(compareVersions("1.1.2", "1.1.2"), 0);
  // String comparison would put 1.9.0 above 1.10.0; the numbers must not.
  assert.ok(compareVersions("1.9.0", "1.10.0") < 0);
  assert.ok(compareVersions("1.99.99", "2.0.0") < 0);
});

test("the `v` prefix and surrounding whitespace do not change the order", () => {
  assert.equal(compareVersions("v1.1.3", "1.1.3"), 0);
  assert.equal(compareVersions("1.1.3", "v1.1.3"), 0);
  assert.equal(compareVersions(" V1.1.3 ", "v1.1.3"), 0);
  assert.ok(compareVersions("v1.1.2", "v1.1.3") < 0);
});

test("a pre-release sorts before the release it leads up to", () => {
  assert.ok(compareVersions("1.2.0-rc.1", "1.2.0") < 0);
  assert.ok(compareVersions("1.2.0", "1.2.0-rc.1") > 0);
  assert.ok(compareVersions("1.2.0-alpha", "1.2.0-beta") < 0);
  // Numeric pre-release identifiers are compared as numbers...
  assert.ok(compareVersions("1.2.0-beta.2", "1.2.0-beta.10") < 0);
  // ...and sort below alphanumeric ones (SemVer §11).
  assert.ok(compareVersions("1.2.0-1", "1.2.0-alpha") < 0);
});

test("build metadata is ignored", () => {
  assert.equal(compareVersions("1.2.3+build.5", "1.2.3"), 0);
  assert.equal(compareVersions("v1.2.3+build.5", "1.2.3+build.9"), 0);
});

test("an unreadable version never claims to be newer", () => {
  for (const value of ["", "latest", "1.1", "release-1.1.3", "1.1.3.4"]) {
    assert.equal(compareVersions(value, "1.1.2"), 0, `no order for ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// parseLatestRelease
// ---------------------------------------------------------------------------

test("a release with an apk asset yields the version and download url", () => {
  const release = parseLatestRelease(releaseJson());
  assert.deepEqual(release, { version: "1.1.3", downloadUrl: APK_URL, prerelease: false });
});

test("the tag is normalised: the `v` prefix is not part of the version", () => {
  assert.equal(parseLatestRelease(releaseJson({ tag_name: "1.1.3" }))?.version, "1.1.3");
});

test("the apk asset is picked out from the other assets", () => {
  const release = parseLatestRelease(
    releaseJson({
      assets: [
        { name: "source.tar.gz", browser_download_url: "https://example.com/source.tar.gz" },
        { name: "nba-score.apk", browser_download_url: APK_URL },
        { name: "notes.txt", browser_download_url: "https://example.com/notes.txt" },
      ],
    }),
  );
  assert.equal(release?.downloadUrl, APK_URL);
});

test("the extension test is case-insensitive", () => {
  const release = parseLatestRelease(
    releaseJson({ assets: [{ name: "NBA-SCORE.APK", browser_download_url: APK_URL }] }),
  );
  assert.equal(release?.downloadUrl, APK_URL);
});

test("a release without an apk asset has nothing to offer", () => {
  // The release notes are not installable either, so the whole payload reads as
  // "no update" rather than as a partially usable result.
  const release = parseLatestRelease(
    releaseJson({
      assets: [
        { name: "source.tar.gz", browser_download_url: "https://example.com/source.tar.gz" },
        { name: "nba-score.exe", browser_download_url: "https://example.com/nba-score.exe" },
      ],
    }),
  );
  assert.equal(release, null);
});

test("an apk asset without a safe https url is rejected", () => {
  for (const browser_download_url of [undefined, "", "http://example.com/a.apk", "javascript:alert(1)"]) {
    const release = parseLatestRelease(
      releaseJson({ assets: [{ name: "nba-score.apk", browser_download_url }] }),
    );
    assert.equal(release, null, `rejected ${JSON.stringify(browser_download_url)}`);
  }
});

test("a prerelease is parsed but flagged, so the caller can decide", () => {
  const release = parseLatestRelease(releaseJson({ prerelease: true }));
  assert.equal(release?.prerelease, true);
});

test("payloads that are not a release degrade to null", () => {
  const payloads: unknown[] = [
    null,
    undefined,
    "not an object",
    42,
    [],
    {},
    { tag_name: 1, assets: [] },
    { tag_name: "release-1.1.3", assets: [{ name: "a.apk", browser_download_url: APK_URL }] },
    { tag_name: "v1.1", assets: [{ name: "a.apk", browser_download_url: APK_URL }] },
    { tag_name: "v1.1.3", assets: "nope" },
    { tag_name: "v1.1.3" },
    { tag_name: "v1.1.3", assets: [null, 3, "a.apk"] },
  ];
  for (const payload of payloads) {
    assert.equal(parseLatestRelease(payload), null, `rejected ${bytes(payload)}`);
  }
});

// ---------------------------------------------------------------------------
// shouldCheck — the 24h throttle
// ---------------------------------------------------------------------------

test("a device that never checked asks for a check", () => {
  assert.equal(shouldCheck(1_700_000_000_000, null), true);
});

test("the check is throttled for 24 hours, measured from the last attempt", () => {
  const last = 1_700_000_000_000;
  assert.equal(shouldCheck(last + CHECK_INTERVAL_MS - 1, last), false);
  assert.equal(shouldCheck(last + CHECK_INTERVAL_MS, last), true);
  assert.equal(shouldCheck(last + CHECK_INTERVAL_MS * 3, last), true);
});

test("garbage in storage is not allowed to freeze the check", () => {
  const now = 1_700_000_000_000;
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, -CHECK_INTERVAL_MS]) {
    assert.equal(shouldCheck(now, value), true, `checked for ${value}`);
  }
});

test("a timestamp in the future forces a check instead of freezing it", () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldCheck(now, now + CHECK_INTERVAL_MS), true);
});

// ---------------------------------------------------------------------------
// Storage shape validators
// ---------------------------------------------------------------------------

test("only a positive finite timestamp is a stored check time", () => {
  assert.equal(parseLastCheckedAt(1_700_000_000_000), 1_700_000_000_000);
  for (const value of [null, undefined, "1700000000000", Number.NaN, Number.POSITIVE_INFINITY, 0, -5, {}, []]) {
    assert.equal(parseLastCheckedAt(value), null, `rejected ${bytes(value)}`);
  }
});

test("a dismissal is only accepted in the shape the app writes", () => {
  assert.deepEqual(parseUpdateDismissal({ version: "1.1.3", date: "2026-10-22" }), {
    version: "1.1.3",
    date: "2026-10-22",
  });
  for (const value of [
    null,
    "2026-10-22",
    {},
    { version: "", date: "2026-10-22" },
    { version: 1.1, date: "2026-10-22" },
    { version: "1.1.3", date: "2026/10/22" },
    { version: "1.1.3", date: 20261022 },
    { version: "1.1.3" },
  ]) {
    assert.equal(parseUpdateDismissal(value), null, `rejected ${bytes(value)}`);
  }
});

// ---------------------------------------------------------------------------
// checkForUpdate — the request, with fetch injected
// ---------------------------------------------------------------------------

test("a newer release resolves to the version and download url", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ body: releaseJson() }));
  const update = await checkForUpdate({ currentVersion: "1.1.2", fetchImpl });

  assert.deepEqual(update, { version: "1.1.3", downloadUrl: APK_URL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RELEASES_API_URL);
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0].init.cache, "no-store");
});

test("the same version is not an update", async () => {
  const { fetchImpl } = stubFetch(() => ({ body: releaseJson({ tag_name: "v1.1.2" }) }));
  assert.equal(await checkForUpdate({ currentVersion: "1.1.2", fetchImpl }), null);
});

test("an older release is not an update", async () => {
  const { fetchImpl } = stubFetch(() => ({ body: releaseJson({ tag_name: "v1.0.9" }) }));
  assert.equal(await checkForUpdate({ currentVersion: "1.1.2", fetchImpl }), null);
});

test("the release without an apk asset is silent", async () => {
  const { fetchImpl } = stubFetch(() => ({
    body: releaseJson({
      assets: [{ name: "source.tar.gz", browser_download_url: "https://example.com/source.tar.gz" }],
    }),
  }));
  assert.equal(await checkForUpdate({ currentVersion: "1.1.2", fetchImpl }), null);
});

test("a prerelease is never offered", async () => {
  const { fetchImpl } = stubFetch(() => ({ body: releaseJson({ prerelease: true }) }));
  assert.equal(await checkForUpdate({ currentVersion: "1.1.2", fetchImpl }), null);
});

test("an HTTP failure, a malformed body and a network error are all silent", async () => {
  const cases: Array<[string, () => { ok?: boolean; body?: unknown; fail?: boolean }]> = [
    ["404 from a private repository", () => ({ ok: false, body: { message: "Not Found" } })],
    ["403 rate limit", () => ({ ok: false, body: { message: "API rate limit exceeded" } })],
    ["network failure", () => ({ fail: true })],
    ["a body that is not a release", () => ({ body: { detail: "something else" } })],
    ["a body that is not JSON", () => ({ body: undefined })],
  ];
  for (const [label, answer] of cases) {
    const { fetchImpl } = stubFetch(answer);
    assert.equal(await checkForUpdate({ currentVersion: "1.1.2", fetchImpl }), null, label);
  }
});

test("without a known own version there is nothing to compare, so no request is made", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ body: releaseJson() }));
  assert.equal(await checkForUpdate({ currentVersion: "", fetchImpl }), null);
  assert.equal(await checkForUpdate({ currentVersion: "   ", fetchImpl }), null);
  assert.equal(calls.length, 0);
});
