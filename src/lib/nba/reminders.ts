/**
 * Reminder decision logic (PRD Future: 比赛提醒).
 *
 * Pure functions only — no I/O, no timers, no runtime imports — so the whole
 * policy is unit testable by compiling this single file on its own
 * (see scripts/test-reminders.mjs). Timers, storage and sending live in
 * reminder-scheduler.ts.
 */

import type { Game } from "@/lib/types";

export type ReminderKind = "start" | "final";

export interface ReminderSettings {
  enabled: boolean;
  /** Team ids to notify about. Empty means nobody — reminders stay silent. */
  teams: number[];
  leadMinutes: 15 | 30 | 60;
  notifyStart: boolean;
  notifyFinal: boolean;
}

export interface DueReminder {
  gameId: string;
  kind: ReminderKind;
  awayName: string;
  awayScore: number | null;
  homeName: string;
  homeScore: number | null;
  startTime: string;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: false,
  teams: [],
  leadMinutes: 15,
  notifyStart: true,
  notifyFinal: true,
};

/** Strict validation for anything arriving over HTTP. Returns null when invalid. */
export function sanitizeSettings(input: unknown): ReminderSettings | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.enabled !== "boolean") return null;
  if (
    !Array.isArray(value.teams) ||
    !value.teams.every((id): id is number => typeof id === "number")
  ) {
    return null;
  }
  if (value.leadMinutes !== 15 && value.leadMinutes !== 30 && value.leadMinutes !== 60) {
    return null;
  }
  if (typeof value.notifyStart !== "boolean" || typeof value.notifyFinal !== "boolean") {
    return null;
  }
  return {
    enabled: value.enabled,
    teams: value.teams,
    leadMinutes: value.leadMinutes,
    notifyStart: value.notifyStart,
    notifyFinal: value.notifyFinal,
  };
}

/** Push endpoints are always https URLs issued by the browser vendor. */
export function sanitizeSubscription(input: unknown): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  const keys = value.keys as Record<string, unknown> | undefined;
  if (
    typeof value.endpoint !== "string" ||
    !value.endpoint.startsWith("https://") ||
    typeof keys?.p256dh !== "string" ||
    keys.p256dh.length === 0 ||
    typeof keys?.auth !== "string" ||
    keys.auth.length === 0
  ) {
    return null;
  }
  return { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/**
 * A final observed long after tip-off is almost certainly a game the server
 * was asleep for — not something the reader wants a "just finished" push
 * about the next morning.
 */
const FINAL_LOOKBACK_MS = 8 * 60 * 60 * 1000;

/**
 * Which (game, kind) pairs deserve a push right now. `notified` maps gameId
 * to the kinds already sent; the scheduler persists it across restarts.
 */
export function selectDueReminders(
  nowMs: number,
  games: Game[],
  settings: ReminderSettings,
  notified: Record<string, ReminderKind[]>,
): DueReminder[] {
  if (!settings.enabled || settings.teams.length === 0) return [];
  const followed = new Set(settings.teams);
  const due: DueReminder[] = [];

  for (const game of games) {
    if (!followed.has(game.away.id) && !followed.has(game.home.id)) continue;
    const sent = notified[game.id] ?? [];
    const startMs = Date.parse(game.startTime);
    if (!Number.isFinite(startMs)) continue;

    const base = {
      gameId: game.id,
      awayName: game.away.name,
      awayScore: game.away.score,
      homeName: game.home.name,
      homeScore: game.home.score,
      startTime: game.startTime,
    };

    if (
      settings.notifyStart &&
      game.status === "upcoming" &&
      !game.postponed &&
      !sent.includes("start") &&
      startMs - nowMs > 0 &&
      startMs - nowMs <= settings.leadMinutes * 60 * 1000
    ) {
      due.push({ ...base, kind: "start" });
    }

    if (
      settings.notifyFinal &&
      game.status === "final" &&
      !sent.includes("final") &&
      nowMs - startMs <= FINAL_LOOKBACK_MS
    ) {
      due.push({ ...base, kind: "final" });
    }
  }

  return due;
}

export function reminderMessage(
  reminder: DueReminder,
  leadMinutes: number,
): { title: string; body: string } {
  if (reminder.kind === "start") {
    return {
      title: `${reminder.awayName} vs ${reminder.homeName} 即将开始`,
      body: `还有${leadMinutes}分钟开球`,
    };
  }
  const score =
    reminder.awayScore !== null && reminder.homeScore !== null
      ? ` ${reminder.awayScore} - ${reminder.homeScore}`
      : "";
  return {
    title: `${reminder.awayName}${score} ${reminder.homeName} 比赛结束`,
    body: "点击查看技术统计",
  };
}
