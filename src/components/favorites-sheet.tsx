"use client";

import { useEffect, useRef } from "react";

import { TEAM_CATALOG, teamLogoUrl } from "@/lib/nba/team-catalog";
import type { PushController } from "@/lib/client/use-push";
import { CheckIcon, CloseIcon } from "./icons";
import { ReminderSettings } from "./reminder-settings";
import { TeamLogo } from "./team-logo";

interface FavoritesSheetProps {
  open: boolean;
  onClose: () => void;
  favorites: Set<number>;
  onToggle: (teamId: number) => void;
  favoriteIds: number[];
  push: PushController;
}

/**
 * Team picker for Favorite Teams (PRD §16).
 *
 * Favorites only reorder the home list, and the sheet says so — there is no
 * second list, no "my games" section, nothing else to explain.
 */
export function FavoritesSheet({ open, onClose, favorites, onToggle, favoriteIds, push }: FavoritesSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="animate-fade absolute inset-0 cursor-default bg-black/50"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="关注球队"
        tabIndex={-1}
        className="animate-rise relative flex max-h-[86vh] w-full flex-col rounded-t-[20px] border border-line bg-surface outline-none sm:max-w-md sm:rounded-[20px]"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">
            关注球队{favorites.size > 0 ? ` · ${favorites.size}` : ""}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1.5 flex size-8 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="grid grid-cols-2 gap-1">
            {[...TEAM_CATALOG]
              .sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)))
              .map((team) => {
              const selected = favorites.has(team.id);
              return (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => onToggle(team.id)}
                  aria-pressed={selected}
                  className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
                    selected ? "bg-elevated" : "hover:bg-elevated"
                  }`}
                >
                  <TeamLogo team={{ ...team, logo: teamLogoUrl(team.id) }} size={20} />
                  <span
                    className={`truncate text-[13.5px] font-medium ${
                      selected ? "text-ink" : "text-ink-2"
                    }`}
                  >
                    {team.name}
                  </span>
                  <span className="ml-auto shrink-0 text-ink-3">
                    {selected ? <CheckIcon size={14} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <ReminderSettings favoriteIds={favoriteIds} push={push} />

        <p className="border-t border-line px-5 py-3.5 text-[12px] text-ink-3">
          关注球队的比赛会排在对应分区顶部
        </p>
      </div>
    </div>
  );
}
