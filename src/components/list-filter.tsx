"use client";

import { HeartIcon, RefreshIcon } from "./icons";

export type ListFilter = "all" | "favorites";

interface ListFilterBarProps {
  filter: ListFilter;
  onChange: (filter: ListFilter) => void;
  /** How many games each view would show, for an honest label. */
  allCount: number;
  favoriteCount: number;
  /** True while a refresh is in flight. */
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * The one filter this list needs: everything, or only the teams you follow.
 *
 * Two mutually exclusive options, no dropdown and no second page — the spec's
 * "同一列表内的全部 / 关注两态筛选". The refresh control sits at the far end
 * because a manual refresh is an escape hatch, not a primary action.
 */
export function ListFilterBar({
  filter,
  onChange,
  allCount,
  favoriteCount,
  refreshing,
  onRefresh,
}: ListFilterBarProps) {
  const options: { id: ListFilter; label: string; count: number }[] = [
    { id: "all", label: "全部", count: allCount },
    { id: "favorites", label: "关注", count: favoriteCount },
  ];

  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <div role="tablist" aria-label="比赛筛选" className="segmented-track">
        {options.map((option) => {
          const active = option.id === filter;
          return (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(option.id)}
              className="segmented-item"
            >
              {option.id === "favorites" ? <HeartIcon size={12} filled={active} /> : null}
              {option.label}
              <span className="tnum text-meta text-ink-3">{option.count}</span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onRefresh}
        aria-label="刷新"
        aria-busy={refreshing}
        className="btn-ghost"
      >
        <RefreshIcon size={16} spinning={refreshing} />
      </button>
    </div>
  );
}
