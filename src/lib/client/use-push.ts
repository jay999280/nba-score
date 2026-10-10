"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  type ReminderSettings,
} from "@/lib/nba/reminders";

export type { ReminderSettings };

interface PushStatusResponse {
  configured: boolean;
  vapidPublicKey: string | null;
  subscribed: boolean;
  settings: ReminderSettings | null;
  scheduler: boolean;
}

export type PushPermission = NotificationPermission | "unsupported";

export interface PushController {
  supported: boolean;
  permission: PushPermission;
  subscribed: boolean;
  settings: ReminderSettings | null;
  busy: boolean;
  enable: (settings: ReminderSettings) => Promise<boolean>;
  disable: () => Promise<void>;
  saveSettings: (settings: ReminderSettings) => Promise<boolean>;
  refresh: () => Promise<void>;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob(base64.replace(/-/g, "+").replace(/_/g, "/") + padding);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

const subscribeNoop = () => () => {};
const permissionSnapshot = (): PushPermission =>
  typeof window !== "undefined" && "Notification" in window
    ? Notification.permission
    : "unsupported";
const permissionServerSnapshot = (): PushPermission => "unsupported";

/**
 * Web Push belongs to the web build. The Android app has no server to hold a
 * VAPID subscription and no FCM channel to deliver through (Google's push
 * service is unreachable on the networks this app exists for), so the reminder
 * controls stay hidden there instead of offering something that cannot work.
 * On-device notifications are the app's route to that feature.
 */
function nativeSnapshot(): boolean {
  if (typeof window === "undefined") return true;
  const capacitor = (
    window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}
const nativeServerSnapshot = () => true;

/**
 * Web Push subscription state. The permission itself has no change events, so
 * the external store is read-only and local overrides cover our own flows.
 */
export function usePush(): PushController {
  const native = useSyncExternalStore(subscribeNoop, nativeSnapshot, nativeServerSnapshot);
  const storedPermission = useSyncExternalStore(
    subscribeNoop,
    permissionSnapshot,
    permissionServerSnapshot,
  );
  const [permissionOverride, setPermissionOverride] = useState<NotificationPermission | null>(null);
  const [status, setStatus] = useState<PushStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const permission = permissionOverride ?? storedPermission;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/push/status", { cache: "no-store" });
      if (!response.ok) return;
      setStatus((await response.json()) as PushStatusResponse);
    } catch {
      // Offline or starting up: keep the last known state.
    }
  }, []);

  useEffect(() => {
    if (native) return;
    let cancelled = false;
    fetch("/api/push/status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) setStatus(data as PushStatusResponse);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [native]);

  useEffect(() => {
    // Permission can change outside the app (browser site settings); re-read
    // whenever the window regains focus so the UI never shows a stale value.
    const sync = () => {
      if (typeof window !== "undefined" && "Notification" in window) {
        setPermissionOverride(Notification.permission);
      }
    };
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  const enable = useCallback(
    async (settings: ReminderSettings): Promise<boolean> => {
      if (permission === "unsupported") return false;
      if (!status?.vapidPublicKey) {
        await refresh();
        return false;
      }
      setBusy(true);
      try {
        // Always ask live instead of trusting the cached permission: it can
        // predate a change made in browser settings. An already-decided value
        // resolves instantly without prompting; only "default" shows UI.
        const result = await Notification.requestPermission();
        setPermissionOverride(result);
        if (result !== "granted") return false;
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(status.vapidPublicKey),
        });
        const response = await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: subscription.toJSON(), settings }),
        });
        if (!response.ok) {
          await subscription.unsubscribe().catch(() => {});
          return false;
        }
        await refresh();
        return true;
      } catch {
        return false;
      } finally {
        setBusy(false);
      }
    },
    [permission, status, refresh],
  );

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe().catch(() => {});
      }
      await fetch("/api/push/subscription", { method: "DELETE" }).catch(() => {});
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const saveSettings = useCallback(
    async (settings: ReminderSettings): Promise<boolean> => {
      try {
        const response = await fetch("/api/push/subscription", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings }),
        });
        if (response.ok) await refresh();
        return response.ok;
      } catch {
        return false;
      }
    },
    [refresh],
  );

  return {
    supported: !native && permission !== "unsupported",
    permission,
    subscribed: status?.subscribed ?? false,
    settings: status?.settings ?? null,
    busy,
    enable,
    disable,
    saveSettings,
    refresh,
  };
}
