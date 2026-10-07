"use client";

import { useMemo, useState } from "react";

import type { Shot } from "@/lib/types";

interface ChartTeam {
  id: number;
  name: string;
  tricode: string;
  color: string;
}

interface ShotChartProps {
  shots: Shot[];
  home: ChartTeam;
  away: ChartTeam;
}

type ZoneKey = "paint" | "mid" | "corner" | "arc";

const ZONES: { key: ZoneKey; label: string }[] = [
  { key: "paint", label: "油漆区" },
  { key: "mid", label: "中距离" },
  { key: "corner", label: "底角三分" },
  { key: "arc", label: "弧顶三分" },
];

/** Feet, rim at (5.25, 0). Corner threes live outside |y|=22 near the baseline. */
function beyondArc(x: number, y: number): boolean {
  if (Math.abs(y) >= 22 && x <= 14.2) return true;
  const dx = x - 5.25;
  return dx * dx + y * y >= 23.75 * 23.75;
}

function zoneOf(shot: Shot): ZoneKey {
  if (Math.abs(shot.y) <= 8 && shot.x <= 19) return "paint";
  if (beyondArc(shot.x, shot.y)) return Math.abs(shot.y) >= 21 ? "corner" : "arc";
  return "mid";
}

/**
 * Shot chart (PRD v0.3): where the shots came from, per team.
 *
 * Geometry is computed in feet so circles stay circular on any screen; the
 * SVG carries no text, so every label lives in HTML around it.
 */
export function ShotChart({ shots, home, away }: ShotChartProps) {
  const [side, setSide] = useState<"all" | "home" | "away">("all");

  const filtered = useMemo(() => {
    if (side === "all") return shots;
    const id = side === "home" ? home.id : away.id;
    return shots.filter((shot) => shot.teamId === id);
  }, [shots, side, home.id, away.id]);

  const zones = useMemo(() => {
    const table = new Map<ZoneKey, { made: number; attempts: number }>();
    for (const shot of filtered) {
      const zone = zoneOf(shot);
      const entry = table.get(zone) ?? { made: 0, attempts: 0 };
      entry.attempts += 1;
      if (shot.made) entry.made += 1;
      table.set(zone, entry);
    }
    return ZONES.map(({ key, label }) => ({ label, ...(table.get(key) ?? { made: 0, attempts: 0 }) }));
  }, [filtered]);

  const options = [
    { id: "all" as const, label: "全部" },
    { id: "home" as const, label: home.name },
    { id: "away" as const, label: away.name },
  ];

  if (shots.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="eyebrow text-ink-3">投篮分布</h3>
        <p className="text-[11px] leading-none text-ink-3">
          <span className="mr-1 inline-block size-1.5 rounded-full bg-ink align-middle" />
          命中
          <span className="ml-2 mr-1 inline-block size-1.5 rounded-full border border-ink-3 align-middle" />
          投失
        </p>
      </div>

      <svg
        viewBox="-4 -28 55 56"
        className="w-full"
        role="img"
        aria-label={`${home.name}对${away.name}的投篮分布图`}
      >
        {/* boundary + halfcourt line */}
        <path
          d="M 0 -25 H 47 V 25 H 0 V -25 Z"
          fill="none"
          style={{ stroke: "var(--line-strong)" }}
          strokeWidth={0.22}
          vectorEffect="non-scaling-stroke"
        />
        {/* paint */}
        <path
          d="M 0 -8 H 16 V 8 H 0 Z"
          fill="none"
          style={{ stroke: "var(--line-strong)" }}
          strokeWidth={0.22}
          vectorEffect="non-scaling-stroke"
        />
        {/* free-throw circle */}
        <circle
          cx={19}
          cy={0}
          r={6}
          fill="none"
          style={{ stroke: "var(--line-strong)" }}
          strokeWidth={0.22}
          vectorEffect="non-scaling-stroke"
        />
        {/* restricted arc */}
        <path
          d="M 5.25 -4 A 4 4 0 0 0 5.25 4"
          fill="none"
          style={{ stroke: "var(--line-strong)" }}
          strokeWidth={0.22}
          vectorEffect="non-scaling-stroke"
        />
        {/* rim + backboard */}
        <circle cx={5.25} cy={0} r={0.75} fill="none" style={{ stroke: "var(--ink-3)" }} strokeWidth={0.25} />
        <line x1={4} y1={-3} x2={4} y2={3} style={{ stroke: "var(--ink-3)" }} strokeWidth={0.25} />
        {/* three-point line */}
        <path
          d="M 0 -22 L 14.19 -22 A 23.75 23.75 0 1 0 14.19 22 L 0 22"
          fill="none"
          style={{ stroke: "var(--line-strong)" }}
          strokeWidth={0.22}
          vectorEffect="non-scaling-stroke"
        />
        {/* center circle */}
        <circle
          cx={47}
          cy={0}
          r={6}
          fill="none"
          style={{ stroke: "var(--line-strong)" }}
          strokeWidth={0.22}
          vectorEffect="non-scaling-stroke"
        />
        {filtered.map((shot, index) => {
          const team = shot.teamId === home.id ? home : shot.teamId === away.id ? away : null;
          const color = team ? team.color : "#8A8A8E";
          return shot.made ? (
            <circle key={index} cx={shot.x} cy={shot.y} r={0.55} style={{ fill: color }} />
          ) : (
            <circle
              key={index}
              cx={shot.x}
              cy={shot.y}
              r={0.55}
              fill="none"
              style={{ stroke: color }}
              strokeWidth={0.22}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      <div className="flex gap-2" role="group" aria-label="按球队筛选投篮">
        {options.map((option) => {
          const selected = option.id === side;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setSide(option.id)}
              aria-pressed={selected}
              className={`min-h-9 flex-1 rounded-full border text-[13px] leading-none font-medium transition-colors ${
                selected
                  ? "border-ink bg-ink text-bg"
                  : "border-line-strong text-ink-2 hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {zones.map((zone) => (
          <li key={zone.label} className="tnum text-[12px] leading-none text-ink-2">
            <span className="text-ink-3">{zone.label} </span>
            {zone.made}/{zone.attempts}
            <span className="text-ink-3">
              {" "}
              {zone.attempts > 0 ? `${((zone.made / zone.attempts) * 100).toFixed(1)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
