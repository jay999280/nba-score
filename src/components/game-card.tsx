"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import { CountdownText } from "./countdown-text";
import type { Game, TeamSide, StandingsResponse, TeamStanding } from "@/lib/types";
import { gameStageFor, gameStageLabel } from "@/lib/nba/game-stage";
import { SeriesLine, StandingLine, standingForGame } from "./season-context";
import { Score } from "./score";
import { TeamLogo } from "./team-logo";

interface GameCardProps {
  game: Game;
  standings?: StandingsResponse | null;
  /** Accent of a favorited team in this game, or null (PRD §16). */
  favoriteColor?: string | null;
  /**
   * Spoiler mode hiding this finished game (PRD §17, v0.2). While hidden the
   * card shows only the matchup; activating it reveals the score instead of
   * navigating. Geometry stays identical so nothing shifts (PRD §32).
   */
  spoilerHidden?: boolean;
  onReveal?: () => void;
  /**
   * Fired before the route changes, so the list can record the exact reading
   * position this tap is leaving. The handler reads `window.scrollY` itself:
   * a tap can beat the animation frame that would have logged the last scroll.
   *
   * It is **only** fired for a plain left click. A middle click or a
   * Ctrl/Cmd/Shift click opens the game somewhere else (a new tab, a new
   * window) and leaves this page exactly where it is; recording a return
   * receipt for a navigation that never happened is how a same-tab deep link
   * ends up inheriting a stranger's back entry.
   */
  onOpen?: () => void;
}

/**
 * The home list's unit: two vertically stacked teams, then the status.
 *
 * Zero score is never shown for a game that has not started (PRD §8.3), and
 * Stage and regular-season context remain readable beside the scores.
 *
 * The team-colour wash is a card variant (`data-tint`), not an inline
 * background: it then follows the light/dark tint tokens and still lets
 * `hover:bg-elevated` win on pointer devices.
 */
export function GameCard({ game, standings = null, favoriteColor = null, spoilerHidden = false, onReveal, onOpen }: GameCardProps) {
  const settled = game.status === "final" && !spoilerHidden;
  const stage = game.stage ?? gameStageFor(game.id, game.label ?? undefined);
  const tinted = game.status === "live" ? "live" : favoriteColor ? "favorite" : undefined;

  return (
    <Link
      href={`/game?id=${game.id}`}
      aria-label={
        spoilerHidden
          ? `显示${game.away.name}对${game.home.name}的比分`
          : `查看${game.away.name}对${game.home.name}的比赛详情`
      }
      onClick={(event) => {
        if (spoilerHidden && onReveal) {
          event.preventDefault();
          onReveal();
          return;
        }
        // `event.button` is 0 for an ordinary click; the modifier keys mean the
        // browser opens this link elsewhere and this page never navigates.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        onOpen?.();
      }}
      onKeyDown={(event) => {
        if (spoilerHidden && onReveal && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onReveal();
        }
      }}
      data-tint={tinted}
      className="card group block overflow-hidden px-4 py-3 transition-[background-color,scale] duration-200 hover:bg-elevated active:scale-[0.99]"
      style={favoriteColor ? ({ "--team": favoriteColor } as CSSProperties) : undefined}
    >

      <div className="mb-2 text-micro leading-snug font-medium text-ink-3" data-testid="game-stage">
        {gameStageLabel(stage, game.label ?? undefined)}
      </div>
      <div className="flex flex-col gap-2">
        <TeamRow team={game.away} standing={standingForGame(game, game.away.id, standings)} settled={settled} hidden={spoilerHidden} />
        <TeamRow team={game.home} standing={standingForGame(game, game.home.id, standings)} settled={settled} hidden={spoilerHidden} />
      </div>

      <div className="mt-3 flex min-h-4 items-center">
        <StatusLine game={game} hidden={spoilerHidden} />
      </div>
      <SeriesLine game={{ ...game, stage }} hidden={spoilerHidden} />
    </Link>
  );
}

function TeamRow({ team, standing, settled, hidden = false }: { team: TeamSide; standing: TeamStanding | null; settled: boolean; hidden?: boolean }) {
  const muted = settled && !team.winner;

  return (
    <div className="flex min-h-6 items-center gap-2">
      <TeamLogo team={team} dimmed={muted} />
      <span
        className={`min-w-0 flex-1 truncate text-title leading-snug font-medium ${
          muted ? "text-ink-2" : "text-ink"
        }`}
      >
        {team.name}
      </span>

      <StandingLine standing={standing} hidden={hidden} />

      <span
        className={`flex w-[3ch] shrink-0 justify-end text-score leading-none font-semibold tracking-[-0.02em] ${
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
      <span className="flex items-center gap-2">
        <span className="eyebrow text-ink-3">{game.statusText}</span>
        <span className="text-micro leading-none text-ink-3">·</span>
        <span className="eyebrow text-ink-2">点击显示比分</span>
      </span>
    );
  }

  if (game.status === "live") {
    return (
      <span className="flex items-center gap-2">
        <span className="animate-breathe size-1.5 rounded-full bg-live" />
        <span className="eyebrow text-live">进行中</span>
        <span className="text-micro leading-none text-ink-3">·</span>
        {/* The source's own clock, verbatim. Basketball stops the clock on
            every whistle and the payload carries no "running" flag, so any
            local countdown would be invented time. */}
        <span className="eyebrow tnum text-ink-2">{game.statusText}</span>
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
      className="tnum text-body leading-none font-medium text-ink-2"
    />
  );
}
