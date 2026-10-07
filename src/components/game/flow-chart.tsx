"use client";

import { useMemo } from "react";

import type { FlowPoint } from "@/lib/types";

interface FlowChartProps {
  points: FlowPoint[];
  homeName: string;
  awayName: string;
}

const W = 100;
const H = 44;
const MID = 22;
const AMP = 19;

/**
 * Score-margin flow (PRD v0.3 比赛走势): home lead above the zero line, away
 * lead below. A single neutral line — no team colors, no gradients — with
 * period ticks and a legend, so it reads the same in both themes.
 *
 * The SVG carries no text (it would distort under the stretched aspect), so
 * every label lives in HTML around it.
 */
export function FlowChart({ points, homeName, awayName }: FlowChartProps) {
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
    const ticks: number[] = [];
    for (let period = 1; period <= 8; period++) {
      const t = period <= 4 ? period * 12 : 48 + (period - 4) * 5;
      if (t < maxT - 0.5) ticks.push(t);
    }
    return {
      line,
      area,
      ticks: ticks.map(x),
      endX: x(last.t),
      endY: y(last.margin),
      finalMargin: last.margin,
    };
  }, [points]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="eyebrow text-ink-3">比分走势</h3>
        <p className="truncate text-[11px] leading-none text-ink-3">
          {homeName}在上 · {awayName}在下
        </p>
      </div>
      {geometry ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-[150px] w-full"
          role="img"
          aria-label={`${awayName}对${homeName}的分差走势，终场分差${geometry.finalMargin > 0 ? "+" : ""}${geometry.finalMargin}`}
        >
          {geometry.ticks.map((tick) => (
            <line
              key={tick}
              x1={tick}
              y1={2}
              x2={tick}
              y2={H - 2}
              style={{ stroke: "var(--line-strong)" }}
              strokeWidth={0.4}
              strokeDasharray="1 1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            y1={MID}
            x2={W}
            y2={MID}
            style={{ stroke: "var(--ink-3)" }}
            strokeWidth={0.6}
            strokeDasharray="2 1.5"
            vectorEffect="non-scaling-stroke"
            opacity={0.8}
          />
          <path d={geometry.area} style={{ fill: "var(--ink)" }} opacity={0.07} />
          <path
            d={geometry.line}
            fill="none"
            style={{ stroke: "var(--ink)" }}
            strokeWidth={1.4}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle cx={geometry.endX} cy={geometry.endY} r={1.6} style={{ fill: "var(--ink)" }} />
        </svg>
      ) : (
        <p className="py-6 text-center text-[13px] text-ink-3">暂无走势数据</p>
      )}
    </div>
  );
}
