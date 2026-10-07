"use client";

import { useSyncExternalStore } from "react";

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of subscribers) notify();
    }, 30_000);
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => now;
const getServerSnapshot = () => 0;

/**
 * A shared 30s clock for countdown labels. One interval no matter how many
 * upcoming games render; the timer stops when the last countdown unmounts.
 * Only rendered for upcoming games, so finals and live games never tick.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
