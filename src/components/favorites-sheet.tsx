"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Team picker for Favorite Teams (PRD §16).
 *
 * Favorites only reorder and filter the home list, and the sheet says so.
 *
 * Three interaction rules the review asked for, all of which matter on a phone:
 *
 *  - **The order is frozen while the sheet is open.** Sorting by "followed
 *    first" on every tap made the list rearrange under the reader's thumb — a
 *    tap on 湖人 moved it from y≈438 to y≈196 and the next tap hit a different
 *    team. The order is captured once, when the sheet opens.
 *  - **The sheet owns the back gesture.** It pushes a history entry, so the
 *    Android back button closes the sheet instead of leaving the app.
 *  - **Focus is trapped and returned.** Opening moves focus in, Tab cycles
 *    inside, closing restores the button that opened it.
 */
/** Followed teams first, alphabetically by city within each group. */
function sortedTeamIds(followed: Set<number>): number[] {
  return [...TEAM_CATALOG]
    .sort((a, b) => Number(followed.has(b.id)) - Number(followed.has(a.id)))
    .map((team) => team.id);
}

export function FavoritesSheet({ open, onClose, favorites, onToggle, favoriteIds, push }: FavoritesSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  /**
   * The sheet's history and focus effects must run on an actual open/close,
   * never on a re-render.
   *
   * `onClose` arrives as an inline arrow from the home page, so its identity
   * changes on every render of the parent — and the parent re-renders on every
   * poll, every favorite toggle and every filter change. With `onClose` in the
   * dependency list, each of those re-ran the cleanup, which calls
   * `history.back()` while the dialog is still open, and then pushed the entry
   * again. The review captured exactly that: toggling a team produced a
   * `back → pushState` pair, and a real back press did not close the sheet.
   *
   * Reading the latest callback through a ref keeps the effect keyed on `open`
   * alone without going stale.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // The order is captured once per opening and then held, so following a team
  // cannot rearrange the list under the reader's thumb. Adjusting state during
  // render is React's documented "reset state when a prop changes" pattern and
  // keeps this out of an effect.
  const [order, setOrder] = useState<number[]>([]);
  const [orderFor, setOrderFor] = useState(false);
  if (open !== orderFor) {
    setOrderFor(open);
    setOrder(open ? sortedTeamIds(favorites) : []);
  }

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") return;

    // Keep Tab inside the dialog instead of walking the page behind it.
    const panel = panelRef.current;
    if (!panel) return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.offsetParent !== null,
    );
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      // Focus goes back where it came from, so the keyboard does not reset.
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, [open, onKeyDown]);

  /**
   * Give the sheet its own history entry: the back gesture closes it first,
   * and closing it by hand takes the entry back off the stack.
   *
   * Keyed on `open` alone. Everything else the parent can change — the poll,
   * the filter, the set of followed teams — re-renders this component, and a
   * re-render must not touch history at all.
   */
  useEffect(() => {
    if (!open) return;

    // Where the entry we are about to add sits, so the reader's own history
    // state is left exactly as Next put it: we only append to `history.state`.
    const myIndex = window.history.length;
    window.history.pushState({ ...window.history.state, __favoritesSheet: true }, "");

    // True once the browser has already popped our entry: the cleanup must not
    // pop again, or the reader would be thrown off the page entirely.
    let poppedByBrowser = false;
    const onPopState = () => {
      const state = window.history.state as { __favoritesSheet?: boolean } | null;
      if (state?.__favoritesSheet) return;
      poppedByBrowser = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
      // Closed by the reader, not by going back: drop the entry we added.
      const state = window.history.state as { __favoritesSheet?: boolean } | null;
      if (!poppedByBrowser && state?.__favoritesSheet && window.history.length >= myIndex) {
        window.history.back();
      }
    };
  }, [open]);

  if (!open) return null;

  const byId = new Map(TEAM_CATALOG.map((team) => [team.id, team]));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="关闭"
        tabIndex={-1}
        onClick={onClose}
        className="animate-fade absolute inset-0 cursor-default bg-overlay"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="关注球队"
        tabIndex={-1}
        className="animate-rise relative flex max-h-[86vh] w-full flex-col rounded-t-sheet border border-line bg-surface outline-none sm:max-w-md sm:rounded-sheet"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-title font-semibold text-ink">
            关注球队{favorites.size > 0 ? ` · ${favorites.size}` : ""}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="btn-ghost -mr-2"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          <div className="grid grid-cols-2 gap-1">
            {order.map((id) => {
              const team = byId.get(id);
              if (!team) return null;
              const selected = favorites.has(team.id);
              return (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => onToggle(team.id)}
                  aria-pressed={selected}
                  className={`flex min-h-11 items-center gap-2 rounded-inner px-3 py-2 text-left transition-colors ${
                    selected ? "bg-elevated" : "hover:bg-elevated"
                  }`}
                >
                  <TeamLogo team={{ ...team, logo: teamLogoUrl(team.id) }} size={20} />
                  <span
                    className={`truncate text-title font-medium ${
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

        <p className="border-t border-line px-5 py-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] text-meta text-ink-3">
          关注球队的比赛会排在对应分区顶部，也可以只看他们的比赛
        </p>
      </div>
    </div>
  );
}
