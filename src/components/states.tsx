"use client";

import type { ReactNode } from "react";

import type { FreshnessNotice } from "@/lib/game-state";
import { formatSourceAt } from "@/lib/format";

interface ErrorStateProps {
  message?: string;
  /** A second line naming what failed to read, without changing the copy rules. */
  hint?: string;
  onRetry?: () => void;
}

/** PRD §33: say what failed, offer exactly one action. */
export function ErrorState({ message = "无法加载比赛", hint, onRetry }: ErrorStateProps) {
  return (
    <div className="animate-fade state-panel">
      <p className="text-title font-medium text-ink">{message}</p>
      {hint ? <p className="text-body text-ink-3">{hint}</p> : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn-secondary mt-1">
          重试
        </button>
      ) : null}
    </div>
  );
}

/** Shown while the previous payload is still on screen (PRD §33). */
export function StaleNotice({ label }: { label: string }) {
  return (
    <div className="animate-fade flex items-center gap-2 px-1 text-meta text-ink-3">
      <span className="size-1.5 rounded-full bg-live" />
      <span className="tnum">{label}</span>
    </div>
  );
}

interface FreshnessLineProps {
  notice: FreshnessNotice;
  /** Upstream's own data time (ISO). Never the client's receive time. */
  sourceAt: string | null | undefined;
  /** Offline copy: the moment the cache was written. */
  cachedAt?: string | null;
}

/**
 * One quiet line that says where the numbers came from and how old they are.
 *
 * The two timestamps are kept apart on purpose. `sourceAt` is when upstream
 * says the data was true; the cache write time is when the offline copy was
 * taken. Showing `receivedAt` here — when *we* happened to fetch — is the
 * substitution the review rejected, so it is not an input to this component.
 *
 * A complete, this-round payload renders nothing at all: the notice is for
 * exceptions, and a banner on every screen is a banner nobody reads.
 */
export function FreshnessLine({ notice, sourceAt, cachedAt }: FreshnessLineProps) {
  if (notice.tone === "none") return null;

  const source = formatSourceAt(sourceAt);
  const cached = notice.tone === "stale" ? formatSourceAt(cachedAt) : null;
  const tone =
    notice.tone === "stale" ? "stale" : notice.tone === "unavailable" ? "strong" : undefined;

  return (
    <div role="status" data-tone={tone} className="notice animate-fade">
      <span
        aria-hidden="true"
        className={`mt-2 size-1.5 shrink-0 rounded-full ${
          notice.tone === "stale" ? "bg-live" : "bg-ink-3"
        }`}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>{notice.label}</span>
        <span className="tnum text-micro text-ink-3">
          {source ? `来源时间 ${source}` : "数据源未提供时间"}
          {cached ? ` · 缓存于 ${cached}` : ""}
          {notice.badge ? ` · ${notice.badge}` : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * An empty list always offers the reader a way out. Which way depends on why
 * it is empty: no games that day, nobody followed, or nobody followed playing
 * that day are three different situations.
 */
export function EmptyState({
  message,
  hint,
  action,
}: {
  message: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="animate-fade state-panel">
      <p className="text-title font-medium text-ink-2">{message}</p>
      {hint ? <p className="text-body text-ink-3">{hint}</p> : null}
      {action}
    </div>
  );
}
