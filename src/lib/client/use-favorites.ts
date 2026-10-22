"use client";

import { useCallback, useMemo } from "react";

import { NO_FAVORITES, parseFavoriteIds } from "./storage-validators";
import { STORAGE_KEYS } from "./storage";
import { useStoredValue } from "./local-store";

/**
 * Favorite teams, stored as team ids (PRD §16, §29).
 *
 * They reorder the home list and, with the 关注 filter, narrow it; there is no
 * second list and no extra section. The stored shape is validated at the
 * boundary (`parseFavoriteIds`), so a corrupted value degrades to "no
 * favorites" instead of crashing.
 */
export function useFavorites() {
  const [favoriteIds, setStored] = useStoredValue<number[]>(
    STORAGE_KEYS.favorites,
    NO_FAVORITES,
    parseFavoriteIds,
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
