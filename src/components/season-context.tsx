import type { Game, StandingsResponse, TeamStanding } from "@/lib/types";

/** A previous season's record must not appear beside this season's game. */
export function standingForGame(game: Game, teamId: number, data: StandingsResponse | null): TeamStanding | null {
  if (!data || !/^\d{10}$/.test(game.id)) return null;
  if (game.id.slice(3, 5) !== data.season.slice(2, 4)) return null;
  return data.teams.find((team) => team.teamId === teamId) ?? null;
}

export function StandingLine({ standing, hidden = false }: { standing: TeamStanding | null; hidden?: boolean }) {
  if (hidden) return <span aria-hidden="true" className="min-h-4" />;
  // A season without a readable standings document is the normal state at the
  // very start of one (ESPN only publishes a complete ranking once the season
  // is under way). Two "常规赛 —" placeholders on every card say less than the
  // single honest line the home page already prints at the bottom, and they
  // make the list look broken. Render nothing; the line appears by itself when
  // the ranking is available.
  if (!standing) return null;
  const region = standing.conference === "East" ? "东" : "西";
  const rank = standing.rank === null ? "—" : standing.rank;
  return (
    <span
      className="tnum whitespace-nowrap text-micro leading-snug text-ink-3"
      aria-label={`常规赛${region}部${standing.rank === null ? "暂无排名" : `第${rank}名`}，${standing.wins}胜${standing.losses}负`}
      title={`常规赛${region}部${rank} · ${standing.wins}胜${standing.losses}负`}
    >
      {region}{rank} · {standing.wins}-{standing.losses}
    </span>
  );
}

export function SeriesLine({ game, hidden = false }: { game: Game; hidden?: boolean }) {
  if (hidden || game.stage !== "playoffs") return null;
  if (!game.series) return <p className="text-micro leading-relaxed text-ink-3">系列赛大比分暂无数据</p>;
  return (
    <p className="tnum text-meta leading-relaxed text-ink-2" aria-label="季后赛系列赛大比分">
      系列赛 · {game.away.name} {game.series.awayWins}-{game.series.homeWins} {game.home.name}
      {game.series.gameNumber ? ` · G${game.series.gameNumber}` : ""}
    </p>
  );
}
