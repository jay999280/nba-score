"use client";

import { Fragment, useState } from "react";

import { detailAvailability } from "@/lib/game-state";
import type { GameDetail, Leader, StatRow, TeamLeaders, TeamSide } from "@/lib/types";
import { ErrorState } from "../states";
import { TeamLogo } from "../team-logo";
import { PreGamePanel } from "./pre-game";

/**
 * The comparison the page opens with. Everything else is one tap away, so the
 * first screen stays readable instead of turning into a statistics dump
 * (PRD §14). The full 14-row table is still there — nothing was removed.
 */
const CORE_STAT_LABELS = ["投篮命中率", "三分命中率", "篮板", "助攻", "失误", "抢断"];

/**
 * Overview (PRD §14): the score and periods are already above the tabs, so this
 * is Leaders and a short, high-value team comparison.
 */
export function Overview({ game }: { game: GameDetail }) {
  const availability = detailAvailability(game);

  // Before tip-off an empty box score is the truth. Once the game is under way
  // it is a failure to load, and the two must not share a panel: telling a
  // reader a live game "has not started" is simply wrong.
  if (availability === "not-started") return <PreGamePanel game={game} />;
  if (availability === "stats-unavailable") return <StatsUnavailable game={game} />;

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

  return (
    <div className="flex flex-col gap-8">
      {hasLeaders ? <Leaders game={game} /> : null}
      {hasStats ? <TeamStats game={game} /> : null}
    </div>
  );
}

function StatsUnavailable({ game }: { game: GameDetail }) {
  return (
    <ErrorState
      message="暂时读不到比赛统计"
      hint={`比赛${game.status === "live" ? "进行中" : "已结束"}，数据源暂时没有返回统计表`}
    />
  );
}

function Leaders({ game }: { game: GameDetail }) {
  const entries: { team: TeamSide; leaders: TeamLeaders }[] = [
    { team: game.away, leaders: game.leaders.away },
    { team: game.home, leaders: game.leaders.home },
  ];

  return (
    <section className="flex flex-col gap-4">
      <h2 className="eyebrow text-ink-3">领衔球员</h2>
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
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <TeamLogo team={team} size={18} />
        <span
          className="truncate text-body leading-none font-medium text-ink"
          title={scorer?.name ?? undefined}
        >
          {scorer?.name ?? "—"}
        </span>
      </div>
      <p className="tnum text-meta leading-none text-ink-2">
        {scorer ? `${scorer.points}分` : "—"}
      </p>
      <div className="flex flex-col gap-2">
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
    <p className="flex min-w-0 items-baseline gap-2 text-meta leading-none">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{leader?.name ?? "—"}</span>
      <span className="tnum shrink-0 text-ink-2">{leader ? value(leader) : ""}</span>
    </p>
  );
}

function TeamStats({ game }: { game: GameDetail }) {
  const [expanded, setExpanded] = useState(false);

  const rank = (row: StatRow) => {
    const index = CORE_STAT_LABELS.indexOf(row.label);
    return index === -1 ? CORE_STAT_LABELS.length : index;
  };
  const core = game.stats.filter((row) => rank(row) < CORE_STAT_LABELS.length);
  const rest = game.stats.filter((row) => rank(row) >= CORE_STAT_LABELS.length);
  const hidden = rest.length > 0 && !expanded;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="eyebrow text-ink-3">球队数据</h2>
      <div className="grid grid-cols-[1fr_58px_58px] items-center gap-y-3">
        <span aria-hidden="true" />
        <span className="eyebrow text-right text-ink-3">{game.away.tricode}</span>
        <span className="eyebrow text-right text-ink-3">{game.home.tricode}</span>

        {core.map((row) => (
          <Fragment key={row.label}>
            <span className="eyebrow text-ink-3">{row.label}</span>
            <span className="tnum text-right text-body leading-none text-ink">{row.away}</span>
            <span className="tnum text-right text-body leading-none text-ink">{row.home}</span>
          </Fragment>
        ))}

        {!hidden
          ? rest.map((row) => (
              <Fragment key={row.label}>
                <span className="eyebrow text-ink-3">{row.label}</span>
                <span className="tnum text-right text-body leading-none text-ink">{row.away}</span>
                <span className="tnum text-right text-body leading-none text-ink">{row.home}</span>
              </Fragment>
            ))
          : null}
      </div>

      {rest.length > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="btn-secondary mx-auto -mt-1"
        >
          {expanded ? "收起" : `更多数据 · ${rest.length}项`}
        </button>
      ) : null}
    </section>
  );
}
