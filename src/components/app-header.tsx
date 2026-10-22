"use client";

import Link from "next/link";
import { rememberStandingsEntry } from "@/lib/client/standings-navigation";

import { EyeIcon, EyeOffIcon, MoonIcon, StarIcon, SunIcon } from "./icons";

interface AppHeaderProps {
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onOpenFavorites: () => void;
  favoriteCount: number;
  spoilerOn: boolean;
  onToggleSpoiler: () => void;
}

/**
 * The whole top bar: a wordmark and two quiet controls (PRD §5).
 *
 * Games and regular-season standings share a small, explicit navigation.
 * Glyphs stay 16px; the hit areas meet the 44px touch target.
 */
export function AppHeader({
  theme,
  onToggleTheme,
  onOpenFavorites,
  favoriteCount,
  spoilerOn,
  onToggleSpoiler,
}: AppHeaderProps) {
  return (
    <header className="flex items-center justify-between">
      <Link href="/" className="text-title leading-none font-semibold tracking-[-0.02em] text-ink">
        NBA
      </Link>

      <div className="flex items-center gap-0.5">
        <Link
          href="/standings"
          onClick={(event) => {
            if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) rememberStandingsEntry();
          }}
          className="flex min-h-11 items-center rounded-full px-3 text-body font-medium text-ink-2 transition-colors hover:text-ink"
        >
          排名
        </Link>
        <button
          type="button"
          onClick={onOpenFavorites}
          aria-label="关注球队"
          title="关注球队"
          className={`btn-ghost ${favoriteCount > 0 ? "text-ink" : ""}`}
        >
          <StarIcon size={16} filled={favoriteCount > 0} />
        </button>

        <button
          type="button"
          onClick={onToggleSpoiler}
          aria-label={spoilerOn ? "关闭隐藏比分" : "隐藏已结束比赛的比分"}
          aria-pressed={spoilerOn}
          title="隐藏比分"
          className={`btn-ghost ${spoilerOn ? "text-ink" : ""}`}
        >
          {spoilerOn ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
          title={theme === "dark" ? "浅色模式" : "深色模式"}
          className="btn-ghost"
        >
          {theme === "dark" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
        </button>
      </div>
    </header>
  );
}
