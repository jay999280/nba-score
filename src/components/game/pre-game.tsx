"use client";

import { formatLocalTime } from "@/lib/format";
import type { GameDetail } from "@/lib/types";
import { CountdownText } from "../countdown-text";

/**
 * What the detail page shows before (or instead of) a box score.
 *
 * An upcoming game has nothing to report, so it reports exactly that — the tip
 * off in the reader's own zone, and where it is being played.
 */
export function PreGamePanel({ game }: { game: GameDetail }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-[var(--radius-card)] border border-line bg-surface px-6 py-12 text-center">
      <p className="tnum text-[15px] leading-none font-medium text-ink">
        {formatLocalTime(game.startTime)}
      </p>
      {!game.postponed ? (
        <CountdownText
          bare
          startTime={game.startTime}
          className="tnum text-[13px] leading-none text-ink-2"
        />
      ) : null}
      <p className="text-[13px] leading-none text-ink-3">
        {game.postponed ? "比赛延期" : (game.arena ?? "尚未开始")}
      </p>
    </div>
  );
}
