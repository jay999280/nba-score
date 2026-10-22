"use client";

import type { GameDetail, GameResult, TeamForm, TeamSide } from "@/lib/types";

/**
 * Pre-game context band: recent form per side plus the season series.
 * Only past finals count, so nothing here can spoil the game below it.
 */
export function MatchupContext({ game }: { game: GameDetail }) {
  if (!game.matchup) return null;
  const { home, away, seriesHome, seriesAway, meetings } = game.matchup;

  return (
    <section aria-label="交手与近况" className="border-y border-line py-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <FormColumn team={game.away} form={away} align="left" />
        <span className="eyebrow px-1 text-center text-ink-3">
          {meetings === 0 ? "首次交手" : `交手 ${seriesAway}-${seriesHome}`}
        </span>
        <FormColumn team={game.home} form={home} align="right" />
      </div>
    </section>
  );
}

function streakText(streak: TeamForm["streak"]): string | null {
  if (!streak) return null;
  return `${streak.count}${streak.result === "W" ? "连胜" : "连败"}`;
}

function formLabel(form: TeamForm): string {
  const wins = form.last5.filter((result) => result === "W").length;
  const streak = streakText(form.streak);
  return `近${form.last5.length}场${wins}胜${form.last5.length - wins}负${streak ? `，${streak}` : ""}`;
}

function FormDot({ result }: { result: GameResult }) {
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 rounded-full ${
        result === "W" ? "bg-ink" : "border border-line-strong"
      }`}
    />
  );
}

function FormColumn({
  team,
  form,
  align,
}: {
  team: TeamSide;
  form: TeamForm;
  align: "left" | "right";
}) {
  const streak = streakText(form.streak);
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${align === "right" ? "items-end" : "items-start"}`}>
      <span className="truncate text-meta leading-none font-medium text-ink-2">
        {team.name}
      </span>
      {form.last5.length > 0 ? (
        <span className="flex items-center gap-1" role="img" aria-label={formLabel(form)}>
          {[...form.last5].reverse().map((result, index) => (
            <FormDot key={index} result={result} />
          ))}
          {streak ? (
            <span className="tnum ml-2 text-micro leading-none text-ink-3">{streak}</span>
          ) : null}
        </span>
      ) : (
        <span className="text-micro leading-none text-ink-3">暂无近况</span>
      )}
    </div>
  );
}
