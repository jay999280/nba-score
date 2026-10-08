"use client";

import { formatLocalTime, periodLabel } from "@/lib/format";
import type { Game } from "@/lib/types";
import { LiveClock } from "../live-clock";
import { TeamLogo } from "../team-logo";

interface StickyGameBarProps {
  game: Game;
  /** True once the main score header has scrolled out of view. */
  visible: boolean;
  /**
   * Spoiler mode: the bar keeps its geometry but carries no scores, so a
   * hidden result exists nowhere in the DOM — not even in an invisible node.
   */
  hideScores?: boolean;
  /** Epoch ms of the payload, so the live clock resyncs on every poll. */
  updatedAtMs?: number;
}

/**
 * Compact score bar pinned to the viewport top while the reader is deep in
 * the tabs. Same 720px column as the page so it lines up exactly.
 *
 * Rendered with `fixed`; visibility is opacity/transform only, so there is
 * no layout shift — and `prefers-reduced-motion` (see globals.css) makes the
 * swap instant.
 */
export function StickyGameBar({ game, visible, hideScores = false, updatedAtMs }: StickyGameBarProps) {
  const awayMuted = game.status === "final" && !game.away.winner;
  const homeMuted = game.status === "final" && !game.home.winner;

  return (
    <div
      aria-hidden={!visible}
      className={`fixed inset-x-0 top-0 z-40 border-b border-line bg-bg transition-[opacity,translate] duration-200 ${
        visible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-full opacity-0"
      }`}
    >
      <div className="mx-auto flex w-full max-w-[720px] items-center justify-between gap-2 px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 sm:px-5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <TeamLogo team={game.away} size={20} dimmed={awayMuted} />
          <span className="truncate text-[13px] leading-none font-medium text-ink">
            {game.away.name}
          </span>
          <span className="tnum shrink-0 text-[15px] leading-none font-semibold text-ink">
            {!hideScores ? (game.away.score ?? "") : ""}
          </span>
        </span>

        <span className="flex max-w-[120px] shrink-0 items-center gap-1.5">
          {game.status === "live" ? (
            <span className="animate-breathe size-1.5 shrink-0 rounded-full bg-live" />
          ) : null}
          <span className="eyebrow truncate text-ink-3">
            {game.status === "live" && game.clock && game.period > 0 && updatedAtMs ? (
              <span>
                {periodLabel(game.period)} · <LiveClock key={updatedAtMs} clock={game.clock} />
              </span>
            ) : (
              barStatus(game)
            )}
          </span>
        </span>

        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <span className="tnum shrink-0 text-[15px] leading-none font-semibold text-ink">
            {!hideScores ? (game.home.score ?? "") : ""}
          </span>
          <span className="truncate text-[13px] leading-none font-medium text-ink">
            {game.home.name}
          </span>
          <TeamLogo team={game.home} size={20} dimmed={homeMuted} />
        </span>
      </div>
    </div>
  );
}

function barStatus(game: Game): string {
  if (game.status === "live" || game.status === "final") return game.statusText;
  if (game.postponed) return "比赛延期";
  return formatLocalTime(game.startTime);
}
