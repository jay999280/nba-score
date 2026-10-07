"use client";

import { useCallback, useEffect } from "react";

import { STORAGE_KEYS } from "./storage";
import { useStoredValue } from "./local-store";

export type Theme = "dark" | "light";

/** Stable fallback: `useStoredValue` memoizes on it. */
const DEFAULT_THEME: Theme = "light";

/**
 * White is the default surface; dark stays available and is remembered in
 * localStorage under `theme` (PRD §19, §29).
 *
 * The `data-theme` attribute is also set by an inline script in the document
 * head, before first paint — this effect keeps it in sync afterwards.
 */
export function useTheme() {
  const [stored, setStored] = useStoredValue<Theme>(STORAGE_KEYS.theme, DEFAULT_THEME);
  const theme: Theme = stored === "light" ? "light" : "dark";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", theme === "dark" ? "#0a0a0a" : "#ffffff");
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setStored(theme === "dark" ? "light" : "dark");
  }, [theme, setStored]);

  return { theme, toggle };
}
