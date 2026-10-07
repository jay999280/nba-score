"use client";

import Link from "next/link";

import { CountdownText } from "./countdown-text";
import type { Game, TeamSide } from "@/lib/types";
import { Score } from "./score";
import { TeamLogo } from "./team-logo";

interface GameCardProps {
  game: Game;
  /** Accent of a favorited team in this game, or null (PRD §16). */
  favoriteColor?: string | null;
  /**
   * Spoiler mode hiding this finished game (PRD §17, v0.2). While hidden the
   * card shows only the matchup; activating it reveals the score instead of
   * navigating. Geometry stays identical so nothing shifts (PRD §32).
   */
  spoilerHidden?: boolean;
  onReveal?: () => void;
}

/**
 * The home list's unit: two vertically stacked teams, then the status.
 *
 * Zero score is never shown for a game that has not started (PRD §8.3), and
 * the whole card stays inside the 90–130px budget of PRD §10.
 */
export function GameCard({ game, favoriteColor = null, spoilerHidden = false, onReveal }: GameCardProps) {
  const settled = game.status === "final" && !spoilerHidden;

  return (
    <Link
      href={`/game/${game.id}`}
      aria-label={
        spoilerHidden
          ? `显示${game.away.name}对${game.home.name}的比分`
          : `查看${game.away.name}对${game.home.name}的比赛详情`
      }
      onClick={(event) => {
        if (spoilerHidden && onReveal) {
          event.preventDefault();
          onReveal();
        }
      }}
      onKeyDown={(event) => {
        if (spoilerHidden && onReveal && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onReveal();
        }
      }}
      className="group block overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3.5 transition-[background-color,scale] duration-200 hover:bg-elevated active:scale-[0.99]"
      style={
        favoriteColor
          ? { backgroundColor: `color-mix(in srgb, ${favoriteColor} 7%, transparent)` }
          : undefined
      }
    >

      <div className="flex flex-col gap-2">
        <TeamRow team={game.away} settled={settled} hidden={spoilerHidden} />
        <TeamRow team={game.home} settled={settled} hidden={spoilerHidden} />
      </div>

      <div className="mt-3 flex h-4 items-center">
        <StatusLine game={game} hidden={spoilerHidden} />
      </div>
    </Link>
  );
}

function TeamRow({ team, settled, hidden = false }: { team: TeamSide; settled: boolean; hidden?: boolean }) {
  const muted = settled && !team.winner;

  return (
    <div className="flex h-6 items-center gap-2.5">
      <TeamLogo team={team} dimmed={muted} />
      <span
        className={`truncate text-[15px] leading-none font-medium ${
          muted ? "text-ink-2" : "text-ink"
        }`}
      >
        {team.name}
      </span>

      {!hidden && team.record ? (
        <span className="tnum ml-auto shrink-0 text-[11px] leading-none text-ink-3">
          {team.record}
        </span>
      ) : null}

      <span
        className={`flex w-11 shrink-0 justify-end text-[19px] leading-none font-semibold tracking-[-0.02em] ${
          muted ? "text-ink-2" : "text-ink"
        }`}
      >
        {!hidden ? <Score value={team.score} /> : null}
      </span>
    </div>
  );
}

function StatusLine({ game, hidden = false }: { game: Game; hidden?: boolean }) {
  if (hidden) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="eyebrow text-ink-3">{game.statusText}</span>
        <span className="text-[11px] leading-none text-ink-3">·</span>
        <span className="eyebrow text-ink-2">点击显示比分</span>
      </span>
    );
  }

  if (game.status === "live") {
    return (
      <span className="flex items-center gap-1.5">
        <span className="animate-breathe size-1.5 rounded-full bg-live" />
        <span className="eyebrow text-live">进行中</span>
        <span className="text-[11px] leading-none text-ink-3">·</span>
        <span className="eyebrow text-ink-2">{game.statusText}</span>
      </span>
    );
  }

  if (game.status === "final") {
    return <span className="eyebrow text-ink-3">{game.statusText}</span>;
  }

  if (game.postponed) {
    return <span className="eyebrow text-ink-3">延期</span>;
  }

  return (
    <CountdownText
      startTime={game.startTime}
      className="tnum text-[13px] leading-none font-medium text-ink-2"
    />
  );
}
