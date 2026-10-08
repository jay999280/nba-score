"use client";

import { useEffect } from "react";

/**
 * Registers the service worker in production builds only. Skipping it in
 * development keeps dev assets from ever being served stale.
 *
 * `?nosw=1` skips registration: a test hatch (the mock-based suites need the
 * network layer to themselves) that doubles as a debug switch when a stale
 * worker is ever suspected in production.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    if (new URLSearchParams(window.location.search).has("nosw")) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is a bonus; a failed registration must never break the app.
    });
  }, []);

  return null;
}
