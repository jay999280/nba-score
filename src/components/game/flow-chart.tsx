"use client";

import { useMemo } from "react";

import type { FlowPoint, GameStatus } from "@/lib/types";

interface FlowChartProps {
  points: FlowPoint[];
  homeName: string;
  awayName: string;
  homeColor: string;
  awayColor: string;
  status: GameStatus;
}

const W = 100;
const H = 44;
const MID = 22;
const AMP = 19;

/** "1节"…"4节", then "加1" for overtimes, matching the period table. */
function periodTickLabel(period: number): string {
  return period <= 4 ? `${period}节` : `加${period - 4}`;
}

/**
 * Score-margin flow (PRD v0.3 比赛走势): home lead above the zero line, away
 * lead below, plus the two things a chart needs before it means anything —
 * a readable margin scale and period labels (review F: it was a bare line and
 * a grid, so "how big was that lead" was unanswerable).
 *
 * The SVG carries no text: `preserveAspectRatio="none"` stretches it, which
 * would distort glyphs. Labels live in HTML around it, and the period row
 * reuses the same x fractions as the ticks.
 *
 * The margin is described as "当前分差" while the game is running and
 * "终场分差" only once it is over — a live number is not a result.
 */
export function FlowChart({ points, homeName, awayName, homeColor, awayColor, status }: FlowChartProps) {
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const maxT = Math.max(48, ...points.map((point) => point.t));
    const maxAbs = Math.max(1, ...points.map((point) => Math.abs(point.margin)));
    const x = (t: number) => (t / maxT) * W;
    const y = (margin: number) => MID - (margin / maxAbs) * AMP;
    const line = points
      .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.t).toFixed(2)},${y(point.margin).toFixed(2)}`)
      .join(" ");
    const last = points[points.length - 1];
    const area = `${line} L${x(last.t).toFixed(2)},${MID} L0,${MID} Z`;

    const ticks: { x: number; label: string }[] = [];
    for (let period = 1; period <= 8; period++) {
      // 12 minutes a quarter, 5 a period of overtime.
      const start = period <= 4 ? (period - 1) * 12 : 48 + (period - 5) * 5;
      // A label belongs in the middle of the period it names, not on the
      // boundary line to its left — otherwise "1节" sits a quarter of the way
      // across and reads as if it marked the start of Q2.
      const centre = period <= 4 ? start + 6 : start + 2.5;
      if (centre > maxT) break;
      ticks.push({ x: x(centre), label: periodTickLabel(period) });
    }

    const dividers: number[] = [];
    for (let period = 1; period <= 7; period++) {
      const boundary = period <= 4 ? period * 12 : 48 + (period - 4) * 5;
      if (boundary < maxT - 0.5) dividers.push(x(boundary));
    }

    return {
      line,
      area,
      ticks,
      dividers,
      endX: x(last.t),
      endY: y(last.margin),
      finalMargin: last.margin,
      maxAbs,
    };
  }, [points]);

  const final = status === "final";
  const marginWord = final ? "终场分差" : "当前分差";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="eyebrow text-ink-3">比分走势</h2>
        <p className="flex items-center gap-2 text-micro leading-none text-ink-3">
          <span className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ backgroundColor: homeColor }}
            />
            {homeName}
          </span>
          <span className="text-ink-3">上</span>
          <span className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ backgroundColor: awayColor }}
            />
            {awayName}
          </span>
          <span className="text-ink-3">下</span>
        </p>
      </div>

      {geometry ? (
        <>
          <div className="flex gap-2">
            {/* Margin scale: without it the reader cannot tell whether a swing
                is 3 points or 20. */}
            <div className="flex w-7 shrink-0 flex-col justify-between py-0.5 text-right text-[10px] leading-none text-ink-3">
              <span className="tnum">{`+${geometry.maxAbs}`}</span>
              <span className="tnum">0</span>
              <span className="tnum">{`-${geometry.maxAbs}`}</span>
            </div>

            <div className="min-w-0 flex-1">
              <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                className="h-[150px] w-full"
                role="img"
                aria-label={`${awayName}对${homeName}的${marginWord}走势，${marginWord}${geometry.finalMargin > 0 ? "+" : ""}${geometry.finalMargin}`}
              >
                {geometry.dividers.map((divider) => (
                  <line
                    key={divider}
                    x1={divider}
                    y1={2}
                    x2={divider}
                    y2={H - 2}
                    style={{ stroke: "var(--line-strong)" }}
                    strokeWidth={0.5}
                    strokeDasharray="1.5 1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <line
                  x1={0}
                  y1={MID}
                  x2={W}
                  y2={MID}
                  style={{ stroke: "var(--ink-3)" }}
                  strokeWidth={0.8}
                  strokeDasharray="2 1.5"
                  vectorEffect="non-scaling-stroke"
                  opacity={0.85}
                />
                <path d={geometry.area} style={{ fill: "var(--ink)" }} opacity={0.07} />
                <path
                  d={geometry.line}
                  fill="none"
                  style={{ stroke: "var(--ink)" }}
                  strokeWidth={1.6}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle cx={geometry.endX} cy={geometry.endY} r={1.8} style={{ fill: "var(--ink)" }} />
              </svg>

              <div className="relative mt-1 h-4">
                {geometry.ticks.map((tick) => (
                  <span
                    key={tick.label}
                    className="tnum absolute top-0 -translate-x-1/2 text-[10px] leading-none text-ink-3"
                    style={{ left: `${(tick.x / W) * 100}%` }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <p className="text-micro leading-none text-ink-3">
            {marginWord} {geometry.finalMargin > 0 ? "+" : ""}
            {geometry.finalMargin}
            {homeName}为正值
          </p>
        </>
      ) : (
        <p className="py-6 text-center text-body text-ink-3">暂无走势数据</p>
      )}
    </div>
  );
}
