/**
 * Date windows.
 *
 * The home list asks for "this local day" and converts it to a UTC window, so
 * everything a reader sees on a date depends on this arithmetic. It must never
 * hard-code UTC+8 and must survive a daylight-saving transition.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAge, formatSourceAt, localDateKey, localDayWindow, parseLocalDateKey, periodLabel } from "../src/lib/format.ts";

const HOUR = 60 * 60 * 1000;

test("a window is half-open and covers one local day", () => {
  const { from, to } = localDayWindow("2026-10-11");
  const start = Date.parse(from);
  const end = Date.parse(to);

  assert.ok(start < end);
  const hours = (end - start) / HOUR;
  assert.ok(hours >= 23 && hours <= 25, `a local day is 23-25 hours, got ${hours}`);
});

test("consecutive windows tile without gaps or overlaps", () => {
  const first = localDayWindow("2026-10-11");
  const second = localDayWindow("2026-10-12");
  assert.equal(Date.parse(first.to), Date.parse(second.from));
});

test("the window's local date matches the key it was built from", () => {
  for (const key of ["2026-01-01", "2026-03-08", "2026-07-04", "2026-11-01", "2026-12-31"]) {
    const { from } = localDayWindow(key);
    assert.equal(localDateKey(new Date(Date.parse(from))), key, `round trip for ${key}`);
  }
});

test("the key round-trips through parse and format", () => {
  // 2028 is a real leap year; 2026-02-29 would roll forward to March 1.
  const key = "2028-02-29";
  const date = parseLocalDateKey(key);
  assert.equal(localDateKey(date), key);
  assert.equal(date.getHours(), 0, "local midnight, not UTC midnight");
});

test("overtime periods are labelled after regulation", () => {
  assert.equal(periodLabel(1), "第1节");
  assert.equal(periodLabel(4), "第4节");
  assert.equal(periodLabel(5), "加时", "a single overtime needs no number");
  assert.equal(periodLabel(6), "加时2");
  assert.equal(periodLabel(0), "");
});

test("midnight itself belongs to the day that starts", () => {
  const { from, to } = localDayWindow("2026-10-11");
  assert.equal(Date.parse(from), parseLocalDateKey("2026-10-11").getTime());
  assert.equal(Date.parse(to), parseLocalDateKey("2026-10-12").getTime());
});

/**
 * The label R5 requires: the interface must be able to say *when upstream said
 * the data was true*, which is not when this client fetched it.
 */
test("the source-time label always carries the date", () => {
  const label = formatSourceAt("2026-10-10T01:14:25.142Z");
  assert.ok(label, "a valid ISO timestamp must produce a label");
  // A line reading only "01:14" under a day-old payload is the confusion the
  // date is here to prevent, so both parts must be present whatever the zone.
  assert.match(label ?? "", /\d+-\d+ \d{2}:\d{2}/);
});

test("the source-time label refuses what it cannot read", () => {
  assert.equal(formatSourceAt(null), null);
  assert.equal(formatSourceAt(undefined), null);
  assert.equal(formatSourceAt(""), null);
  assert.equal(formatSourceAt("not a time"), null);
});

test("age is coarse and monotonic", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(formatAge(now - 10_000, now), "刚刚");
  assert.equal(formatAge(now - 42 * 60_000, now), "42分钟前");
  assert.equal(formatAge(now - 5 * HOUR, now), "5小时前");
  assert.equal(formatAge(now - 2 * 24 * HOUR, now), "2天前");
  assert.equal(formatAge(now - 61 * 24 * HOUR, now), "约2个月前");
  assert.equal(formatAge("garbage", now), null);
});
