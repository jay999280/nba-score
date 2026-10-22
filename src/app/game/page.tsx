"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { BoxScore } from "@/components/game/box-score";
import { MatchupContext } from "@/components/game/matchup-context";
import { Overview } from "@/components/game/overview";
import { PlaysPanel } from "@/components/game/plays";
import { PreGameView } from "@/components/game/pre-game";
import { PeriodTable, ScoreHeader } from "@/components/game/score-header";
import { StickyGameBar } from "@/components/game/sticky-bar";
import { Tabs, type DetailTab } from "@/components/game/tabs";
import { ArrowLeftIcon, EyeIcon } from "@/components/icons";
import { Shell } from "@/components/shell";
import { DetailSkeleton } from "@/components/skeletons";
import { ErrorState, FreshnessLine } from "@/components/states";
import { useGameDetail } from "@/lib/client/use-games";
import { useFavorites } from "@/lib/client/use-favorites";
import { clearDetailOrigin, detailOriginFor, markDetailEntry } from "@/lib/client/list-view";
import { usePush } from "@/lib/client/use-push";
import { useSpoiler } from "@/lib/client/use-spoiler";
import { useStandings } from "@/lib/client/use-standings";
import { gameStageFor, gameStageLabel } from "@/lib/nba/game-stage";
import { detailAvailability, freshnessNotice } from "@/lib/game-state";

/**
 * One game: score and periods, then Overview, Box Score and Plays
 * (PRD §13–15).
 *
 * The game id arrives as `?id=` rather than a path segment: the Android build
 * is a static export served from local files, where every route has to exist
 * as a real `index.html` and an unknown path cannot be resolved by a router.
 * Web keeps the identical shape so links stay valid in both targets.
 */
export default function GamePage() {
  return (
    <Suspense fallback={<Shell width="max-w-[720px]"><DetailSkeleton /></Shell>}>
      <GameDetail />
    </Suspense>
  );
}

function GameDetail() {
  const searchParams = useSearchParams();
  const gameId = searchParams.get("id") ?? "";
  const { data, status, refresh } = useGameDetail(gameId);
  const standings = useStandings();
  const [tab, setTab] = useState<DetailTab>("overview");
  const spoiler = useSpoiler();
  const favorites = useFavorites();
  const push = usePush();

  // Keep the push subscription's team list in step with follows.
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
  const headerRef = useRef<HTMLDivElement>(null);
  const [pastHeader, setPastHeader] = useState(false);
  const router = useRouter();

  /**
   * Going back must land the reader where they left the list.
   *
   * A plain `href="/"` threw away the date, the 关注 filter and the scroll
   * offset, and always. `router.back()` replays the entry the list pushed, so
   * the URL and the position come back together.
   *
   * A game opened cold — a notification, a shared link, a new tab — has no
   * entry of ours behind it, and `history.back()` there would leave the app or
   * do nothing at all, so that case goes to today's home page on purpose. The
   * receipt's document identity is a value that only lives in this JavaScript
   * realm, so a tab that inherited a copy of `sessionStorage` cannot claim the
   * visit either.
   *
   * The decision is re-made at the moment of the press rather than taken from
   * the visit's own snapshot, because "did this visit come from the list?" has
   * to be answered for **this** game: an old marker left by an earlier visit
   * must not authorize a back press into an unrelated history entry.
   */
  const goBack = useCallback(() => {
    const receipt = detailOriginFor(gameId);
    if (!receipt) {
      router.push("/");
      return;
    }
    // Spending the receipt here is what stops a second press from walking back
    // again if the first navigation did not happen to unmount this page.
    clearDetailOrigin();
    router.back();
  }, [gameId, router]);

  /**
   * Tell this history entry that a card tap pushed it.
   *
   * The session receipt is a statement about the past that a copied storage or a
   * re-entry can repeat; the entry's own state cannot be reproduced by anything
   * but the navigation that created it, which is why it is what the back control
   * trusts — and why the return still works after a reload of this page, when
   * the receipt belongs to the document that was replaced.
   */
  useEffect(() => {
    markDetailEntry(gameId);
  }, [gameId]);

  const game = data?.game ?? null;
  const hidden = game !== null && spoiler.enabled && game.status === "final" && !spoiler.isRevealed(game.id);

  /**
   * A game with no score, no statistics and no play-by-play is the pre-game
   * state. It gets its own layout: the normal three-tab structure would be
   * three empty panels — two of them identical — before tip-off.
   */
  const preGame = game !== null && detailAvailability(game) === "not-started";

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setPastHeader(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [game?.id]);

  return (
    <Shell width="max-w-[720px]">
      <header className="flex items-center justify-between">
        <button
          type="button"
          onClick={goBack}
          aria-label="返回全部比赛"
          className="btn-ghost -ml-2"
        >
          <ArrowLeftIcon size={18} />
        </button>
        <span className="eyebrow text-ink-3">
          {game ? `NBA · ${gameStageLabel(game.stage ?? gameStageFor(game.id, game.label ?? undefined), game.label ?? undefined)}` : "NBA"}
        </span>
        <span className="size-11" aria-hidden="true" />
      </header>

      {status === "loading" ? <DetailSkeleton /> : null}

      {status === "error" ? (
        <ErrorState message="无法加载该场比赛" onRetry={refresh} />
      ) : null}

      {game ? (
        <>
          {/* Outside the animate-rise wrapper on purpose: a retained animation
              transform would hijack this fixed bar's containing block. */}
          {!preGame ? (
            <StickyGameBar game={game} visible={pastHeader} hideScores={hidden} />
          ) : null}
          <div className="animate-rise flex flex-col gap-8">
            <div ref={headerRef}>
              {preGame ? (
                <PreGameView
                  game={game}
                  standings={standings.data}
                  favorites={favorites.favoriteSet}
                  onToggleFavorite={handleToggleFavorite}
                  pending={data?.freshness.schedulePending === true}
                />
              ) : (
                <ScoreHeader
                  game={game}
                  standings={standings.data}
                  hideScores={hidden}
                  favorites={favorites.favoriteSet}
                  onToggleFavorite={handleToggleFavorite}
                />
              )}
            </div>

            {preGame ? null : hidden ? (
              <div className="animate-fade state-panel px-6 py-10">
                <p className="eyebrow text-ink-3">已结束</p>
                <button
                  type="button"
                  onClick={() => spoiler.reveal(game.id)}
                  className="btn-primary"
                >
                  <EyeIcon size={16} />
                  显示比分
                </button>
                <p className="text-meta leading-relaxed text-ink-3">
                  显示后将看到比分、节次与球员数据
                </p>
              </div>
            ) : (
              <>
                {game.away.periods.length > 0 || game.home.periods.length > 0 ? (
                  <PeriodTable game={game} />
                ) : null}

                <MatchupContext game={game} />

                <div className="flex flex-col gap-8">
                  <Tabs active={tab} onChange={setTab} />
                  <div
                    role="tabpanel"
                    id={`panel-${tab}`}
                    aria-labelledby={`tab-${tab}`}
                    className="animate-fade"
                  >
                    {tab === "overview" ? (
                      <Overview game={game} />
                    ) : tab === "box" ? (
                      <BoxScore game={game} />
                    ) : (
                      <PlaysPanel game={game} />
                    )}
                  </div>
                </div>
              </>
            )}

          {/*
            Pre-game information comes from the schedule, and the absence of a
            box score before tip-off is expected rather than a failed read. So
            the provenance line only speaks up when the schedule really did not
            answer — a schedule that is merely still loading is already said by
            the pre-game panel, and warning about it would call a normal cold
            start a degraded source.
          */}
          {data &&
          (!preGame || (!data.freshness.scheduleOk && !data.freshness.schedulePending)) ? (
            <FreshnessLine
              notice={freshnessNotice(data.freshness, [
                { status: data.game.status, startTime: data.game.startTime },
              ])}
              sourceAt={data.freshness.sourceAt}
              cachedAt={data.freshness.cachedAt}
            />
          ) : null}
          </div>
        </>
      ) : null}
    </Shell>
  );
}
