/**
 * Push subscription store: a single JSON file, because this is a single-user
 * tool with no database (PRD §29). Endpoint URLs stay on disk and are never
 * committed (see .gitignore) or sent back to any client.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_REMINDER_SETTINGS,
  type ReminderKind,
  type ReminderSettings,
} from "./reminders";

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface ReminderStore {
  subscription: StoredSubscription | null;
  settings: ReminderSettings;
  /** gameId → kinds already pushed, so restarts never double-notify. */
  notified: Record<string, ReminderKind[]>;
}

function storePath(): string {
  return join(process.cwd(), "data", "push.json");
}

function freshStore(): ReminderStore {
  return { subscription: null, settings: { ...DEFAULT_REMINDER_SETTINGS }, notified: {} };
}

export function loadStore(): ReminderStore {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Partial<ReminderStore>;
    return {
      subscription: raw.subscription ?? null,
      settings: { ...DEFAULT_REMINDER_SETTINGS, ...raw.settings },
      notified: raw.notified ?? {},
    };
  } catch {
    return freshStore();
  }
}

export function saveStore(store: ReminderStore): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store, null, 2));
}
