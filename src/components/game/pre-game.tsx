"use client";

import { Fragment, useState } from "react";
import type { CSSProperties } from "react";

import {
  formatCompactDate,
  formatCountdown,
  formatFutureTipoff,
  formatLocalTime,
  formatWeekday,
} from "@/lib/format";
import { useLineups, useTeamComparison } from "@/lib/client/use-lineups";
import type { ResourceState } from "@/lib/client/use-polled-resource";
import { useNow } from "@/lib/client/use-now";
import type {
  GameDetail,
  GameResult,
  LineupPlayer,
  LineupsResponse,
  MatchupContext,
  SeasonComparison,
  StandingsResponse,
  TeamForm,
  TeamLineup,
  TeamSide,
  TeamStanding,
} from "@/lib/types";
import { CountdownText } from "../countdown-text";
import { FollowButton } from "../follow-button";
import { standingForGame } from "../season-context";
import { TeamLogo } from "../team-logo";

/**
 * What the detail page shows for a game that has not started.
 *
 * An upcoming game has no score, no statistics and no play-by-play, so the
 * normal detail layout is three empty panels stacked on each other. This view
 * answers the questions a reader actually has before tip-off — when, where,
 * between whom, and how the two sides have been doing — from data the app
 * already has. Nothing here is invented: a field the feed does not carry (or
 * that the season has not produced yet) is named as missing rather than filled
 * with a plausible-looking placeholder.
 */
export function PreGameView({
  game,
  standings,
  favorites,
  onToggleFavorite,
  pending = false,
}: {
  game: GameDetail;
  standings: StandingsResponse | null;
  favorites: Set<number>;
  onToggleFavorite: (teamId: number) => void;
  /** The schedule is still loading, so the matchup facts may arrive shortly. */
  pending?: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      <MatchupBoard
        game={game}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
      />
      <TipoffCard game={game} />
      <PreGameContext game={game} standings={standings} pending={pending} />
      <SeasonComparisonBlock game={game} />
      <LineupsBlock game={game} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The two crests and the "VS" between them.
 * ------------------------------------------------------------------ */

function MatchupBoard({
  game,
  favorites,
  onToggleFavorite,
}: {
  game: GameDetail;
  favorites: Set<number>;
  onToggleFavorite: (teamId: number) => void;
}) {
  return (
    <div className="relative">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div
          className="absolute top-[-34px] left-[6%] size-44 rounded-full blur-3xl"
          style={
            {
              "--team": game.away.color,
              backgroundColor: "color-mix(in srgb, var(--team) var(--team-glow), transparent)",
            } as CSSProperties
          }
        />
        <div
          className="absolute top-[-34px] right-[6%] size-44 rounded-full blur-3xl"
          style={
            {
              "--team": game.home.color,
              backgroundColor: "color-mix(in srgb, var(--team) var(--team-glow), transparent)",
            } as CSSProperties
          }
        />
      </div>

      <div className="relative grid grid-cols-[1fr_auto_1fr] items-start gap-1 pt-1">
        <PregameTeamColumn
          team={game.away}
          followed={favorites.has(game.away.id)}
          onToggleFollow={() => onToggleFavorite(game.away.id)}
        />

        <div className="flex flex-col items-center gap-2 pt-9">
          <span className="text-display leading-none font-semibold tracking-[0.16em] text-ink-3">
            VS
          </span>
          <span className="text-micro leading-none tracking-wide text-ink-3">
            {game.postponed ? "延期" : "未开始"}
          </span>
        </div>

        <PregameTeamColumn
          team={game.home}
          followed={favorites.has(game.home.id)}
          onToggleFollow={() => onToggleFavorite(game.home.id)}
        />
      </div>
    </div>
  );
}

function PregameTeamColumn({
  team,
  followed,
  onToggleFollow,
}: {
  team: TeamSide;
  followed: boolean;
  onToggleFollow: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <TeamLogo team={team} size={72} />
      <span className="max-w-full truncate text-center text-title leading-none font-medium text-ink">
        {team.name}
      </span>
      <FollowButton team={team} followed={followed} onToggle={onToggleFollow} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * When and where.
 * ------------------------------------------------------------------ */

function TipoffCard({ game }: { game: GameDetail }) {
  const now = useNow();
  const started = new Date(game.startTime);
  const dateLabel = Number.isNaN(started.getTime())
    ? ""
    : `${formatCompactDate(started)} ${formatWeekday(started)}`;

  const countdown = now > 0 && !game.postponed ? formatCountdown(game.startTime, now) : null;
  const heading = game.postponed
    ? "比赛延期"
    : countdown ??
      (now > 0 ? formatFutureTipoff(game.startTime, new Date(now)) : formatLocalTime(game.startTime));

  return (
    <div className="card relative flex flex-col items-center gap-2 overflow-hidden px-6 py-9 text-center">
      {/* The two team colours, meeting in the middle: enough identity to know
          whose game this is at a glance, quiet enough to stay a scoreboard. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{
          background: `linear-gradient(90deg, ${game.away.color} 0%, ${game.away.color} 49.5%, ${game.home.color} 50.5%, ${game.home.color} 100%)`,
        }}
      />

      <p className="text-micro leading-none tracking-wide text-ink-3">
        {game.postponed ? "原定开赛时间" : "离开赛"}
      </p>
      <p className="tnum text-display leading-none font-semibold tracking-[-0.01em] text-ink">
        {heading}
      </p>
      <p className="tnum text-body leading-none text-ink-2">
        {dateLabel ? `${dateLabel} · ` : ""}
        {formatLocalTime(game.startTime)}
      </p>
      <p className="mt-0.5 text-meta leading-none text-ink-3">{venueLabel(game)}</p>
      <p className="tnum text-micro leading-none tracking-wide text-ink-3">
        {game.away.tricode} @ {game.home.tricode} · {game.label ?? "NBA"}
      </p>
    </div>
  );
}

function venueLabel(game: GameDetail): string {
  const city = game.home.city;
  return game.arena ? `${city} · ${game.arena}` : `${city} · 球馆待定`;
}

/* ------------------------------------------------------------------ *
 * How the two sides have been doing.
 * ------------------------------------------------------------------ */

function PreGameContext({
  game,
  standings,
  pending,
}: {
  game: GameDetail;
  standings: StandingsResponse | null;
  pending: boolean;
}) {
  const matchup = game.matchup;
  const awayStanding = standingForGame(game, game.away.id, standings);
  const homeStanding = standingForGame(game, game.home.id, standings);

  // This early in a season there is genuinely nothing to compare yet. Saying
  // that once is better than four separate "暂无" cells that read like the app
  // failed to load something.
  const hasContext = Boolean(
    awayStanding ||
      homeStanding ||
      (matchup &&
        (matchup.meetings > 0 ||
          matchup.away.last5.length > 0 ||
          matchup.home.last5.length > 0)),
  );

  return (
    <section aria-label="赛前数据" className="flex flex-col gap-3">
      <h2 className="eyebrow text-ink-3">赛前</h2>

      {hasContext ? (
        <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3 border-y border-line py-4">
          <TeamFactColumn
            team={game.away}
            form={matchup?.away ?? null}
            standing={awayStanding}
            align="left"
          />
          <div className="flex flex-col items-center gap-1 pt-0.5">
            <span className="eyebrow text-ink-3">交手</span>
            <span className="tnum text-meta leading-none text-ink-2">
              {matchupLabel(matchup)}
            </span>
          </div>
          <TeamFactColumn
            team={game.home}
            form={matchup?.home ?? null}
            standing={homeStanding}
            align="right"
          />
        </div>
      ) : (
        <div className="state-panel gap-2 px-6 py-6">
          <p className="text-body leading-none font-medium text-ink-2">
            {matchup ? "本赛季首次交手" : pending ? "赛前数据加载中" : "赛前数据暂不可用"}
          </p>
          <p className="text-meta leading-relaxed text-ink-3">
            {matchup
              ? "双方都还没有本赛季的已完赛记录，战绩与近况会在赛后积累"
              : pending
                ? "赛程还在加载，稍后自动补全"
                : "赛程数据没有返回，稍后会自动重试"}
          </p>
          <span className="mt-1 flex w-full flex-col items-center gap-2 border-t border-line pt-3">
            <span className="eyebrow text-ink-3">开赛后可见</span>
            <span className="text-meta leading-none text-ink-2">
              比分与节次 · 技术统计 · 比赛动态
            </span>
          </span>
        </div>
      )}
    </section>
  );
}

function TeamFactColumn({
  team,
  form,
  standing,
  align,
}: {
  team: TeamSide;
  form: TeamForm | null;
  standing: TeamStanding | null;
  align: "left" | "right";
}) {
  const right = align === "right";

  return (
    <div
      className={`flex min-w-0 flex-col gap-2 ${
        right ? "items-end text-right" : "items-start text-left"
      }`}
    >
      <span className="max-w-full truncate text-meta leading-none font-medium text-ink-2">
        {team.name}
      </span>
      <span className="text-micro leading-tight text-ink-3">{recordLabel(standing, team)}</span>
      <FormRow form={form} align={align} />
    </div>
  );
}

function FormRow({ form, align }: { form: TeamForm | null; align: "left" | "right" }) {
  if (!form) {
    return <span className="text-micro leading-none text-ink-3">近况暂不可用</span>;
  }
  if (form.last5.length === 0) {
    return <span className="text-micro leading-none text-ink-3">尚无已完赛</span>;
  }

  const streak = form.streak;
  const wins = form.last5.filter((result) => result === "W").length;
  const losses = form.last5.length - wins;

  return (
    <span
      className={`flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}
      aria-label={`近${form.last5.length}场${wins}胜${losses}负${
        streak ? `，${streak.count}${streak.result === "W" ? "连胜" : "连败"}` : ""
      }`}
    >
      {[...form.last5].reverse().map((result, index) => (
        <FormDot key={index} result={result} />
      ))}
      {streak ? (
        <span className="tnum ml-1 text-micro leading-none text-ink-3">
          {streak.count}
          {streak.result === "W" ? "连胜" : "连败"}
        </span>
      ) : null}
    </span>
  );
}

function FormDot({ result }: { result: GameResult }) {
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 rounded-full ${result === "W" ? "bg-ink" : "border border-line-strong"}`}
    />
  );
}

function recordLabel(standing: TeamStanding | null, team: TeamSide): string {
  if (standing) {
    const region = standing.conference === "East" ? "东部" : "西部";
    const rank = standing.rank === null ? "" : `第${standing.rank} · `;
    return `${region}${rank}${standing.wins}胜${standing.losses}负`;
  }
  if (team.record) return team.record.replace("-", "胜") + "负";
  return "暂无战绩";
}

function matchupLabel(matchup: MatchupContext | null): string {
  if (!matchup) return "暂不可用";
  if (matchup.meetings === 0) return "首次";
  return `${matchup.seriesAway}-${matchup.seriesHome}`;
}

/* ------------------------------------------------------------------ *
 * This season's team numbers, side by side.
 *
 * The league feeds carry no season statistics, so this block reads ESPN's
 * public aggregates through the service layer. It is the eager half of the
 * pre-game data: two documents, loaded as soon as the page mounts.
 * ------------------------------------------------------------------ */

function SeasonComparisonBlock({ game }: { game: GameDetail }) {
  const comparison = useTeamComparison(game.id);

  return (
    <section aria-label="球队本赛季数据" className="flex flex-col gap-3">
      <h2 className="eyebrow text-ink-3">本赛季数据</h2>
      <ComparisonBody game={game} state={comparison} />
    </section>
  );
}

function ComparisonBody({
  game,
  state,
}: {
  game: GameDetail;
  state: ResourceState<LineupsResponse>;
}) {
  const comparison = state.data?.comparison ?? null;

  if (!comparison) {
    return (
      <PregameNotice
        title={state.status === "error" ? "本赛季球队数据暂不可用" : "本赛季球队数据加载中"}
        body={
          state.status === "error"
            ? "数据源没有返回，稍后会自动重试"
            : "正在读取双方本赛季常规赛数据"
        }
      />
    );
  }

  if (comparison.state === "no-games") {
    return (
      <PregameNotice
        title="本赛季还没有完赛记录"
        body="双方都还没有打完本赛季的常规赛，球队数据会在比赛开始后出现"
      />
    );
  }

  if (comparison.state === "unavailable") {
    return (
      <PregameNotice
        title="本赛季球队数据暂不可用"
        body="统计接口没有返回，稍后会自动重试"
      />
    );
  }

  const pointsAllowed = comparison.rows.find((row) => row.key === "points-allowed");
  const pointsAllowedMissing =
    pointsAllowed !== undefined &&
    pointsAllowed.away === null &&
    pointsAllowed.home === null &&
    comparison.sides.away === "ready" &&
    comparison.sides.home === "ready";

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_60px_60px] items-center gap-y-3">
        <span aria-hidden="true" />
        <span className="eyebrow text-right text-ink-3">{game.away.tricode}</span>
        <span className="eyebrow text-right text-ink-3">{game.home.tricode}</span>

        {comparison.rows.map((row) => (
          <Fragment key={row.key}>
            <span className="eyebrow text-ink-3">{row.label}</span>
            <span className="tnum text-right text-body leading-none text-ink">
              {row.away ?? "—"}
            </span>
            <span className="tnum text-right text-body leading-none text-ink">
              {row.home ?? "—"}
            </span>
          </Fragment>
        ))}
      </div>

      {comparisonMissingNote(game, comparison) ? (
        <p className="text-micro leading-relaxed text-ink-3">
          {comparisonMissingNote(game, comparison)}
        </p>
      ) : null}
      {pointsAllowedMissing ? (
        <p className="text-micro leading-relaxed text-ink-3">场均失分暂不可用（数据源没有返回）</p>
      ) : null}
    </div>
  );
}

/** Which side is missing, and why — one short sentence instead of seven dashes. */
function comparisonMissingNote(game: GameDetail, comparison: SeasonComparison): string | null {
  const notes: string[] = [];
  for (const side of ["away", "home"] as const) {
    const team = side === "away" ? game.away : game.home;
    const state = comparison.sides[side];
    if (state === "no-games") notes.push(`${team.name}尚无本赛季常规赛数据`);
    else if (state === "unavailable") notes.push(`${team.name}的数据源没有返回`);
  }
  return notes.length > 0 ? notes.join("；") : null;
}

/* ------------------------------------------------------------------ *
 * Probable lineups.
 *
 * Lazily loaded: the five names need a box score, an ESPN roster and up to ten
 * player-statistics reads, which is far too much to pay for on a screen that
 * may never be expanded.
 * ------------------------------------------------------------------ */

function LineupsBlock({ game }: { game: GameDetail }) {
  const [open, setOpen] = useState(false);
  const lineups = useLineups(game.id, open);

  return (
    <section aria-label="预计阵容" className="flex flex-col gap-3">
      <h2 className="eyebrow text-ink-3">预计阵容</h2>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="btn-secondary w-full justify-between"
      >
        <span>{open ? "收起预计阵容" : "展开预计阵容"}</span>
        <span aria-hidden="true" className="text-title leading-none text-ink-3">
          {open ? "−" : "+"}
        </span>
      </button>

      {open ? <LineupsBody game={game} state={lineups} /> : null}
    </section>
  );
}

function LineupsBody({
  game,
  state,
}: {
  game: GameDetail;
  state: ResourceState<LineupsResponse>;
}) {
  if (!state.data) {
    return (
      <PregameNotice
        title={state.status === "error" ? "预计阵容暂不可用" : "阵容加载中"}
        body={
          state.status === "error"
            ? "数据源没有返回，稍后会自动重试"
            : "正在读取双方最近一场比赛的首发与本赛季场均"
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <LineupCard team={game.away} lineup={state.data.lineups.away} />
      <LineupCard team={game.home} lineup={state.data.lineups.home} />
    </div>
  );
}

function LineupCard({ team, lineup }: { team: TeamSide; lineup: TeamLineup }) {
  const title =
    lineup.basis === "last-game" ? "预计首发" : lineup.basis === "roster" ? "阵容名单" : null;

  return (
    <div className="card flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <TeamLogo team={team} size={18} />
        <span className="text-body leading-none font-medium text-ink">{team.name}</span>
        {title ? (
          <span className="ml-auto rounded-full bg-elevated px-2 py-0.5 text-micro leading-none text-ink-2">
            {title}
          </span>
        ) : null}
      </div>

      {lineup.basis === "unavailable" ? (
        <p className="text-meta leading-relaxed text-ink-3">
          阵容暂不可用：最近一场比赛数据与球队名单都没有返回
        </p>
      ) : (
        <>
          <p className="text-micro leading-relaxed text-ink-3">{lineupNote(lineup)}</p>
          {lineup.players.length > 0 ? (
            <ul className="flex flex-col">
              {lineup.players.map((player, index) => (
                <LineupRow key={`${player.espnId || player.name}-${index}`} player={player} />
              ))}
            </ul>
          ) : (
            <p className="text-meta leading-relaxed text-ink-3">名单里暂无可用的球员</p>
          )}
        </>
      )}
    </div>
  );
}

/** Where the five came from, in the words of the block. */
function lineupNote(lineup: TeamLineup): string {
  if (lineup.basis === "last-game" && lineup.sourceGame) {
    const date = new Date(lineup.sourceGame.startTime);
    const dateLabel = Number.isNaN(date.getTime()) ? "" : formatCompactDate(date);
    const stage = lineup.sourceGame.label ? ` · ${lineup.sourceGame.label}` : "";
    return `${dateLabel ? `${dateLabel} ` : ""}对 ${lineup.sourceGame.opponentTricode}${stage} 的最近一场首发`;
  }
  if (lineup.completedGames === 0) {
    return "本赛季尚无已完赛比赛，按名单位置列出，不是官方首发";
  }
  return "最近一场比赛数据没有返回，按名单位置列出，不是官方首发";
}

function LineupRow({ player }: { player: LineupPlayer }) {
  const hasStats = player.points !== null || player.rebounds !== null || player.assists !== null;

  return (
    <li className="flex min-h-11 items-center gap-2 border-t border-line first:border-t-0">
      <span className="w-[24px] shrink-0 text-micro leading-none font-medium tracking-wide text-ink-3">
        {player.position || "—"}
      </span>
      <span className="tnum w-[26px] shrink-0 text-right text-micro leading-none text-ink-3">
        {player.jersey ? `#${player.jersey}` : ""}
      </span>
      <span className="min-w-0 flex-1 truncate text-body leading-none text-ink" title={player.name}>
        {player.name}
      </span>
      {hasStats ? (
        <span className="tnum shrink-0 text-micro leading-none text-ink-2">
          {playerAverage(player.points)}分 {playerAverage(player.rebounds)}板{" "}
          {playerAverage(player.assists)}助
        </span>
      ) : (
        <span className="shrink-0 text-micro leading-none text-ink-3">暂无赛季数据</span>
      )}
    </li>
  );
}

function playerAverage(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Shared empty/loading card so both new blocks speak in one voice. */
function PregameNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="state-panel gap-2 px-6 py-5">
      <p className="text-body leading-none font-medium text-ink-2">{title}</p>
      <p className="text-meta leading-relaxed text-ink-3">{body}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The compact panel the box-score tab falls back to.
 * ------------------------------------------------------------------ */

/**
 * The small "not published yet" card used inside a tab body. The pre-game view
 * above is the page-level answer; this stays for the tab-level case.
 */
export function PreGamePanel({ game }: { game: GameDetail }) {
  return (
    <div className="state-panel">
      <p className="tnum text-title leading-none font-medium text-ink">
        {formatLocalTime(game.startTime)}
      </p>
      {!game.postponed ? (
        <CountdownText
          bare
          startTime={game.startTime}
          className="tnum text-body leading-none text-ink-2"
        />
      ) : null}
      <p className="text-body leading-none text-ink-3">
        {game.postponed ? "比赛延期" : (game.arena ?? "尚未开始")}
      </p>
    </div>
  );
}
