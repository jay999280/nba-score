"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * localStorage as a React external store.
 *
 * Reading persisted preferences in an effect and calling `setState` would cause
 * a cascading render on every mount; `useSyncExternalStore` lets the server
 * render the default and the client swap in the stored value during hydration
 * without a mismatch and without a second render pass.
 */

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

function subscribeTo(key: string, listener: Listener): () => void {
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full quota: the app simply forgets the preference.
  }
  emit(key);
}

function parseRaw<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * `fallback` must be referentially stable (a module-level constant), because it
 * takes part in the memoization of the parsed value.
 */
export function useStoredValue<T>(key: string, fallback: T): [T, (next: T) => void] {
  const subscribe = useCallback((listener: Listener) => subscribeTo(key, listener), [key]);
  const getSnapshot = useCallback(() => readRaw(key), [key]);

  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const value = useMemo(() => parseRaw(raw, fallback), [raw, fallback]);

  const setValue = useCallback(
    (next: T) => {
      writeRaw(key, next);
    },
    [key],
  );

  return [value, setValue];
}
