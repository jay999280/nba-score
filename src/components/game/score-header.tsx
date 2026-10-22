"use client";

import { Fragment } from "react";
import type { CSSProperties } from "react";

import { periodLabel } from "@/lib/format";
import type { Game, GameStatus, TeamSide, StandingsResponse, TeamStanding } from "@/lib/types";
import { SeriesLine, StandingLine, standingForGame } from "../season-context";
import { CountdownText } from "../countdown-text";
import { FollowButton } from "../follow-button";
import { Score } from "../score";
import { TeamLogo } from "../team-logo";

/**
 * The first screen of the detail page answers one question: what did this game
 * turn into (PRD §13).
 */
export function ScoreHeader({
  game,
  hideScores = false,
  favorites,
  onToggleFavorite,
  standings = null,
}: {
  game: Game;
  standings?: StandingsResponse | null;
  hideScores?: boolean;
  favorites: Set<number>;
  onToggleFavorite: (teamId: number) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="relative">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div
            className="absolute top-[-32px] left-[10%] size-36 rounded-full blur-3xl"
            style={
              {
                "--team": game.away.color,
                backgroundColor: "color-mix(in srgb, var(--team) var(--team-glow), transparent)",
              } as CSSProperties
            }
          />
          <div
            className="absolute top-[-32px] right-[10%] size-36 rounded-full blur-3xl"
            style={
              {
                "--team": game.home.color,
                backgroundColor: "color-mix(in srgb, var(--team) var(--team-glow), transparent)",
              } as CSSProperties
            }
          />
        </div>
        <div className="relative flex items-start justify-between gap-6 pt-1">
          <TeamColumn
            team={game.away}
            standing={standingForGame(game, game.away.id, standings)}
            status={game.status}
            hideScores={hideScores}
            followed={favorites.has(game.away.id)}
            onToggleFollow={() => onToggleFavorite(game.away.id)}
          />
          <TeamColumn
            team={game.home}
            standing={standingForGame(game, game.home.id, standings)}
            status={game.status}
            hideScores={hideScores}
            followed={favorites.has(game.home.id)}
            onToggleFollow={() => onToggleFavorite(game.home.id)}
          />
        </div>
      </div>
      <DetailStatusLine game={game} />
      <div className="text-center"><SeriesLine game={game} hidden={hideScores} /></div>
    </div>
  );
}

function TeamColumn({
  team,
  standing,
  status,
  hideScores = false,
  followed,
  onToggleFollow,
}: {
  team: TeamSide;
  standing: TeamStanding | null;
  status: GameStatus;
  hideScores?: boolean;
  followed: boolean;
  onToggleFollow: () => void;
}) {
  const muted = status === "final" && !team.winner && !hideScores;

  return (
    <div className="flex flex-1 flex-col items-center gap-2">
      <TeamLogo team={team} size={56} dimmed={muted} />
      <span
        className={`text-center text-title leading-none font-medium ${
          muted ? "text-ink-2" : "text-ink"
        }`}
      >
        {team.name}
      </span>
      <span
        className={`flex h-12 items-center text-hero leading-none font-semibold tracking-[-0.035em] ${
          muted ? "text-ink-2" : "text-ink"
        }`}
      >
        {!hideScores ? <Score value={team.score} /> : null}
      </span>
      <StandingLine standing={standing} hidden={hideScores} />
      <FollowButton
        team={team}
        followed={followed}
        onToggle={onToggleFollow}
        className="mt-0.5"
      />
    </div>
  );
}

function DetailStatusLine({ game }: { game: Game }) {
  if (game.status === "live") {
    return (
      <div className="flex items-center justify-center gap-2">
        <span className="animate-breathe size-1.5 rounded-full bg-live" />
        <span className="eyebrow text-live">进行中</span>
        <span className="text-micro leading-none text-ink-3">·</span>
        {/* Exactly what the source said: the payload carries no trustworthy
            "clock is running" flag, so a local countdown would be invented. */}
        <span className="eyebrow tnum text-ink-2">{game.statusText}</span>
      </div>
    );
  }

  if (game.status === "final") {
    return (
      <div className="flex justify-center">
        <span className="eyebrow text-ink-3">{game.statusText}</span>
      </div>
    );
  }

  if (game.postponed) {
    return (
      <div className="flex justify-center">
        <span className="eyebrow text-ink-3">比赛延期</span>
      </div>
    );
  }

  return (
    <div className="flex justify-center">
      <CountdownText
        startTime={game.startTime}
        className="tnum text-body leading-none font-medium text-ink-2"
      />
    </div>
  );
}

/**
 * `第1节 第2节 第3节 第4节 总分` under the score, borderless and spaced (PRD §4.3).
 */
export function PeriodTable({ game }: { game: Game }) {
  const periods = Math.max(game.away.periods.length, game.home.periods.length);
  if (periods === 0) return null;

  const columns = Array.from({ length: periods }, (_, index) => index + 1);

  return (
    <div
      className="grid items-center gap-y-2"
      style={{ gridTemplateColumns: `42px repeat(${periods}, minmax(0, 1fr)) 48px` }}
    >
      <span aria-hidden="true" />
      {columns.map((period) => (
        <span key={period} className="eyebrow text-center text-ink-3">
          {periodLabel(period)}
        </span>
      ))}
      <span className="eyebrow text-right text-ink-3">总分</span>

      {[game.away, game.home].map((team) => (
        <Fragment key={team.id}>
          <span className="text-body leading-none font-medium text-ink-2">{team.tricode}</span>
          {columns.map((period) => (
            <span key={period} className="tnum text-center text-body leading-none text-ink-2">
              {scoreInPeriod(team, period)}
            </span>
          ))}
          <span
            className={`tnum text-right text-title leading-none font-semibold ${
              team.winner ? "text-ink" : "text-ink-2"
            }`}
          >
            {team.score ?? "—"}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function scoreInPeriod(team: TeamSide, period: number): string {
  const entry = team.periods.find((item) => item.period === period);
  return entry?.score === null || entry?.score === undefined ? "—" : String(entry.score);
}
