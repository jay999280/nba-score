"use client";

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

/** PRD §33: say what failed, offer exactly one action. */
export function ErrorState({ message = "无法加载比赛", onRetry }: ErrorStateProps) {
  return (
    <div className="animate-fade flex flex-col items-center gap-4 rounded-[var(--radius-card)] border border-line bg-surface px-6 py-12 text-center">
      <p className="text-[15px] font-medium text-ink">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-line-strong px-4 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-elevated hover:text-ink"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}

/** Shown while the previous payload is still on screen (PRD §33). */
export function StaleNotice({ label }: { label: string }) {
  return (
    <div className="animate-fade flex items-center gap-2 px-1 text-[12px] text-ink-3">
      <span className="size-1.5 rounded-full bg-live/70" />
      <span className="tnum">{label}</span>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="animate-fade flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-6 py-14 text-center">
      <p className="text-[15px] font-medium text-ink-2">{message}</p>
      <p className="text-[13px] text-ink-3">试试其他日期</p>
    </div>
  );
}
