"use client";

import { useCallback, useEffect, useState } from "react";

import {
  checkForUpdate,
  parseLastCheckedAt,
  parseUpdateDismissal,
  shouldCheck,
  UPDATE_STORAGE_KEYS,
  type UpdateDismissal,
  type UpdateInfo,
} from "@/lib/client/update-check";
import { localDateKey } from "@/lib/format";

import { CloseIcon, DownloadIcon } from "./icons";

/**
 * Injected by next.config.ts (`env`): the version this bundle was built from.
 *
 * Empty means the build did not carry a version — the banner then stays silent,
 * because without a "mine" every release would look newer.
 */
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

/** localStorage can throw (private mode, quota); a missing value is not an error. */
function readStored<T>(key: string, parse: (value: unknown) => T | null): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The dismissal is a convenience; forgetting it only means asking again.
  }
}

/**
 * One check per document, shared by every mount that asks for it.
 *
 * React's development StrictMode mounts the effect, cleans it up, and mounts it
 * again. The first run writes the throttle timestamp and is then cancelled, so
 * a naive second run would see a fresh timestamp, skip the request, and never
 * render what the first run fetched. Sharing the promise keeps exactly one
 * request while both runs observe the same answer.
 */
let pendingCheck: Promise<UpdateInfo | null> | null = null;

function checkOnce(): Promise<UpdateInfo | null> {
  if (pendingCheck === null) {
    const now = Date.now();
    if (!shouldCheck(now, readStored(UPDATE_STORAGE_KEYS.lastCheckedAt, parseLastCheckedAt))) {
      pendingCheck = Promise.resolve(null);
    } else {
      // Recorded before the request: a failed check still counts as "we looked
      // today", so an offline phone does not retry on every navigation.
      writeStored(UPDATE_STORAGE_KEYS.lastCheckedAt, now);
      pendingCheck = checkForUpdate({ currentVersion: APP_VERSION });
    }
  }
  return pendingCheck;
}

/**
 * "A newer APK exists" row (home page, next to the install prompt).
 *
 * The check runs after mount and never blocks the first paint; every failure
 * leaves the page exactly as it was. The row is one tap away from the download
 * and can be put off for the day — a version notice the reader cannot silence
 * is the kind of banner the app otherwise avoids.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (APP_VERSION === "") return;
    // Dismissed earlier today: nothing to show and no reason to ask GitHub.
    const dismissed = readStored(UPDATE_STORAGE_KEYS.dismissed, parseUpdateDismissal);
    if (dismissed?.date === localDateKey(new Date())) return;

    let alive = true;
    void checkOnce().then((found) => {
      if (alive && found) setUpdate(found);
    });
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (update) {
      const dismissal: UpdateDismissal = {
        version: update.version,
        date: localDateKey(new Date()),
      };
      writeStored(UPDATE_STORAGE_KEYS.dismissed, dismissal);
    }
    setUpdate(null);
  }, [update]);

  const openDownload = useCallback(() => {
    if (update === null) return;

    // Capacitor 8's Android WebView leaves multiple-window support at the
    // platform default (off), so an external-host navigation is handed to
    // `BridgeWebViewClient.shouldOverrideUrlLoading` → `Bridge.launchIntent`,
    // which fires an ACTION_VIEW intent: the system browser, not our WebView.
    // `_blank` is what starts that navigation, and it runs inside the tap, so
    // the browser's popup blocker lets it through. If a WebView discards the
    // request instead (window.open returns null), the same-frame fallback is
    // still intercepted by that same client on its way out.
    const opened = window.open(update.downloadUrl, "_blank");
    if (opened) {
      opened.opener = null;
    } else {
      window.location.assign(update.downloadUrl);
    }
  }, [update]);

  if (update === null) return null;

  return (
    <div className="notice animate-fade items-center">
      <DownloadIcon size={16} className="shrink-0 text-ink-3" />
      <button
        type="button"
        onClick={openDownload}
        className="flex min-h-11 min-w-0 flex-1 items-center text-left"
      >
        <span className="min-w-0 truncate text-body leading-snug text-ink-2">
          发现新版本 <span className="tnum">{update.version}</span>
          {" · "}
          <span className="font-medium text-ink">更新</span>
        </span>
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="当天不再提示更新"
        className="btn-ghost -mr-1 shrink-0"
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
