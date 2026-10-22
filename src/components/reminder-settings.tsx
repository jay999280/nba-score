"use client";

import { useState } from "react";

import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from "@/lib/nba/reminders";
import type { PushController } from "@/lib/client/use-push";

interface ReminderSettingsProps {
  favoriteIds: number[];
  push: PushController;
}

const LEAD_OPTIONS = [15, 30, 60] as const;

/**
 * Reminder controls inside the favorites sheet: reminders only ever cover
 * followed teams, so they live where follows are managed. Hidden entirely
 * where Web Push cannot work.
 */
export function ReminderSettings({ favoriteIds, push }: ReminderSettingsProps) {
  const [showFollowHint, setShowFollowHint] = useState(false);

  if (!push.supported) return null;

  const subscribed = push.subscribed;
  const settings = push.settings ?? DEFAULT_REMINDER_SETTINGS;

  const handleMasterToggle = () => {
    if (subscribed) {
      void push.disable();
      return;
    }
    if (favoriteIds.length === 0) {
      setShowFollowHint(true);
      return;
    }
    setShowFollowHint(false);
    void push.enable({ ...DEFAULT_REMINDER_SETTINGS, enabled: true, teams: favoriteIds });
  };

  const patch = (patch: Partial<ReminderSettings>) => {
    if (!push.settings) return;
    void push.saveSettings({ ...push.settings, ...patch });
  };

  return (
    <section aria-label="比赛提醒" className="border-b border-line px-5 py-4">
      <button
        type="button"
        role="switch"
        aria-checked={subscribed}
        onClick={handleMasterToggle}
        disabled={push.busy}
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left disabled:opacity-50"
      >
        <span>
          <span className="block text-title font-medium text-ink">比赛提醒</span>
          <span className="mt-1 block text-meta leading-relaxed text-ink-3">
            {push.permission === "denied"
              ? "通知权限已被关闭，请在浏览器设置中允许本站通知"
              : "关注球队开赛前和完赛时推送通知"}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
            subscribed ? "bg-ink" : "bg-line-strong"
          }`}
        >
          <span
            className={`absolute top-1 size-5 rounded-full bg-control-raised shadow-[var(--shadow-soft)] transition-all ${
              subscribed ? "left-6" : "left-1"
            }`}
          />
        </span>
      </button>

      {showFollowHint && !subscribed ? (
        <p className="animate-fade mt-2 text-meta text-ink-2">先在下方关注至少一支球队</p>
      ) : null}

      {subscribed && settings ? (
        <div className="animate-fade mt-3 flex flex-col gap-3">
          <div className="flex gap-2" role="group" aria-label="提前多久提醒">
            {LEAD_OPTIONS.map((minutes) => {
              const selected = settings.leadMinutes === minutes;
              return (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => patch({ leadMinutes: minutes })}
                  aria-pressed={selected}
                  className="chip flex-1"
                >
                  开赛前{minutes}分钟
                </button>
              );
            })}
          </div>

          <div className="flex flex-col">
            {(
              [
                ["notifyStart", "开赛提醒"],
                ["notifyFinal", "完赛提醒"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="switch"
                aria-checked={settings[key]}
                aria-label={label}
                onClick={() => patch({ [key]: !settings[key] } as Partial<ReminderSettings>)}
                className="flex min-h-11 items-center justify-between py-1 text-left"
              >
                <span className="text-body text-ink-2">{label}</span>
                <span
                  aria-hidden="true"
                  className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
                    settings[key] ? "bg-ink" : "bg-line-strong"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 size-5 rounded-full bg-control-raised shadow-[var(--shadow-soft)] transition-all ${
                      settings[key] ? "left-[18px]" : "left-0.5"
                    }`}
                  />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
