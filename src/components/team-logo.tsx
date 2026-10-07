"use client";

import { useState } from "react";

import type { TeamSide } from "@/lib/types";

interface TeamLogoProps {
  team: Pick<TeamSide, "id" | "tricode" | "logo" | "name">;
  size?: number;
  /** Finished games step back visually (PRD §12). */
  dimmed?: boolean;
  className?: string;
}

/**
 * Team crest from the NBA CDN, with the tricode as the fallback so a blocked
 * or offline logo never leaves a hole in the layout.
 */
export function TeamLogo({ team, size = 22, dimmed = false, className = "" }: TeamLogoProps) {
  const [failed, setFailed] = useState(false);

  const style = { width: size, height: size };

  if (failed) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center rounded-full bg-elevated text-[9px] font-semibold tracking-wide text-ink-3 ${className}`}
        style={style}
        aria-hidden="true"
      >
        {team.tricode}
      </span>
    );
  }

  return (
    <img
      src={team.logo}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`shrink-0 object-contain transition-opacity duration-300 ${
        dimmed ? "opacity-55" : "opacity-95"
      } ${className}`}
      style={style}
    />
  );
}
