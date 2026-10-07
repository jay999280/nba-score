/**
 * Unit tests for the reminder policy (src/lib/nba/reminders.ts).
 *
 * The module has no runtime imports, so it compiles standalone with the
 * sibling tsconfig and runs in plain node — no browser, no server, no clock
 * mocking needed because `nowMs` is an explicit argument.
 *
 * Run:  node scripts/test-reminders.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");

const dir = mkdtempSync(join(tmpdir(), "rm-test-"));
try {
  execFileSync(
    process.execPath,
    [tscBin, "-p", "scripts/tsconfig.test.json", "--outDir", dir],
    { stdio: "pipe", cwd: process.cwd() },
  );
  const lib = await import(pathToFileURL(join(dir, "lib", "nba", "reminders.js")).href);
  const { selectDueReminders, reminderMessage, sanitizeSettings, sanitizeSubscription } = lib;

  const NOW = Date.parse("2026-10-06T10:00:00+08:00");
  const MIN = 60_000;
  const game = (overrides = {}) => ({
    id: "g1",
    status: "upcoming",
    postponed: false,
    startTime: new Date(NOW + 10 * MIN).toISOString(),
    away: { id: 1, name: "灰熊", score: null },
    home: { id: 2, name: "老鹰", score: null },
    ...overrides,
  });
  const SET = {
    enabled: true,
    teams: [1],
    leadMinutes: 15,
    notifyStart: true,
    notifyFinal: true,
  };

  const checks = [
    ["disabled → none", () => assert.deepEqual(selectDueReminders(NOW, [game()], { ...SET, enabled: false }, {}), [])],
    ["no teams → none", () => assert.deepEqual(selectDueReminders(NOW, [game()], { ...SET, teams: [] }, {}), [])],
    ["upcoming in window → start", () => {
      const due = selectDueReminders(NOW, [game()], SET, {});
      assert.equal(due.length, 1);
      assert.equal(due[0].kind, "start");
    }],
    ["outside lead window → none", () => assert.deepEqual(
      selectDueReminders(NOW, [game({ startTime: new Date(NOW + 20 * MIN).toISOString() })], SET, {}), [])],
    ["already started → none", () => assert.deepEqual(
      selectDueReminders(NOW, [game({ startTime: new Date(NOW - 5 * MIN).toISOString() })], SET, {}), [])],
    ["unfollowed team → none", () => assert.deepEqual(
      selectDueReminders(NOW, [game()], { ...SET, teams: [99] }, {}), [])],
    ["postponed → none", () => assert.deepEqual(
      selectDueReminders(NOW, [game({ postponed: true })], SET, {}), [])],
    ["already notified → none", () => assert.deepEqual(
      selectDueReminders(NOW, [game()], SET, { g1: ["start"] }), [])],
    ["recent final → due", () => {
      const g = game({ status: "final", startTime: new Date(NOW - 3 * 60 * MIN).toISOString() });
      g.away.score = 100; g.home.score = 99;
      const due = selectDueReminders(NOW, [g], SET, {});
      assert.equal(due.length, 1);
      assert.equal(due[0].kind, "final");
    }],
    ["old final → none", () => assert.deepEqual(
      selectDueReminders(NOW, [game({ status: "final", startTime: new Date(NOW - 9 * 60 * MIN).toISOString() })], SET, {}), [])],
    ["final notified → none", () => assert.deepEqual(
      selectDueReminders(NOW, [game({ status: "final", startTime: new Date(NOW - 60 * MIN).toISOString() })], SET, { g1: ["final"] }), [])],
    ["notifyStart off → no start", () => assert.deepEqual(
      selectDueReminders(NOW, [game()], { ...SET, notifyStart: false }, {}), [])],
    ["notifyFinal off → no final", () => assert.deepEqual(
      selectDueReminders(NOW, [game({ status: "final", startTime: new Date(NOW - 60 * MIN).toISOString() })], { ...SET, notifyFinal: false }, {}), [])],
    ["start message", () => assert.deepEqual(
      reminderMessage({ gameId: "g1", kind: "start", awayName: "灰熊", awayScore: null, homeName: "老鹰", homeScore: null, startTime: "" }, 15),
      { title: "灰熊 vs 老鹰 即将开始", body: "还有15分钟开球" })],
    ["final message", () => assert.deepEqual(
      reminderMessage({ gameId: "g1", kind: "final", awayName: "灰熊", awayScore: 100, homeName: "老鹰", homeScore: 99, startTime: "" }, 15),
      { title: "灰熊 100 - 99 老鹰 比赛结束", body: "点击查看技术统计" })],
    ["sanitize valid", () => assert.deepEqual(
      sanitizeSettings({ enabled: true, teams: [1, 2], leadMinutes: 30, notifyStart: true, notifyFinal: false }),
      { enabled: true, teams: [1, 2], leadMinutes: 30, notifyStart: true, notifyFinal: false })],
    ["sanitize bad lead", () => assert.equal(
      sanitizeSettings({ enabled: true, teams: [], leadMinutes: 20, notifyStart: true, notifyFinal: true }), null)],
    ["sanitize bad teams", () => assert.equal(
      sanitizeSettings({ enabled: true, teams: ["x"], leadMinutes: 15, notifyStart: true, notifyFinal: true }), null)],
    ["sanitize subscription ok", () => {
      const sub = sanitizeSubscription({ endpoint: "https://fcm.example/push/abc", keys: { p256dh: "k1", auth: "k2" } });
      assert.deepEqual(sub, { endpoint: "https://fcm.example/push/abc", keys: { p256dh: "k1", auth: "k2" } });
    }],
    ["sanitize subscription http → null", () => assert.equal(
      sanitizeSubscription({ endpoint: "http://x/y", keys: { p256dh: "k1", auth: "k2" } }), null)],
  ];

  let failed = 0;
  for (const [name, run] of checks) {
    try {
      run();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`);
    }
  }
  console.log(failed === 0 ? "ALL REMINDER CHECKS PASSED" : `${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
