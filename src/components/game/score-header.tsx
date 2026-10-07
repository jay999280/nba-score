"use client";

import { Fragment } from "react";

import { formatLocalTime, periodLabel } from "@/lib/format";
import type { Game, GameStatus, TeamSide } from "@/lib/types";
import { CountdownText } from "../countdown-text";
import { StarIcon } from "../icons";
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
}: {
  game: Game;
  hideScores?: boolean;
  favorites: Set<number>;
  onToggleFavorite: (teamId: number) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-6 pt-1">
        <TeamColumn
          team={game.away}
          status={game.status}
          hideScores={hideScores}
          followed={favorites.has(game.away.id)}
          onToggleFollow={() => onToggleFavorite(game.away.id)}
        />
        <TeamColumn
          team={game.home}
          status={game.status}
          hideScores={hideScores}
          followed={favorites.has(game.home.id)}
          onToggleFollow={() => onToggleFavorite(game.home.id)}
        />
      </div>
      <DetailStatusLine game={game} />
    </div>
  );
}

function TeamColumn({
  team,
  status,
  hideScores = false,
  followed,
  onToggleFollow,
}: {
  team: TeamSide;
  status: GameStatus;
  hideScores?: boolean;
  followed: boolean;
  onToggleFollow: () => void;
}) {
  const muted = status === "final" && !team.winner && !hideScores;

  return (
    <div className="flex flex-1 flex-col items-center gap-2.5">
      <TeamLogo team={team} size={44} dimmed={muted} />
      <span
        className={`text-center text-[15px] leading-none font-medium ${
          muted ? "text-ink-2" : "text-ink"
        }`}
      >
        {team.name}
      </span>
      <span
        className={`flex h-[40px] items-center text-[40px] leading-none font-semibold tracking-[-0.035em] ${
          muted ? "text-ink-2" : "text-ink"
        }`}
      >
        {!hideScores ? <Score value={team.score} /> : null}
      </span>
      {!hideScores && team.record ? (
        <span className="tnum text-[11px] leading-none text-ink-3">{team.record}</span>
      ) : null}
      <button
        type="button"
        onClick={onToggleFollow}
        aria-pressed={followed}
        aria-label={followed ? `取消关注${team.name}` : `关注${team.name}`}
        className={`mt-0.5 flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12px] leading-none font-medium transition-colors ${
          followed
            ? "border-ink bg-ink text-bg"
            : "border-line-strong text-ink-2 hover:text-ink"
        }`}
      >
        <StarIcon size={12} filled={followed} />
        {followed ? "已关注" : "关注"}
      </button>
    </div>
  );
}

function DetailStatusLine({ game }: { game: Game }) {
  if (game.status === "live") {
    return (
      <div className="flex items-center justify-center gap-2">
        <span className="animate-breathe size-1.5 rounded-full bg-live" />
        <span className="eyebrow text-live">进行中</span>
        <span className="text-[11px] leading-none text-ink-3">·</span>
        <span className="eyebrow text-ink-2">{game.statusText}</span>
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
        className="tnum text-[14px] leading-none font-medium text-ink-2"
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
      className="grid items-center gap-y-2.5"
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
          <span className="text-[13px] leading-none font-medium text-ink-2">{team.tricode}</span>
          {columns.map((period) => (
            <span key={period} className="tnum text-center text-[14px] leading-none text-ink-2">
              {scoreInPeriod(team, period)}
            </span>
          ))}
          <span
            className={`tnum text-right text-[15px] leading-none font-semibold ${
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
