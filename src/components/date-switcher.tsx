"use client";

import { useCallback, useRef } from "react";

import { formatCompactDate, formatWeekday, parseLocalDateKey } from "@/lib/format";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

interface DateSwitcherProps {
  dateKey: string;
  todayKey: string | null;
  onChange: (dateKey: string) => void;
  /** Clears a manual date choice so the list follows today again. */
  onToday: () => void;
}

function shiftDate(dateKey: string, days: number): string {
  const date = parseLocalDateKey(dateKey);
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function relativeLabel(dateKey: string, todayKey: string | null): string {
  if (!todayKey) return "";
  if (dateKey === todayKey) return "今天";
  if (dateKey === shiftDate(todayKey, -1)) return "昨天";
  if (dateKey === shiftDate(todayKey, 1)) return "明天";
  if (dateKey === shiftDate(todayKey, 2)) return "后天";
  return formatWeekday(parseLocalDateKey(dateKey));
}

/**
 * `‹  10月6日 · 今天  ›` (PRD §6).
 *
 * Chevrons step a day, the label opens the platform date picker, and the
 * surrounding list answers to a horizontal swipe on touch devices.
 *
 * Steppers and the date button all meet the 44px touch target; only the
 * chevron glyphs stay small.
 */
export function DateSwitcher({ dateKey, todayKey, onChange, onToday }: DateSwitcherProps) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const date = parseLocalDateKey(dateKey);
  const awayFromToday = todayKey !== null && dateKey !== todayKey;

  const openPicker = useCallback(() => {
    const input = pickerRef.current;
    if (!input) return;
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch {
        // Some browsers refuse programmatic pickers; fall through to click().
      }
    }
    input.click();
  }, []);

  return (
    <div className="relative flex items-center justify-between">
      <button
        type="button"
        aria-label="前一天"
        onClick={() => onChange(shiftDate(dateKey, -1))}
        className="btn-ghost -ml-2"
      >
        <ChevronLeftIcon size={18} />
      </button>

      <div className="relative flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={openPicker}
          aria-label="选择日期"
          className="flex min-h-11 items-center gap-2 rounded-full px-3 transition-colors hover:bg-elevated"
        >
          <span className="text-title leading-none font-semibold tracking-[-0.01em] text-ink">
            {formatCompactDate(date)}
          </span>
          <span className="text-micro leading-none text-ink-3">·</span>
          <span className="eyebrow text-ink-3">{relativeLabel(dateKey, todayKey) || "—"}</span>
        </button>

        {/* Leaving today is easy; getting back should not require counting
            chevrons or opening a calendar. */}
        {awayFromToday ? (
          <button type="button" onClick={onToday} className="btn-secondary shrink-0">
            回今天
          </button>
        ) : null}

        <input
          ref={pickerRef}
          type="date"
          value={dateKey}
          onChange={(event) => {
            if (event.target.value) onChange(event.target.value);
          }}
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-1/2 h-px w-px opacity-0"
        />
      </div>

      <button
        type="button"
        aria-label="后一天"
        onClick={() => onChange(shiftDate(dateKey, 1))}
        className="btn-ghost -mr-2"
      >
        <ChevronRightIcon size={18} />
      </button>
    </div>
  );
}

/**
 * Horizontal day swipe for the list area. Vertical scrolling always wins, so
 * the gesture never fights the page (PRD §6).
 */
export function useDaySwipe(onPrevious: () => void, onNext: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    const touch = event.touches[0];
    start.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const onTouchEnd = useCallback(
    (event: React.TouchEvent) => {
      const origin = start.current;
      start.current = null;
      if (!origin) return;

      const touch = event.changedTouches[0];
      const dx = touch.clientX - origin.x;
      const dy = touch.clientY - origin.y;

      if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      if (dx < 0) onNext();
      else onPrevious();
    },
    [onNext, onPrevious],
  );

  return { onTouchStart, onTouchEnd };
}
