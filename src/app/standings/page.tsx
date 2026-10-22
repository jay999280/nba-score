"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon, MoonIcon, SunIcon } from "@/components/icons";
import { Shell } from "@/components/shell";
import { ErrorState, StaleNotice } from "@/components/states";
import { TeamLogo } from "@/components/team-logo";
import { useStandings } from "@/lib/client/use-standings";
import { useFavorites } from "@/lib/client/use-favorites";
import { useTheme } from "@/lib/client/use-theme";
import { canReturnFromStandings, markStandingsEntry } from "@/lib/client/standings-navigation";
import { formatSourceAt } from "@/lib/format";
import { teamLogo } from "@/lib/nba/team-meta";
import type { TeamStanding } from "@/lib/types";

export default function StandingsPage() {
  const router = useRouter();
  const standings = useStandings();
  const { theme, toggle } = useTheme();
  const { favoriteSet } = useFavorites();
  const [conference, setConference] = useState<TeamStanding["conference"]>("East");
  const data = standings.data;
  const teams = data?.teams.filter((team) => team.conference === conference)
    .sort((a, b) => (a.rank ?? 16) - (b.rank ?? 16)) ?? [];
  const updatedAt = formatSourceAt(data?.sourceAt);
  useEffect(() => { markStandingsEntry(); }, []);

  return (
    <Shell>
      <header className="flex items-center justify-between">
        <Link href="/" onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (canReturnFromStandings()) { event.preventDefault(); router.back(); }
        }} aria-label="返回比赛列表" className="btn-ghost -ml-2">
          <ArrowLeftIcon size={18} />
        </Link>
        <h1 className="text-title font-semibold text-ink">常规赛排名</h1>
        <button onClick={toggle} aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"} className="btn-ghost">
          {theme === "dark" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
        </button>
      </header>
      <main className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-score leading-snug font-semibold text-ink">{data?.season ?? "当前赛季"}</p>
            <p className="mt-1 text-meta leading-relaxed text-ink-3">仅统计常规赛，季前赛不计入战绩</p>
          </div>
          <button onClick={standings.refresh} disabled={standings.refreshing} className="btn-secondary shrink-0 disabled:opacity-50">
            {standings.refreshing ? "更新中" : "刷新"}
          </button>
        </div>
        <div role="tablist" aria-label="分区" className="segmented-track">
          {(["East", "West"] as const).map((region) => (
            <button key={region} role="tab" id={`conference-${region}`} aria-selected={conference === region} aria-controls={`standings-${region}`} onClick={() => setConference(region)} className="segmented-item flex-1">
              {region === "East" ? "东部" : "西部"}
            </button>
          ))}
        </div>
        {standings.status === "loading" ? <p role="status" className="animate-fade py-10 text-center text-body text-ink-3">正在加载常规赛排名…</p> : null}
        {standings.status === "error" ? <ErrorState message="常规赛排名暂时无法加载" onRetry={standings.refresh} /> : null}
        {data ? (
          <>
            {data.state === "not-started" ? <p role="status" className="card animate-fade px-4 py-3 text-body leading-relaxed text-ink-2">本赛季常规赛尚未产生战绩，所有球队 0 胜 0 负，暂无排名。</p> : null}
            {standings.stale || data.stale ? <StaleNotice label="更新失败，以下为上次获取的数据。" /> : null}
            <section role="tabpanel" id={`standings-${conference}`} aria-labelledby={`conference-${conference}`} className="card overflow-x-auto">
              <table className="tnum w-full min-w-[19em] text-body leading-snug" aria-label={`${conference === "East" ? "东部" : "西部"}常规赛球队排名`}>
                <thead className="text-ink-3"><tr className="border-b border-line">
                  <th scope="col" className="px-3 py-3 text-center font-medium"><span className="col-label">排名</span></th>
                  <th scope="col" className="px-1 py-3 text-left font-medium"><span className="col-label">球队</span></th>
                  <th scope="col" className="px-2 py-3 text-right font-medium"><span className="col-label">胜</span></th>
                  <th scope="col" className="px-2 py-3 text-right font-medium"><span className="col-label">负</span></th>
                  <th scope="col" className="px-3 py-3 text-right font-medium"><span className="col-label">胜率</span></th>
                </tr></thead>
                <tbody>{teams.map((team) => (
                  <tr key={team.teamId} className={`border-b border-line last:border-b-0 ${favoriteSet.has(team.teamId) ? "bg-elevated" : ""}`}>
                    <td className="px-3 py-3 text-center text-ink-3">{team.rank ?? "—"}</td>
                    <th scope="row" className="px-1 py-3 text-left font-medium text-ink">
                      <span className="flex items-center gap-2 whitespace-nowrap"><TeamLogo team={{ id: team.teamId, name: team.name, tricode: team.tricode, logo: teamLogo(team.teamId) }} />{team.name}</span>
                    </th>
                    <td className="px-2 py-3 text-right text-ink">{team.wins}</td>
                    <td className="px-2 py-3 text-right text-ink-2">{team.losses}</td>
                    <td className="px-3 py-3 text-right text-ink-3">{team.winPct === null ? "—" : `${(team.winPct * 100).toFixed(1)}%`}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>
            <p className="text-micro leading-relaxed text-ink-3">{data.source ? `数据：${data.source}` : "常规赛排名与战绩"}{updatedAt ? ` · 数据时间 ${updatedAt}` : ""}</p>
          </>
        ) : null}
      </main>
    </Shell>
  );
}
