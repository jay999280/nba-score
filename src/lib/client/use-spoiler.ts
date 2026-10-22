"use client";

import { useCallback, useState } from "react";

import { parseSpoiler } from "./storage-validators";
import { STORAGE_KEYS } from "./storage";
import { useStoredValue } from "./local-store";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Spoiler mode (PRD §17, v0.2).
 *
 * While enabled, finished games hide their scores, winners and player stats
 * until the reader explicitly reveals them. The mode itself is remembered in
 * localStorage under `spoilerMode` (PRD §29); per-game reveals are session
 * state — reopening the app re-hides everything, which is the safe default
 * for someone dodging spoilers.
 *
 * Live games are never hidden: they describe the present, not a result.
 */
export function useSpoiler() {
  const [enabled, setEnabled] = useStoredValue<boolean>(
    STORAGE_KEYS.spoiler,
    false,
    parseSpoiler,
  );
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(EMPTY);

  const toggle = useCallback(() => {
    setEnabled(!enabled);
  }, [enabled, setEnabled]);

  const reveal = useCallback((gameId: string) => {
    setRevealedIds((previous) => {
      if (previous.has(gameId)) return previous;
      const next = new Set(previous);
      next.add(gameId);
      return next;
    });
  }, []);

  const isRevealed = useCallback((gameId: string) => revealedIds.has(gameId), [revealedIds]);

  return { enabled, toggle, reveal, isRevealed };
}
