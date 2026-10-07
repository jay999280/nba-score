"use client";

import { Fragment } from "react";

import type { GameDetail, Leader, TeamLeaders, TeamSide } from "@/lib/types";
import { TeamLogo } from "../team-logo";
import { PreGamePanel } from "./pre-game";

/**
 * Overview (PRD §14): the score and periods are already above the tabs, so this
 * is Leaders and a short, high-value team comparison — never a statistics dump.
 */
export function Overview({ game }: { game: GameDetail }) {
  const allLeaders = [
    game.leaders.away.points,
    game.leaders.away.rebounds,
    game.leaders.away.assists,
    game.leaders.home.points,
    game.leaders.home.rebounds,
    game.leaders.home.assists,
  ];
  const hasLeaders = allLeaders.some((leader) => leader !== null);
  const hasStats = game.stats.length > 0;

  if (game.status === "upcoming" || (!hasLeaders && !hasStats)) {
    return <PreGamePanel game={game} />;
  }

  return (
    <div className="flex flex-col gap-9">
      {hasLeaders ? <Leaders game={game} /> : null}
      {hasStats ? <TeamStats game={game} /> : null}
    </div>
  );
}

function Leaders({ game }: { game: GameDetail }) {
  const entries: { team: TeamSide; leaders: TeamLeaders }[] = [
    { team: game.away, leaders: game.leaders.away },
    { team: game.home, leaders: game.leaders.home },
  ];

  return (
    <section className="flex flex-col gap-4">
      <h3 className="eyebrow text-ink-3">领衔球员</h3>
      <div className="grid grid-cols-2 gap-5">
        {entries.map(({ team, leaders }) => (
          <LeaderColumn key={team.id} team={team} leaders={leaders} />
        ))}
      </div>
    </section>
  );
}

function LeaderColumn({ team, leaders }: { team: TeamSide; leaders: TeamLeaders }) {
  const scorer = leaders.points;
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <TeamLogo team={team} size={18} />
        <span
          className="truncate text-[14px] leading-none font-medium text-ink"
          title={scorer?.name ?? undefined}
        >
          {scorer?.name ?? "—"}
        </span>
      </div>
      <p className="tnum text-[12.5px] leading-none text-ink-2">
        {scorer ? `${scorer.points}分` : "—"}
      </p>
      <div className="flex flex-col gap-1.5">
        <LeaderLine label="篮板" leader={leaders.rebounds} value={(leader) => `${leader.rebounds}`} />
        <LeaderLine label="助攻" leader={leaders.assists} value={(leader) => `${leader.assists}`} />
      </div>
    </div>
  );
}

function LeaderLine({
  label,
  leader,
  value,
}: {
  label: string;
  leader: Leader | null;
  value: (leader: Leader) => string;
}) {
  return (
    <p className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-none">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{leader?.name ?? "—"}</span>
      <span className="tnum shrink-0 text-ink-2">{leader ? value(leader) : ""}</span>
    </p>
  );
}

function TeamStats({ game }: { game: GameDetail }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="eyebrow text-ink-3">球队数据</h3>
      <div className="grid grid-cols-[1fr_58px_58px] items-center gap-y-3.5">
        <span aria-hidden="true" />
        <span className="eyebrow text-right text-ink-3">{game.away.tricode}</span>
        <span className="eyebrow text-right text-ink-3">{game.home.tricode}</span>

        {game.stats.map((row) => (
          <Fragment key={row.label}>
            <span className="eyebrow text-ink-3">{row.label}</span>
            <span className="tnum text-right text-[14px] leading-none text-ink">{row.away}</span>
            <span className="tnum text-right text-[14px] leading-none text-ink">{row.home}</span>
          </Fragment>
        ))}
      </div>
    </section>
  );
}
