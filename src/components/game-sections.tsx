"use client";

import { useMemo } from "react";

import type { Game, GameStatus } from "@/lib/types";
import { GameCard } from "./game-card";

const SECTIONS: { status: GameStatus; title: string }[] = [
  { status: "live", title: "进行中" },
  { status: "upcoming", title: "未开始" },
  { status: "final", title: "已结束" },
];

interface GameSectionsProps {
  games: Game[];
  /** Team ids the user follows, used only for ordering and a quiet accent. */
  favorites: Set<number>;
  /** Spoiler mode: hide finished games until revealed (PRD §17, v0.2). */
  spoilerEnabled: boolean;
  isRevealed: (gameId: string) => boolean;
  onReveal: (gameId: string) => void;
}

/**
 * LIVE > UPCOMING > FINAL, with each section ordered so a followed team's game
 * comes first — that is the entire effect of favorites in v0.1 (PRD §7, §16).
 * A section with no games renders nothing at all.
 */
export function GameSections({ games, favorites, spoilerEnabled, isRevealed, onReveal }: GameSectionsProps) {
  const grouped = useMemo(() => {
    const buckets: Record<GameStatus, Game[]> = { live: [], upcoming: [], final: [] };

    for (const game of games) {
      buckets[game.status].push(game);
    }

    const rank = (game: Game) =>
      favorites.has(game.away.id) || favorites.has(game.home.id) ? 0 : 1;

    // `sort` is stable, so games keep the schedule's chronological order.
    for (const status of Object.keys(buckets) as GameStatus[]) {
      buckets[status].sort((a, b) => rank(a) - rank(b));
    }

    return buckets;
  }, [games, favorites]);

  return (
    <div className="flex flex-col gap-7">
      {SECTIONS.map((section) => {
        const list = grouped[section.status];
        if (list.length === 0) return null;

        return (
          <section key={section.status} className="flex flex-col gap-2.5">
            <h2 className="eyebrow sticky top-0 z-10 -mx-1 bg-bg px-1 py-2 text-ink-3">
              {section.title} · {list.length}场
            </h2>
            <div className="flex flex-col gap-2.5">
              {list.map((game) => (
                <GameCard
                  key={game.id}
                  game={game}
                  favoriteColor={favoriteColorFor(game, favorites)}
                  spoilerHidden={
                    spoilerEnabled && game.status === "final" && !isRevealed(game.id)
                  }
                  onReveal={() => onReveal(game.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function favoriteColorFor(game: Game, favorites: Set<number>): string | null {
  if (favorites.has(game.away.id)) return game.away.color;
  if (favorites.has(game.home.id)) return game.home.color;
  return null;
}
