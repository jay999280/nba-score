"use client";

import { useCallback, useMemo } from "react";

import { STORAGE_KEYS } from "./storage";
import { useStoredValue } from "./local-store";

/** Stable fallback: `useStoredValue` memoizes on it. */
const NO_FAVORITES: number[] = [];

/**
 * Favorite teams, stored as team ids (PRD §16, §29).
 *
 * In v0.1 they only change the order of the home list — no extra sections.
 */
export function useFavorites() {
  const [stored, setStored] = useStoredValue<number[]>(STORAGE_KEYS.favorites, NO_FAVORITES);

  const favoriteIds = useMemo(
    () => stored.filter((id): id is number => typeof id === "number"),
    [stored],
  );

  const toggle = useCallback(
    (teamId: number) => {
      const next = favoriteIds.includes(teamId)
        ? favoriteIds.filter((id) => id !== teamId)
        : [...favoriteIds, teamId];
      setStored(next);
    },
    [favoriteIds, setStored],
  );

  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  return {
    favoriteIds,
    favoriteSet,
    toggle,
    count: favoriteIds.length,
  };
}
