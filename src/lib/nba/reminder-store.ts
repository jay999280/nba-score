/**
 * Push subscription store with two backends:
 * - Vercel KV when KV_REST_API_URL + KV_REST_API_TOKEN are set (production,
 *   where the serverless filesystem is ephemeral);
 * - a local JSON file otherwise (local dev, zero setup).
 *
 * Endpoint URLs are never committed (see .gitignore) or sent to clients.
 * The @vercel/kv import is lazy so local dev never touches it.
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

const KV_KEY = "nba:push";

export function storeBackend(): "kv" | "file" {
  return process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN ? "kv" : "file";
}

function storePath(): string {
  return join(process.cwd(), "data", "push.json");
}

function freshStore(): ReminderStore {
  return { subscription: null, settings: { ...DEFAULT_REMINDER_SETTINGS }, notified: {} };
}

function normalize(raw: Partial<ReminderStore>): ReminderStore {
  return {
    subscription: raw.subscription ?? null,
    settings: { ...DEFAULT_REMINDER_SETTINGS, ...raw.settings },
    notified: raw.notified ?? {},
  };
}

export async function loadStore(): Promise<ReminderStore> {
  if (storeBackend() === "kv") {
    try {
      const { kv } = await import("@vercel/kv");
      const raw = (await kv.get<Partial<ReminderStore>>(KV_KEY)) ?? {};
      return normalize(raw);
    } catch {
      return freshStore();
    }
  }
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Partial<ReminderStore>;
    return normalize(raw);
  } catch {
    return freshStore();
  }
}

export async function saveStore(store: ReminderStore): Promise<void> {
  if (storeBackend() === "kv") {
    const { kv } = await import("@vercel/kv");
    await kv.set(KV_KEY, store);
    return;
  }
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store, null, 2));
}
