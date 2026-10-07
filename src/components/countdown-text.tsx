"use client";

import { formatCountdown, formatFutureTipoff, formatLocalTime } from "@/lib/format";
import { useNow } from "@/lib/client/use-now";

/**
 * Tip-off with a live countdown: `19:30 · 还有3小时`, or `明天 19:30`
 * beyond the countdown range. `bare` renders only the countdown part for
 * compositions that already show the time.
 */
export function CountdownText({
  startTime,
  className = "",
  bare = false,
}: {
  startTime: string;
  className?: string;
  bare?: boolean;
}) {
  const now = useNow();
  const time = formatLocalTime(startTime);
  if (!now) return <span className={className}>{time}</span>;
  const countdown = formatCountdown(startTime, now);
  if (countdown) {
    return <span className={className}>{bare ? countdown : `${time} · ${countdown}`}</span>;
  }
  return <span className={className}>{formatFutureTipoff(startTime, new Date(now))}</span>;
}
