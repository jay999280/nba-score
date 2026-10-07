/**
 * Reminder scheduler: once a minute, ask which followed games need a push.
 *
 * Single-process by design (`next start` runs one). The timer is idempotent
 * across HMR reloads via a globalThis guard, and deliberately unref'd so it
 * can never keep a process alive on its own.
 *
 * Time is the server's local clock — correct for a self-hosted tool where
 * the server and the reader share a time zone.
 */

import webpush from "web-push";

import { listGames } from "./games";
import { reminderMessage, selectDueReminders } from "./reminders";
import { loadStore, saveStore } from "./reminder-store";

const CHECK_INTERVAL_MS = 60_000;

interface SchedulerGlobal {
  __nbaReminderTimer?: NodeJS.Timeout;
}

function vapidDetails(): { subject: string; publicKey: string; privateKey: string } | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:nba-score@localhost";
  if (!publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

/** Yesterday 00:00 → day-after-tomorrow 00:00: catches late games and finals. */
function checkWindow(now: Date): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function checkRemindersOnce(nowMs = Date.now()): Promise<{
  checked: number;
  sent: number;
}> {
  const store = loadStore();
  if (!store.subscription || !store.settings.enabled) return { checked: 0, sent: 0 };
  const details = vapidDetails();
  if (!details) return { checked: 0, sent: 0 };

  const { from, to } = checkWindow(new Date(nowMs));
  let games;
  try {
    games = await listGames(from, to);
  } catch {
    return { checked: 0, sent: 0 };
  }

  const due = selectDueReminders(nowMs, games, store.settings, store.notified);
  let sent = 0;
  for (const reminder of due) {
    const { title, body } = reminderMessage(reminder, store.settings.leadMinutes);
    try {
      await webpush.sendNotification(
        {
          endpoint: store.subscription.endpoint,
          keys: store.subscription.keys,
        },
        JSON.stringify({ title, body, gameId: reminder.gameId, kind: reminder.kind }),
        { TTL: 3600, vapidDetails: details },
      );
      sent++;
    } catch (error: unknown) {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? (error as { statusCode?: unknown }).statusCode
          : undefined;
      if (statusCode === 410 || statusCode === 404) {
        // Subscription expired at the vendor: stop trying until re-subscribe.
        store.subscription = null;
        break;
      }
      continue;
    }
    const kinds = store.notified[reminder.gameId] ?? [];
    if (!kinds.includes(reminder.kind)) kinds.push(reminder.kind);
    store.notified[reminder.gameId] = kinds;
  }

  if (due.length > 0) saveStore(store);
  return { checked: games.length, sent };
}

export function ensureScheduler(): boolean {
  const global = globalThis as SchedulerGlobal;
  if (global.__nbaReminderTimer) return true;
  const tick = () => {
    checkRemindersOnce().catch((error) => console.error("[reminders] check failed", error));
  };
  global.__nbaReminderTimer = setInterval(tick, CHECK_INTERVAL_MS);
  const timer = global.__nbaReminderTimer;
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

export function schedulerRunning(): boolean {
  return Boolean((globalThis as SchedulerGlobal).__nbaReminderTimer);
}
