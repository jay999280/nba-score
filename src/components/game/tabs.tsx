"use client";

import { useRef } from "react";

export type DetailTab = "overview" | "box" | "plays";

const TABS: { id: DetailTab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "box", label: "数据统计" },
  { id: "plays", label: "动态" },
];

interface TabsProps {
  active: DetailTab;
  onChange: (tab: DetailTab) => void;
}

/**
 * Three tabs and no more (PRD §4.4 + v0.3). The indicator is a 2px rule that
 * slides with the selection; arrow keys move between tabs like a real tablist.
 */
export function Tabs({ active, onChange }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = (direction: 1 | -1) => {
    const index = TABS.findIndex((tab) => tab.id === active);
    const next = TABS[(index + direction + TABS.length) % TABS.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div role="tablist" aria-label="比赛详情" className="flex gap-6 border-b border-line">
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[tab.id] = node;
            }}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                move(-1);
              }
            }}
            className={`-mb-px flex min-h-11 items-center border-b-2 px-0.5 pt-2 pb-3 text-[14px] leading-none font-medium transition-colors duration-200 ${
              selected
                ? "border-ink text-ink"
                : "border-transparent text-ink-3 hover:text-ink-2"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
