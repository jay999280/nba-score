"use client";

import { StarIcon } from "./icons";
import type { TeamSide } from "@/lib/types";

/**
 * Follow / unfollow one team, used by the game header and the pre-game board.
 *
 * The label is the team's own name so that two of these buttons on one screen
 * are distinguishable to a screen reader; the visible text stays short.
 */
export function FollowButton({
  team,
  followed,
  onToggle,
  className = "",
}: {
  team: Pick<TeamSide, "id" | "name">;
  followed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={followed}
      aria-label={followed ? `取消关注${team.name}` : `关注${team.name}`}
      className={`chip ${className}`}
    >
      <StarIcon size={12} filled={followed} />
      {followed ? "已关注" : "关注"}
    </button>
  );
}
