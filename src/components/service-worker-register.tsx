"use client";

import { useEffect } from "react";

/**
 * Registers the service worker in production web builds only. Skipping it in
 * development keeps dev assets from ever being served stale.
 *
 * The Android app is skipped too: it serves its own bundle out of the APK and
 * reads game data over the native HTTP bridge, so there is no deploy to be
 * offline from — and a cached API answer could only shadow the live one.
 *
 * `?nosw=1` skips registration: a test hatch (the mock-based suites need the
 * network layer to themselves) that doubles as a debug switch when a stale
 * worker is ever suspected in production.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const capacitor = (
      window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
    ).Capacitor;
    if (capacitor?.isNativePlatform?.() === true) return;
    if (new URLSearchParams(window.location.search).has("nosw")) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is a bonus; a failed registration must never break the app.
    });
  }, []);

  return null;
}
