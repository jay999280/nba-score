"use client";

import { formatPlusMinus } from "@/lib/format";
import type { GameDetail, TeamBox, TeamSide } from "@/lib/types";
import { TeamLogo } from "../team-logo";
import { PreGamePanel } from "./pre-game";

/**
 * The eight fields the PRD promotes for phones.
 *
 * Column widths are left to the browser (auto layout) and every numeric cell is
 * `whitespace-nowrap`, so "8-11" can never break across two lines; the player
 * column simply takes what is left and truncates. "+/-" stays a symbol — it is
 * shorter than 正负 and reads the same either way.
 */
const COLUMNS = [
  { key: "min", label: "时间" },
  { key: "pts", label: "得分" },
  { key: "reb", label: "篮板" },
  { key: "ast", label: "助攻" },
  { key: "fg", label: "投篮" },
  { key: "three", label: "三分" },
  { key: "pm", label: "+/-" },
] as const;

/**
 * Box Score (PRD §15): the eight fields that matter on a phone, one team at a
 * time. Readability wins over density, so the table stays tabular and only
 * scrolls sideways when a screen is genuinely too narrow.
 */
export function BoxScore({ game }: { game: GameDetail }) {
  const teams: { team: TeamSide; box: TeamBox }[] = [
    { team: game.away, box: game.boxScore.away },
    { team: game.home, box: game.boxScore.home },
  ];

  if (teams.every((entry) => entry.box.players.length === 0)) {
    return <PreGamePanel game={game} />;
  }

  return (
    <div className="flex flex-col gap-9">
      {teams.map((entry) => (
        <TeamTable key={entry.team.id} team={entry.team} box={entry.box} />
      ))}
    </div>
  );
}

function TeamTable({ team, box }: { team: TeamSide; box: TeamBox }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <TeamLogo team={team} size={20} />
        <span className="text-[14px] leading-none font-medium text-ink">{team.fullName}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[330px] border-collapse">
          <thead>
            <tr>
              <th className="col-label pb-2.5 pr-2 text-left font-medium text-ink-3">球员</th>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className="col-label pb-2.5 pl-1.5 text-right font-medium whitespace-nowrap text-ink-3"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {box.players.map((player) => (
              <tr key={player.personId} className="border-t border-line">
                <td className="py-2.5 pr-2 text-[13px] leading-none">
                  {/* Long compound names ellipsise on a 375px screen; this cap is
                      also what keeps the eight columns from overflowing. */}
                  <span className="block max-w-[112px] truncate text-ink" title={player.name}>
                    {player.name}
                  </span>
                </td>
                <td className="tnum py-2.5 pl-1.5 text-right text-[12.5px] leading-none whitespace-nowrap text-ink-2">
                  {player.minutes}
                </td>
                <td className="tnum py-2.5 pl-1.5 text-right text-[13px] leading-none font-medium whitespace-nowrap text-ink">
                  {player.points}
                </td>
                <td className="tnum py-2.5 pl-1.5 text-right text-[12.5px] leading-none whitespace-nowrap text-ink-2">
                  {player.rebounds}
                </td>
                <td className="tnum py-2.5 pl-1.5 text-right text-[12.5px] leading-none whitespace-nowrap text-ink-2">
                  {player.assists}
                </td>
                <td className="tnum py-2.5 pl-1.5 text-right text-[12.5px] leading-none whitespace-nowrap text-ink-2">
                  {player.fg}
                </td>
                <td className="tnum py-2.5 pl-1.5 text-right text-[12.5px] leading-none whitespace-nowrap text-ink-2">
                  {player.threePt}
                </td>
                <td className="tnum py-2.5 pl-1.5 text-right text-[12.5px] leading-none whitespace-nowrap text-ink-2">
                  {formatPlusMinus(player.plusMinus)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
