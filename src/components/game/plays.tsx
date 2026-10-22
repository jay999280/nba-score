"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { GameDetail, PlayEvent } from "@/lib/types";
import { useGamePlays } from "@/lib/client/use-games";
import { formatUpdatedAt, periodLabel } from "@/lib/format";
import { EmptyState, ErrorState, StaleNotice } from "../states";
import { FlowChart } from "./flow-chart";
import { ShotChart } from "./shot-chart";

/**
 * Plays tab (PRD v0.3): score flow, then the event stream latest-first.
 *
 * Substitutions never reach the screen (often 100+ per game); periods become
 * section dividers instead. Fetched lazily — this component only mounts while
 * its tab is active, so games nobody opens never pay for hundreds of events.
 */
export function PlaysPanel({ game }: { game: GameDetail }) {
  const { data, status, stale, receivedAt, refresh } = useGamePlays(game.id, true);
  const [period, setPeriod] = useState<number | "all" | "clutch">("all");

  const events = useMemo(() => data?.events ?? [], [data]);

  // Live events arrive newest-first, so the list grows above the reader. New
  // plays are never scrolled into view automatically — that would yank the
  // page away mid-sentence. Instead the new ones are counted and offered.
  const [readCount, setReadCount] = useState<number | null>(null);
  if (readCount === null && events.length > 0) setReadCount(events.length);

  const eventCountRef = useRef(events.length);
  useEffect(() => {
    eventCountRef.current = events.length;
  });

  useEffect(() => {
    const onScroll = () => {
      // Back at the top means the reader has seen the latest.
      if (window.scrollY < 140) setReadCount(eventCountRef.current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const unseen = readCount === null ? 0 : Math.max(0, events.length - readCount);
  const filtered = useMemo(() => {
    if (period === "all") return events;
    if (period === "clutch") return events.filter((event) => event.clutch);
    return events.filter((event) => event.period === period);
  }, [events, period]);
  const groups = useMemo(() => {
    const buckets = new Map<number, PlayEvent[]>();
    for (const event of filtered) {
      const list = buckets.get(event.period) ?? [];
      list.push(event);
      buckets.set(event.period, list);
    }
    return [...buckets.entries()].sort((a, b) => b[0] - a[0]);
  }, [filtered]);

  if (status === "loading") {
    return <PlaysSkeleton />;
  }

  if (status === "error") {
    return <ErrorState message="无法加载比赛动态" onRetry={refresh} />;
  }

  if (!data || data.state !== "ready" || events.length === 0) {
    // "Upstream has not written this yet" and "we could not read it" are
    // different facts, and only one of them is about the game not starting.
    const notPublished = !data || data.state === "not-published";
    return notPublished ? (
      <EmptyState message="暂无比赛动态" hint="比赛开始后这里会有实时动态" />
    ) : (
      <ErrorState
        message="暂时读不到比赛动态"
        hint="比赛已经开始，数据源暂时没有响应"
        onRetry={refresh}
      />
    );
  }

  const hasClutch = data.events.some((event) => event.clutch);  const options: { id: number | "all" | "clutch"; label: string }[] = [
    { id: "all", label: "全部" },
    ...(hasClutch ? [{ id: "clutch" as const, label: "关键时刻" }] : []),
    ...data.periods.map((value) => ({
      id: value as number | "all" | "clutch",
      label: periodLabel(value),
    })),
  ];

  return (
    <div className="flex flex-col gap-8">
      {unseen > 0 ? (
        <button
          type="button"
          onClick={() => {
            setReadCount(events.length);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          className="animate-fade sticky top-[calc(env(safe-area-inset-top)+var(--bar-h)+var(--sticky-gap))] z-20 mx-auto flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-meta font-medium text-ink shadow-[var(--shadow-soft)] transition-colors hover:bg-elevated"
        >
          <span className="size-1.5 rounded-full bg-live" />
          {unseen} 条新动态 · 回到最新
        </button>
      ) : null}

      <FlowChart
        points={data.flow}
        homeName={game.home.name}
        awayName={game.away.name}
        homeColor={game.home.color}
        awayColor={game.away.color}
        status={data.status}
      />

      {data.shots.length > 0 ? (
        <ShotChart
          shots={data.shots}
          home={{ id: game.home.id, name: game.home.name, tricode: game.home.tricode, color: game.home.color }}
          away={{ id: game.away.id, name: game.away.name, tricode: game.away.tricode, color: game.away.color }}
        />
      ) : null}

      <div className="flex flex-col gap-4">
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="按节筛选">
          {options.map((option) => {
            const selected = option.id === period;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setPeriod(option.id)}
                aria-pressed={selected}
                className="chip shrink-0"
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {groups.length === 0 ? (
          <p className="py-6 text-center text-body text-ink-3">
            {period === "clutch" ? "本场没有关键时刻" : "这一节暂无动态"}
          </p>
        ) : (
          groups.map(([value, list]) => (
            <section key={value} className="flex flex-col gap-1">
              <h2 className="eyebrow text-ink-3">
                {periodLabel(value)}
                <span className="tnum ml-2 normal-case tabular-nums">
                  {periodScore(list)}
                </span>
              </h2>
              <ul className="divide-y divide-line">
                {list.map((event) => (
                  <PlayRow key={event.id} event={event} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {stale ? (
        <StaleNotice
          label={`更新于 ${receivedAt ? formatUpdatedAt(receivedAt) : "—"}`}
        />
      ) : null}
    </div>
  );
}

/** Latest event in a latest-first bucket carries the period-end score. */
function periodScore(list: PlayEvent[]): string {
  const last = list[0];
  if (!last || last.awayScore === null || last.homeScore === null) return "";
  return `${last.awayScore} - ${last.homeScore}`;
}

function PlayRow({ event }: { event: PlayEvent }) {
  const emphasized = event.scoring || event.clutch;
  const score =
    event.awayScore === null || event.homeScore === null
      ? ""
      : `${event.awayScore} - ${event.homeScore}`;

  return (
    <li className="grid grid-cols-[38px_8px_minmax(0,1fr)_auto] items-baseline gap-x-2 py-2">
      <span className="tnum text-meta leading-none text-ink-3">{event.clock ?? ""}</span>
      <span
        aria-hidden="true"
        className="size-1.5 self-center rounded-full"
        style={{ backgroundColor: event.clutch ? "var(--live)" : event.color }}
      />
      <span className="min-w-0">
        <span
          className={`block text-body leading-snug ${
            emphasized ? "font-medium text-ink" : "text-ink-2"
          }`}
        >
          {event.text}
        </span>
        {event.detail ? (
          <span className="tnum block text-meta leading-snug text-ink-3">
            {event.detail}
          </span>
        ) : null}
      </span>
      <span
        className={`tnum shrink-0 text-right text-meta leading-none ${
          emphasized ? "font-medium text-ink" : "text-ink-3"
        }`}
      >
        {score}
      </span>
    </li>
  );
}

function PlaysSkeleton() {
  return (
    <div className="animate-fade flex flex-col gap-6" aria-hidden="true">
      <div className="card h-[150px]" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-2 py-2">
            <span className="h-2.5 w-9 rounded-full bg-line-strong" />
            <span className="size-1.5 rounded-full bg-line-strong" />
            <span className="h-3 flex-1 rounded-full bg-line-strong" />
            <span className="h-3 w-14 rounded-full bg-line-strong" />
          </div>
        ))}
      </div>
    </div>
  );
}
