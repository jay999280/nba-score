"use client";

import { useCallback, useState } from "react";

import { AppHeader } from "@/components/app-header";
import { DateSwitcher, useDaySwipe } from "@/components/date-switcher";
import { FavoritesSheet } from "@/components/favorites-sheet";
import { GameSections } from "@/components/game-sections";
import { Shell } from "@/components/shell";
import { GameListSkeleton } from "@/components/skeletons";
import { EmptyState, ErrorState, StaleNotice } from "@/components/states";
import { useFavorites } from "@/lib/client/use-favorites";
import { useGames, useLocalToday } from "@/lib/client/use-games";
import { usePush } from "@/lib/client/use-push";
import { useSpoiler } from "@/lib/client/use-spoiler";
import { useTheme } from "@/lib/client/use-theme";
import { formatUpdatedAt, localDateKey, parseLocalDateKey } from "@/lib/format";

/**
 * The home page (PRD §5).
 *
 * Today's games load first, the date switcher steps a day at a time, and the
 * rest of the screen is the games themselves.
 */
export default function HomePage() {
  const todayKey = useLocalToday();
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [favoritesOpen, setFavoritesOpen] = useState(false);

  const dateKey = pickedDate ?? todayKey;
  const games = useGames(dateKey);
  const favorites = useFavorites();
  const push = usePush();

  // Following or unfollowing re-syncs the push subscription's team list, so
  // reminders always track the current follows.
  const handleToggleFavorite = useCallback(
    (teamId: number) => {
      const next = favorites.favoriteSet.has(teamId)
        ? favorites.favoriteIds.filter((id) => id !== teamId)
        : [...favorites.favoriteIds, teamId];
      favorites.toggle(teamId);
      if (push.subscribed && push.settings) {
        void push.saveSettings({ ...push.settings, teams: next });
      }
    },
    [favorites, push],
  );
  const spoiler = useSpoiler();
  const { theme, toggle } = useTheme();

  const shiftDay = useCallback(
    (days: number) => {
      if (!dateKey) return;
      const date = parseLocalDateKey(dateKey);
      setPickedDate(localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)));
    },
    [dateKey],
  );

  const swipe = useDaySwipe(
    useCallback(() => shiftDay(-1), [shiftDay]),
    useCallback(() => shiftDay(1), [shiftDay]),
  );

  return (
    <Shell>
      <AppHeader
        theme={theme}
        onToggleTheme={toggle}
        onOpenFavorites={() => setFavoritesOpen(true)}
        favoriteCount={favorites.count}
        spoilerOn={spoiler.enabled}
        onToggleSpoiler={spoiler.toggle}
      />

      {dateKey ? (
        <DateSwitcher dateKey={dateKey} todayKey={todayKey} onChange={setPickedDate} />
      ) : (
        <div className="h-9" aria-hidden="true" />
      )}

      <main {...swipe} className="flex flex-col gap-4">
        {renderGames()}
      </main>

      <FavoritesSheet
        open={favoritesOpen}
        onClose={() => setFavoritesOpen(false)}
        favorites={favorites.favoriteSet}
        onToggle={handleToggleFavorite}
        favoriteIds={favorites.favoriteIds}
        push={push}
      />
    </Shell>
  );

  function renderGames() {
    if (games.status === "loading") {
      return <GameListSkeleton count={4} />;
    }

    if (games.status === "error") {
      return <ErrorState onRetry={games.refresh} />;
    }

    const list = games.data?.games ?? [];

    if (list.length === 0) {
      return <EmptyState message="这一天没有比赛" />;
    }

    return (
      <div key={games.data?.date ?? ""} className="animate-rise flex flex-col gap-4">
        {games.stale ? (
          <StaleNotice
            label={`更新于 ${games.updatedAt ? formatUpdatedAt(games.updatedAt) : "—"}`}
          />
        ) : null}
        <GameSections
          games={list}
          favorites={favorites.favoriteSet}
          spoilerEnabled={spoiler.enabled}
          isRevealed={spoiler.isRevealed}
          onReveal={spoiler.reveal}
          updatedAtMs={games.updatedAt?.getTime()}
        />
      </div>
    );
  }
}
