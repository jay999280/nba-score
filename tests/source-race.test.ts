/**
 * Origin selection.
 *
 * `cdn.nba.com` is the documented origin, but on some networks it is blocked
 * outright — the TLS handshake is reset, and a sequential fallback therefore
 * spends a full connection timeout before the mirror even starts. Every
 * document the app needs paid that cost, which is most of a cold start.
 *
 * What is asserted here: with no origin yet remembered the sources are raced
 * (the healthy one answers immediately), and once one has answered it is
 * asked first from then on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchSource, setUpstreamRequester } from "../src/lib/nba/source.ts";

const BLOCKED = "https://cdn.nba.com/";
const MIRROR = "https://nba-prod-us-east-1-mediaops-stats.s3.amazonaws.com/";

const attempts: string[] = [];

/** The documented origin behaves like the blocked route: it never answers usefully. */
const BLOCKED_AFTER_MS = 120;

setUpstreamRequester(async (url) => {
  attempts.push(url);

  if (url.startsWith(BLOCKED)) {
    await new Promise((resolve) => setTimeout(resolve, BLOCKED_AFTER_MS));
    throw new Error("TLS handshake reset");
  }

  return { status: 200, text: JSON.stringify({ answer: "mirror" }) };
});

function attemptsAgainst(prefix: string): number {
  return attempts.filter((url) => url.startsWith(prefix)).length;
}

test("a blocked origin costs one attempt, not a timeout in front of the answer", async () => {
  const started = Date.now();
  const value = await fetchSource<{ answer: string }>("staticData/first.json", 0, 15_000);
  const elapsed = Date.now() - started;

  assert.equal(value.answer, "mirror");
  assert.ok(elapsed < BLOCKED_AFTER_MS - 20, `raced past the blocked origin (took ${elapsed} ms)`);
  assert.equal(attemptsAgainst(BLOCKED), 1, "the blocked origin was tried exactly once");
});

test("the origin that answered is asked first afterwards", async () => {
  attempts.length = 0;

  const value = await fetchSource<{ answer: string }>("staticData/second.json", 0, 15_000);

  assert.equal(value.answer, "mirror");
  assert.equal(attemptsAgainst(MIRROR), 1, "the mirror was asked");
  assert.equal(attemptsAgainst(BLOCKED), 0, "the blocked origin is not tried again in the same session");
});
