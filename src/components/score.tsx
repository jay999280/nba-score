"use client";

import { useCallback, useSyncExternalStore } from "react";

interface ScoreProps {
  value: number | null;
  className?: string;
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function useReducedMotion(): boolean {
  // External store, not an effect read: the server renders the animated form
  // and the client settles to static without a mismatch or a cascade.
  const subscribe = useCallback((listener: () => void) => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  const getSnapshot = useCallback(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * A score whose digits roll into place when the value changes (v0.2).
 *
 * First paint stays perfectly still — a screen full of games never animates
 * at once — and readers who prefer reduced motion always get the static
 * number. Widths stay put via tabular numerals, so neighboring content never
 * shifts when a basket drops.
 */
export function Score({ value, className = "" }: ScoreProps) {
  const reducedMotion = useReducedMotion();

  if (value === null) return null;

  const text = String(value);
  if (reducedMotion || !/^\d+$/.test(text)) {
    return <span className={`tnum ${className}`}>{text}</span>;
  }

  return (
    <span className={`tnum inline-flex overflow-hidden ${className}`} aria-label={text}>
      {text.split("").map((digit, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="flex h-[1em] shrink-0 flex-col transition-transform duration-300 ease-out"
          style={{ transform: `translateY(-${Number(digit)}em)` }}
        >
          {DIGITS.map((d) => (
            <span key={d} className="flex h-[1em] shrink-0 items-center justify-center leading-none">
              {d}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
