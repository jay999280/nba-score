/**
 * The localStorage boundary.
 *
 * The review reproduced a full page crash ("This page couldn't load") from a
 * legal-JSON but wrong-shaped `favoriteTeams`. These are the exact shapes that
 * used to get through, plus the requirement that one damaged key must not take
 * the other preferences with it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TEAM_CATALOG } from "../src/lib/nba/team-catalog.ts";
import {
  NO_FAVORITES,
  parseFavoriteIds,
  parseSpoiler,
  parseTheme,
} from "../src/lib/client/storage-validators.ts";

const LAL = 1610612747;
const GSW = 1610612744;

test("the crash case: a legal-JSON object is rejected, not trusted", () => {
  const result = parseFavoriteIds({ bad: true });
  assert.equal(result, NO_FAVORITES);
  assert.deepEqual(result, []);
});

test("null, strings, numbers and booleans are all rejected", () => {
  for (const value of [null, undefined, "湖人", 42, true, {}]) {
    assert.deepEqual(parseFavoriteIds(value), [], `rejected: ${JSON.stringify(value)}`);
  }
});

test("a nested wrong shape is rejected", () => {
  assert.deepEqual(parseFavoriteIds([{ id: LAL }]), []);
  assert.deepEqual(parseFavoriteIds([[LAL]]), []);
});

test("unknown team ids are dropped rather than trusted", () => {
  assert.deepEqual(parseFavoriteIds([LAL, 999, "x", null]), [LAL]);
});

test("a list of only unknown ids degrades to the shared empty value", () => {
  assert.equal(parseFavoriteIds([1, 2, 3]), NO_FAVORITES);
});

test("duplicates collapse and keep the first occurrence order", () => {
  assert.deepEqual(parseFavoriteIds([LAL, GSW, LAL]), [LAL, GSW]);
});

test("an already-valid list is returned by reference", () => {
  const stored = [LAL, GSW];
  assert.equal(parseFavoriteIds(stored), stored, "same shape in, same reference out");
});

test("every catalog team is accepted", () => {
  const all = TEAM_CATALOG.map((team) => team.id);
  assert.equal(parseFavoriteIds(all).length, 30);
});

test("theme accepts only the two defined values", () => {
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme("light"), "light");
  for (const value of ["blue", "", null, 0, {}, "DARK"]) {
    assert.equal(parseTheme(value), "light", `defaults for ${JSON.stringify(value)}`);
  }
});

test("spoiler accepts only a real true", () => {
  assert.equal(parseSpoiler(true), true);
  for (const value of ["true", 1, {}, null, undefined]) {
    assert.equal(parseSpoiler(value), false, `defaults for ${JSON.stringify(value)}`);
  }
});
