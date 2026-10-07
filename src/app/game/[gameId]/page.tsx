"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { BoxScore } from "@/components/game/box-score";
import { MatchupContext } from "@/components/game/matchup-context";
import { Overview } from "@/components/game/overview";
import { PlaysPanel } from "@/components/game/plays";
import { PeriodTable, ScoreHeader } from "@/components/game/score-header";
import { StickyGameBar } from "@/components/game/sticky-bar";
import { Tabs, type DetailTab } from "@/components/game/tabs";
import { ArrowLeftIcon, EyeIcon } from "@/components/icons";
import { Shell } from "@/components/shell";
import { DetailSkeleton } from "@/components/skeletons";
import { ErrorState, StaleNotice } from "@/components/states";
import { useGameDetail } from "@/lib/client/use-games";
import { useFavorites } from "@/lib/client/use-favorites";
import { usePush } from "@/lib/client/use-push";
import { useSpoiler } from "@/lib/client/use-spoiler";
import { formatUpdatedAt } from "@/lib/format";

/** One game: score and periods, then Overview and Box Score (PRD §13–15). */
export default function GamePage() {
  const params = useParams<{ gameId: string }>();
  const gameId = typeof params?.gameId === "string" ? params.gameId : "";
  const { data, status, stale, updatedAt, refresh } = useGameDetail(gameId);
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

  const game = data?.game ?? null;
  const hidden = game !== null && spoiler.enabled && game.status === "final" && !spoiler.isRevealed(game.id);

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
        <Link
          href="/"
          aria-label="返回全部比赛"
          className="-ml-2 flex size-11 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink"
        >
          <ArrowLeftIcon size={18} />
        </Link>
        <span className="eyebrow text-ink-3">
          {game?.label ? `NBA · ${game.label}` : "NBA"}
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
          <StickyGameBar game={game} visible={pastHeader} hideScores={hidden} />
          <div className="animate-rise flex flex-col gap-8">
            <div ref={headerRef}>
              <ScoreHeader
                game={game}
                hideScores={hidden}
                favorites={favorites.favoriteSet}
                onToggleFavorite={handleToggleFavorite}
              />
            </div>

            {hidden ? (
              <div className="animate-fade flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-6 py-10 text-center">
                <p className="eyebrow text-ink-3">已结束</p>
                <button
                  type="button"
                  onClick={() => spoiler.reveal(game.id)}
                  className="flex min-h-11 items-center gap-2 rounded-full bg-ink px-5 text-[14px] font-medium text-bg transition-opacity hover:opacity-90 active:scale-[0.99]"
                >
                  <EyeIcon size={15} />
                  显示比分
                </button>
                <p className="text-[12px] leading-relaxed text-ink-3">
                  显示后将看到比分、节次与球员数据
                </p>
              </div>
            ) : (
              <>
                {game.away.periods.length > 0 || game.home.periods.length > 0 ? (
                  <PeriodTable game={game} />
                ) : null}

                <MatchupContext game={game} />

                <div className="flex flex-col gap-7">
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

          {stale ? (
            <StaleNotice
              label={`更新于 ${updatedAt ? formatUpdatedAt(updatedAt) : "—"}`}
            />
          ) : null}
          </div>
        </>
      ) : null}
    </Shell>
  );
}
