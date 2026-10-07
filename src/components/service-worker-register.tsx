"use client";

import { useEffect } from "react";

/**
 * Registers the service worker in production builds only. Skipping it in
 * development keeps dev assets from ever being served stale.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is a bonus; a failed registration must never break the app.
    });
  }, []);

  return null;
}
