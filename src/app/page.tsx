"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppHeader } from "@/components/app-header";
import { DateSwitcher, useDaySwipe } from "@/components/date-switcher";
import { FavoritesSheet } from "@/components/favorites-sheet";
import { GameSections } from "@/components/game-sections";
import { InstallPrompt } from "@/components/install-prompt";
import { ListFilterBar, type ListFilter } from "@/components/list-filter";
import { Shell } from "@/components/shell";
import { GameListSkeleton } from "@/components/skeletons";
import { EmptyState, ErrorState, FreshnessLine } from "@/components/states";
import { UpdateBanner } from "@/components/update-banner";
import { useFavorites } from "@/lib/client/use-favorites";
import { useGames, useLocalToday } from "@/lib/client/use-games";
import { rememberDetailOrigin, readingPositionFor } from "@/lib/client/list-view";
import { useListScrollRestore } from "@/lib/client/use-list-restore";
import { usePush } from "@/lib/client/use-push";
import { useSpoiler } from "@/lib/client/use-spoiler";
import { useTheme } from "@/lib/client/use-theme";
import { useStandings } from "@/lib/client/use-standings";
import { localDateKey, parseLocalDateKey } from "@/lib/format";
import { emptyListMeaning, freshnessNotice } from "@/lib/game-state";

/**
 * The home page (PRD §5).
 *
 * Today's games load first, the date switcher steps a day at a time, and the
 * rest of the screen is the games themselves.
 *
 * The chosen date and filter live in the URL rather than in component state.
 * That is what makes "open a game, come back" land on the same day with the
 * same filter: the history entry carries them, so the back button restores
 * them without any bookkeeping. `/` means today, which keeps the default path
 * clean and makes a deep link into a game return to today.
 */
export default function HomePage() {
  return (
    <Shell>
      <Suspense fallback={<HomeFallback />}>
        <HomeScreen />
      </Suspense>
    </Shell>
  );
}

/** Matches the real layout closely enough that hydration is not a jolt. */
function HomeFallback() {
  return (
    <>
      <div className="h-12" aria-hidden="true" />
      <div className="h-11" aria-hidden="true" />
      <GameListSkeleton count={4} />
    </>
  );
}

function HomeScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const todayKey = useLocalToday();

  const urlDate = searchParams.get("date");
  const filter: ListFilter = searchParams.get("fav") === "1" ? "favorites" : "all";

  const [favoritesOpen, setFavoritesOpen] = useState(false);

  const dateKey = urlDate ?? todayKey;
  const games = useGames(dateKey);
  const standings = useStandings();
  const favorites = useFavorites();
  const push = usePush();

  /** Writes the selection into the URL so history carries it. */
  const setView = useCallback(
    (nextDate: string | null, nextFilter: ListFilter) => {
      const params = new URLSearchParams();
      if (nextDate) params.set("date", nextDate);
      if (nextFilter === "favorites") params.set("fav", "1");
      const query = params.toString();
      router.replace(query ? `/?${query}` : "/", { scroll: false });
    },
    [router],
  );

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
      const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
      setView(localDateKey(shifted), filter);
    },
    [dateKey, filter, setView],
  );

  /** Back to today means "no date in the URL", the default state. */
  const goToday = useCallback(() => setView(null, filter), [filter, setView]);

  const changeFilter = useCallback(
    (next: ListFilter) => setView(dateKey === todayKey ? null : urlDate, next),
    [dateKey, todayKey, urlDate, setView],
  );

  const swipe = useDaySwipe(
    useCallback(() => shiftDay(-1), [shiftDay]),
    useCallback(() => shiftDay(1), [shiftDay]),
  );

  // Track the reading position continuously. Nothing is persisted here: the
  // offset only becomes meaningful when a card is opened, and the receipt
  // written at that moment is what carries it. A `scroll`-time copy in storage
  // is exactly what this round removed — it had no owner and no expiry, so a
  // plain re-entry of the same URL could replay it.
  const lastScroll = useRef(0);
  useEffect(() => {
    let frame = 0;
    const save = () => {
      frame = 0;
      lastScroll.current = window.scrollY;
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(save);
    };
    lastScroll.current = window.scrollY;
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [dateKey, filter]);

  /**
   * Opening a game hands the detail page everything it needs to send the
   * reader back here: the date, the filter and the exact offset — and the game
   * id, so the receipt can only authorize the visit it was written for.
   *
   * The offset comes from `readingPositionFor`, which prefers the tracked
   * position when the view jumped by most of a screen at the moment of the
   * tap — a card that was partly off screen being scrolled into view — rather
   * than treating that jump as where the reader was reading.
   */
  const onOpenGame = useCallback(
    (gameId: string) => {
      rememberDetailOrigin(
        {
          date: dateKey ?? null,
          filter,
          scroll: readingPositionFor(window.scrollY, lastScroll.current),
        },
        gameId,
      );
    },
    [dateKey, filter],
  );

  const allGames = useMemo(() => games.data?.games ?? [], [games.data]);

  // Coming back from a game restores the reading position even when the list
  // paints as a skeleton first; the signature re-runs the attempt once the
  // real payload is on screen and the document is tall enough to hold it.
  useListScrollRestore({
    date: dateKey ?? null,
    filter,
    signature: `${dateKey ?? ""}:${allGames.length}:${games.status}`,
  });

  const favoriteGames = useMemo(
    () =>
      allGames.filter(
        (game) => favorites.favoriteSet.has(game.away.id) || favorites.favoriteSet.has(game.home.id),
      ),
    [allGames, favorites.favoriteSet],
  );

  const visible = filter === "favorites" ? favoriteGames : allGames;

  function renderGames() {
    if (games.status === "loading") {
      return <GameListSkeleton count={4} />;
    }

    if (games.status === "error") {
      return <ErrorState onRetry={games.refresh} />;
    }

    if (allGames.length === 0) {
      // While the schedule is still loading, an empty scoreboard is not yet
      // "we could not confirm this day": the list is being completed a moment
      // from now, so the skeleton is the honest thing to show.
      if (games.data?.freshness.schedulePending) {
        return <GameListSkeleton count={4} />;
      }

      // Only a payload that actually covers the window may report "no games".
      // When the schedule could not be read, that is ignorance, not an
      // all-clear — saying "no games today" there would be a false statement.
      const coverage = games.data?.freshness.coverage ?? "unknown";
      return emptyListMeaning(coverage) === "none" ? (
        <EmptyState
          message="这一天没有比赛"
          action={
            <button
              type="button"
              onClick={games.refresh}
              className="btn-secondary mt-1"
            >
              刷新
            </button>
          }
        />
      ) : (
        <ErrorState message="暂时无法确认这一天的比赛" onRetry={games.refresh} />
      );
    }

    if (visible.length === 0) {
      // "You follow nobody" and "nobody you follow plays today" are different
      // situations and deserve different ways out — and neither is a claim
      // about the league's schedule.
      return favorites.count === 0 ? (
        <EmptyState
          message="还没有关注球队"
          hint="关注后可以只看他们的比赛"
          action={
            <button
              type="button"
              onClick={() => setFavoritesOpen(true)}
              className="btn-primary mt-1"
            >
              选择球队
            </button>
          }
        />
      ) : (
        <EmptyState
          message="关注的球队这一天没有比赛"
          hint="可以看全部比赛，或换一天"
          action={
            <button
              type="button"
              onClick={() => changeFilter("all")}
              className="btn-secondary mt-1"
            >
              看全部比赛
            </button>
          }
        />
      );
    }

    return (
      <div key={`${games.data?.date ?? ""}:${filter}`} className="animate-rise flex flex-col gap-4">
        {/*
          Report the list's provenance, not just "the request failed". A non-empty
          list can be partial, an offline cache hit, or a kept copy from an earlier
          round — each of which is a different claim and needs different wording.
        */}
        {games.data ? (
          <FreshnessLine
            notice={freshnessNotice(
              games.data.freshness,
              visible.map((game) => ({ status: game.status, startTime: game.startTime })),
            )}
            sourceAt={games.data.freshness.sourceAt}
            cachedAt={games.data.freshness.cachedAt}
          />
        ) : null}
        <GameSections
          games={visible}
          standings={standings.data}
          favorites={favorites.favoriteSet}
          spoilerEnabled={spoiler.enabled}
          isRevealed={spoiler.isRevealed}
          onReveal={spoiler.reveal}
          onOpenGame={onOpenGame}
        />
      </div>
    );
  }

  return (
    <>
      <AppHeader
        theme={theme}
        onToggleTheme={toggle}
        onOpenFavorites={() => setFavoritesOpen(true)}
        favoriteCount={favorites.count}
        spoilerOn={spoiler.enabled}
        onToggleSpoiler={spoiler.toggle}
      />

      {dateKey ? (
        <DateSwitcher
          dateKey={dateKey}
          todayKey={todayKey}
          onChange={(next) => setView(next, filter)}
          onToday={goToday}
        />
      ) : (
        <div className="h-11" aria-hidden="true" />
      )}

      <main {...swipe} className="flex flex-col gap-4">
        <UpdateBanner />
        <InstallPrompt />

        {games.status !== "loading" ? (
          <ListFilterBar
            filter={filter}
            onChange={changeFilter}
            allCount={allGames.length}
            favoriteCount={favoriteGames.length}
            refreshing={games.refreshing}
            onRefresh={games.refresh}
          />
        ) : null}

        {renderGames()}
        <p className="text-micro leading-relaxed text-ink-3">
          {standings.data
            ? `${standings.data.season} 常规赛当前排名与战绩${standings.stale || standings.data.stale ? " · 更新失败，显示上次数据" : ""}`
            : standings.status === "error" ? "常规赛排名与战绩暂不可用" : "常规赛排名与战绩加载中"}
          {standings.data?.state === "not-started" ? " · 尚无常规赛战绩，暂无排名" : ""}
        </p>
      </main>

      <FavoritesSheet
        open={favoritesOpen}
        onClose={() => setFavoritesOpen(false)}
        favorites={favorites.favoriteSet}
        onToggle={handleToggleFavorite}
        favoriteIds={favorites.favoriteIds}
        push={push}
      />
    </>
  );
}
