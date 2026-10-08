"use client";

import { useEffect, useState } from "react";

/** "6:21" → seconds remaining. */
function parseRemaining(clock: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatRemaining(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}

/**
 * A period clock that keeps ticking between polls. Remount it keyed on the
 * payload's updatedAt so every fresh response resyncs the base: worst-case
 * drift is one poll interval, and stoppages never accumulate error.
 */
export function LiveClock({ clock, className = "" }: { clock: string; className?: string }) {
  const [base] = useState(() => ({ at: Date.now(), remaining: parseRemaining(clock) }));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (base.remaining === null) return null;

  return (
    <span className={`tnum ${className}`}>
      {formatRemaining(base.remaining - Math.floor((now - base.at) / 1000))}
    </span>
  );
}
