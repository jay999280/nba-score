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

function parseRaw<T>(raw: string | null, fallback: T, parse?: (value: unknown) => T): T {
  if (raw === null) return fallback;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fallback;
  }

  if (!parse) return value as T;
  try {
    return parse(value);
  } catch {
    return fallback;
  }
}

/**
 * `fallback` must be referentially stable (a module-level constant), because it
 * takes part in the memoization of the parsed value.
 *
 * `parse` is the boundary where stored bytes stop being trusted. JSON.parse
 * only proves the value was JSON — not that it is the shape this app wrote, and
 * a stored `{"bad":true}` used to crash the whole page (`stored.filter is not a
 * function`). A validator turns that into a safe default. Damaged keys are
 * ignored rather than deleted, so a bad `favoriteTeams` never takes the theme
 * or the spoiler setting down with it.
 */
export function useStoredValue<T>(
  key: string,
  fallback: T,
  parse?: (value: unknown) => T,
): [T, (next: T) => void] {
  const subscribe = useCallback((listener: Listener) => subscribeTo(key, listener), [key]);
  const getSnapshot = useCallback(() => readRaw(key), [key]);

  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const value = useMemo(() => parseRaw(raw, fallback, parse), [raw, fallback, parse]);

  const setValue = useCallback(
    (next: T) => {
      writeRaw(key, next);
    },
    [key],
  );

  return [value, setValue];
}
