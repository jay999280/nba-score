/**
 * The built season index, kept across process restarts.
 *
 * `scheduleLeagueV2_1.json` is ~7 MB of uncompressed JSON. The web build keeps
 * it in a server process for six hours, but the Android app has no server: the
 * service layer runs inside the WebView, so without a store on the device every
 * cold start pays the whole download again — and so does every date switch
 * until it finishes. That download is the reason the app sat on a skeleton for
 * tens of seconds; the poll loop cannot paper over a 7 MB read.
 *
 * What is stored is the *built index*, not the upstream document: normalized
 * entries (a few hundred KB) instead of the megabytes of upstream fields the
 * app never reads. It is written as a structured clone rather than a JSON
 * string, so restoring it is a deserialize instead of a large parse.
 *
 * IndexedDB is the only client storage that comfortably holds this. It is
 * absent on the server (where the in-memory cache already does the job), so
 * every function here degrades to "no cache" rather than throwing.
 */

import type { ScheduleEntry } from "./schedule";

const DB_NAME = "nba-score";
const DB_VERSION = 1;
const STORE_NAME = "schedule";
const RECORD_KEY = "index-v1";

export interface PersistedSchedule {
  entries: ScheduleEntry[];
  season: string;
  sourceAt: string | null;
  /** When this copy was fetched (epoch ms) — the TTL is measured from here. */
  fetchedAt: number;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** One connection per process; a failure is remembered until the next call. */
function database(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = openDatabase().catch(() => {
      dbPromise = null;
      return null;
    });
  }
  return dbPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Enough of a check to refuse a corrupt or half-written record.
 *
 * A deep validation of every game would cost as much as the read it protects;
 * the entries were written by this module from a validated upstream document,
 * so it is the *shape* that could have been damaged (an interrupted upgrade, a
 * quota-cleared database), not the individual fields.
 */
function isScheduleEntry(value: unknown): value is ScheduleEntry {
  if (!isRecord(value)) return false;
  const game = value.game;
  if (!isRecord(game)) return false;
  const home = game.home;
  const away = game.away;
  if (!isRecord(home) || !isRecord(away)) return false;
  return (
    typeof value.etDate === "string" &&
    typeof value.startTime === "string" &&
    typeof game.id === "string" &&
    typeof game.status === "string" &&
    typeof home.id === "number" &&
    typeof away.id === "number"
  );
}

function isPersistedSchedule(value: unknown): value is PersistedSchedule {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.entries) || value.entries.length === 0) return false;
  if (typeof value.season !== "string") return false;
  if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) return false;
  if (value.sourceAt !== null && typeof value.sourceAt !== "string") return false;
  return value.entries.every(isScheduleEntry);
}

/** The stored index, if this device has one and it is intact. */
export async function loadPersistedSchedule(): Promise<PersistedSchedule | null> {
  const db = await database();
  if (!db) return null;

  return new Promise<PersistedSchedule | null>((resolve) => {
    let settled = false;
    const finish = (value: PersistedSchedule | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
      request.onsuccess = () => {
        const value: unknown = request.result;
        finish(isPersistedSchedule(value) ? value : null);
      };
      request.onerror = () => finish(null);
      transaction.onabort = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

/**
 * Replace the stored index. Fire-and-forget on purpose: the caller has the
 * index in memory already and must not wait for a disk write to show a screen.
 */
export async function savePersistedSchedule(record: PersistedSchedule): Promise<void> {
  const db = await database();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(record, RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Used by the regression suite and by a corrupt-record recovery path. */
export async function clearPersistedSchedule(): Promise<void> {
  const db = await database();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
