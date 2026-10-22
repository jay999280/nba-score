"use client";

import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import { formatPlusMinus } from "@/lib/format";
import { boxAvailability } from "@/lib/game-state";
import type { GameDetail, PlayerLine, TeamBox, TeamSide } from "@/lib/types";
import { ErrorState } from "../states";
import { TeamLogo } from "../team-logo";
import { PreGamePanel } from "./pre-game";

type SortKey = "pts" | "reb" | "ast";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "pts", label: "得分" },
  { key: "reb", label: "篮板" },
  { key: "ast", label: "助攻" },
];

/**
 * The font size the whole table is built on — 13px at the 16px default root.
 *
 * Every number cell and every column width is expressed against this one size
 * (cells in `em`, widths in `em`), so a reader who enlarges text — a bigger
 * root font or a system/WebView text zoom that scales the cells' own font-size
 * — grows the text and the columns by the same factor instead of letting
 * fixed pixel columns fill up and spill into their neighbours. `rem` keeps it
 * following the page's root size as well.
 */
const BOX_FONT_SIZE = "0.8125rem";

/**
 * The eight fields the PRD promotes for phones.
 *
 * Each width is solved from measurements taken at every text size the table
 * has to survive (default 13px base, a 17/18px root, and a text-zoom that
 * forces the cells' own font-size to 17/18px): the widest value a column can
 * hold — "38:55" minutes, "100" points, "12-24" shooting, "10-13" threes,
 * "+19"/"-23" plus-minus — or its own header label, plus the cell's leading
 * (`pl-[0.2em]`) and ~1.2px of headroom, divided by the font size the column
 * is measured against. Glyph advances round per size, so 18px text is not a
 * clean 18/13 of 13px text ("12-24" is 33px at 12px but 52px at 18px); the
 * widths carry that, which is why 投篮/三分 are wider than a linear scale
 * would suggest.
 *
 * The leading is part of the box, not free space: a `text-right` value that is
 * wider than its cell's *content* box overflows to the right, past the cell
 * edge. So the rule is `width >= text + padding + headroom`, with padding and
 * width both expressed against the same font size the text scales with.
 *
 * The widths live on the `<th>` of the first row rather than in `<colgroup>`
 * on purpose: a `col` element's `em` resolves against the column element,
 * which a text-zoom that only touches `td`/`th` font-size never grows, while
 * the first row's cells are exactly what `table-fixed` reads its column widths
 * from. That is what makes the same declared width correct at 13px, 17px and
 * 18px. The trade is deliberate and statistics-first: past ~17px on a 375px
 * phone the player column is what is left over (115px at the base size, ~45px
 * at 17px, ~27px at 18px), so long names ellipsise harder and a tap on the
 * name is how they are read in full. Numbers never shrink, elide or overlap to
 * make room for the name.
 *
 * The table stays `table-fixed` (long content cannot widen a column) and is
 * deliberately **not** inside an `overflow-x` container by default: such a
 * container becomes the sticky header's scrollport and silently kills
 * `position: sticky`. At the sizes
 * the accepted rounds measured — 375/390/430px at every font size up to an 18px
 * root — the wrapper is therefore not a scroll container at all.
 *
 * When the text is enlarged far enough that the columns cannot fit any more
 * (the suite's `table 17/18px` proxy, or a real system scale at the top of its
 * range), the digits are still not allowed to shrink or clip, and the name still
 * has to be readable. `useTableScroller` gives the table the measured width its
 * scaled columns need and turns the wrapper into a horizontal scroller only
 * while they do not fit. The page never slides sideways; the header stops
 * pinning to the viewport for exactly as long as that extreme case lasts. Both
 * halves are asserted in `tests/browser/run.py` case `r3_box_narrow_screen_readable`.
 */
const COLUMNS = [
  { key: "min", label: "时间", width: "3.02em", sortable: false },
  { key: "pts", label: "得分", width: "2.14em", sortable: true },
  { key: "reb", label: "篮板", width: "1.92em", sortable: true },
  { key: "ast", label: "助攻", width: "1.92em", sortable: true },
  { key: "fg", label: "投篮", width: "3.16em", sortable: false },
  { key: "three", label: "三分", width: "3.16em", sortable: false },
  { key: "pm", label: "+/-", width: "2.22em", sortable: false },
] as const;

/**
 * The floor under the player column, in the table's own `em`.
 *
 * Four characters of the size the table is rendered at: a Chinese name shows
 * four of them, a Latin one shows around seven and still ends in an ellipsis.
 * Expressed in `em` on purpose — a fixed pixel floor would stop following a
 * system font scale, which is the case it exists for. It is only applied once
 * the columns genuinely cannot fit; at the accepted sizes the column is wider
 * than this anyway (115px at the 375px default).
 *
 * The floor has to be a **width**, not a `min-width`: in `table-fixed` layout a
 * column's leftover width is handed out and a `min-width` on the cell is
 * ignored (measured — the cell kept taking 27px while `min-width` said 76px),
 * while a stated width of `4.2em` takes part in the column sum and makes the
 * table ask for the room it needs.
 */
const NAME_MIN_WIDTH_EM = 4.2;
const NAME_MIN_WIDTH = `${NAME_MIN_WIDTH_EM}em`;

/** Park the sticky header just below the sticky score bar. */
const HEADER_OFFSET = "top-[calc(env(safe-area-inset-top)+var(--bar-h))]";

/**
 * Does the table need its own horizontal scroller, and its player column a floor?
 *
 * Measured, not assumed — and *analytically*, so the answer cannot oscillate
 * with the layout it produces. What the seven numeric columns need is
 * `COLUMNS[i].width` `em` of the size those cells are actually rendered at, and
 * the player column needs `NAME_MIN_WIDTH_EM` of its own; the sum compared with
 * the space the layout gives the table is the whole question. Font sizes are what
 * a system font scale (and the acceptance suite's `table 17/18px` proxy) moves,
 * so this follows exactly the case it is for:
 *
 *   - when the columns fit, the wrapper is a plain block and the player column
 *     keeps taking the leftover width — the accepted 375/390/430px layouts are
 *     untouched;
 *   - when they do not, the player column takes its floor and the table receives
 *     the measured width of all columns, so the *table* scrolls, never the page.
 *
 * A plain block is what keeps `position: sticky` pinning the header to the
 * viewport (an `overflow-x` ancestor becomes the sticky scrollport instead), so
 * the scroller is only ever switched on for the extreme case.
 *
 * `resize` alone is not enough: the table is `w-full`, so a font-size change
 * moves what its columns need without moving the table's border box, and
 * `ResizeObserver` would not fire. The mutation observer watches the two places
 * such a change can come from — the root element's own style (a system or
 * script-driven font scale) and the document's head (a stylesheet, which is how
 * the suite applies its proxy).
 */
function useTableScroller(): {
  tableRef: RefObject<HTMLTableElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  needsScroller: boolean;
  tableWidth: number;
} {
  const tableRef = useRef<HTMLTableElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [needsScroller, setNeedsScroller] = useState(false);
  const [tableWidth, setTableWidth] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const table = tableRef.current;
      const wrapper = wrapperRef.current;
      if (!table || !wrapper) return;
      const headers = table.querySelectorAll("thead th");
      const nameFont = headers[0] ? Number.parseFloat(getComputedStyle(headers[0]).fontSize) : 0;
      if (!nameFont) return;
      const numericWidth = COLUMNS.reduce((total, column, index) => {
        const cell = headers[index + 1];
        const font = cell ? Number.parseFloat(getComputedStyle(cell).fontSize) : 0;
        return total + Number.parseFloat(column.width) * font;
      }, 0);
      const cellPadding = Array.from(headers).reduce((total, cell) => {
        const style = getComputedStyle(cell);
        return total + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      }, 0);
      // Include cell padding so WebView table sizing cannot compress the
      // declared columns when Android scales the text.
      const needed = Math.ceil(NAME_MIN_WIDTH_EM * nameFont + numericWidth + cellPadding + 4);
      setTableWidth(needed);
      setNeedsScroller(needed > wrapper.clientWidth + 1);
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    observer.observe(document.head, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return { tableRef, wrapperRef, needsScroller, tableWidth };
}

/**
 * Box Score (PRD §15): one team at a time, switchable without scrolling past
 * the other side.
 *
 * Availability is decided per panel (`boxAvailability`), not by the page-level
 * `detailAvailability`: team stats can arrive while every player line is still
 * missing, and that is an empty player table — not a blank one.
 */
export function BoxScore({ game }: { game: GameDetail }) {
  const teams: { team: TeamSide; box: TeamBox }[] = [
    { team: game.away, box: game.boxScore.away },
    { team: game.home, box: game.boxScore.home },
  ];

  const [side, setSide] = useState(0);

  const availability = boxAvailability(game);
  if (availability === "not-started") return <PreGamePanel game={game} />;
  if (availability === "unavailable") {
    return <BoxNotice detail="数据源暂时没有返回这场比赛的技术统计" />;
  }

  const active = teams[side];

  return (
    <div className="flex flex-col gap-5">
      <TeamSwitch teams={teams} side={side} onSelect={setSide} />

      {availability === "empty" ? (
        <BoxNotice detail="数据源暂时没有返回这场比赛的球员技术统计" />
      ) : (
        <TeamTable team={active.team} box={active.box} />
      )}
    </div>
  );
}

function TeamSwitch({
  teams,
  side,
  onSelect,
}: {
  teams: { team: TeamSide; box: TeamBox }[];
  side: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="选择球队"
      className="segmented-track"
    >
      {teams.map((entry, index) => {
        const selected = index === side;
        return (
          <button
            key={entry.team.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(index)}
            className="segmented-item flex-1"
          >
            <TeamLogo team={entry.team} size={18} dimmed={!selected} />
            <span className="truncate">{entry.team.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The one wording both empty states share: the table has nothing to show. */
function BoxNotice({ detail }: { detail: string }) {
  return <ErrorState message="暂时读不到球员数据" hint={detail} />;
}

function TeamTable({ team, box }: { team: TeamSide; box: TeamBox }) {
  const [sort, setSort] = useState<SortKey>("pts");
  const [descending, setDescending] = useState(true);
  const { tableRef, wrapperRef, needsScroller, tableWidth } = useTableScroller();

  const starters = useMemo(() => box.players.filter((player) => player.starter), [box.players]);
  const bench = useMemo(() => box.players.filter((player) => !player.starter), [box.players]);

  const sortPlayers = useMemo(
    () => (players: PlayerLine[]) => {
      const value = (player: PlayerLine) =>
        sort === "pts" ? player.points : sort === "reb" ? player.rebounds : player.assists;
      // Copy before sorting: `box.players` order is the source order and the
      // starters-first grouping depends on it.
      return [...players].sort((a, b) => (descending ? value(b) - value(a) : value(a) - value(b)));
    },
    [sort, descending],
  );

  const onSort = (key: SortKey) => {
    if (key === sort) {
      setDescending((value) => !value);
      return;
    }
    setSort(key);
    setDescending(true);
  };

  // One side can be published while the other is not: that team gets its own
  // sentence instead of a header row with no players under it.
  if (box.players.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <TeamHeading team={team} />
        <BoxNotice detail={`${team.name}这一侧暂无技术统计，可切换另一队查看`} />
      </section>
    );
  }

  const groups: { label: string; players: PlayerLine[] }[] = [
    { label: "首发", players: sortPlayers(starters) },
    { label: "替补", players: sortPlayers(bench) },
  ].filter((group) => group.players.length > 0);

  return (
    <section className="flex flex-col gap-3">
      <TeamHeading team={team} />

      {/* Sorting lives here rather than inside the table header: a header cell
          on a 375px screen is 25–41px wide, so a real 44px target cannot fit
          in it without starving the player column. The control states the
          current key and direction, and `aria-sort` on the header carries the
          same fact to assistive tech. */}
      <div role="group" aria-label="球员排序" className="flex items-center gap-2">
        <span className="eyebrow shrink-0 text-ink-3">排序</span>
        {SORT_OPTIONS.map((option) => {
          const active = option.key === sort;
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onSort(option.key)}
              aria-pressed={active}
              className="chip flex-1 gap-1 px-2"
            >
              {option.label}
              <span aria-hidden="true" className="text-micro leading-none">
                {active ? (descending ? "▼" : "▲") : ""}
              </span>
            </button>
          );
        })}
      </div>

      <div ref={wrapperRef} className={needsScroller ? "overflow-x-auto" : undefined}>
        <table
          ref={tableRef}
          className="w-full table-fixed border-collapse"
          style={{ fontSize: BOX_FONT_SIZE, width: needsScroller ? `${tableWidth}px` : "100%" }}
        >
          <thead className={`sticky ${HEADER_OFFSET} z-10 bg-bg`}>
            <tr>
              <th
                scope="col"
                style={needsScroller ? { width: NAME_MIN_WIDTH } : undefined}
                className="border-b border-line pb-2 text-left font-medium text-ink-3"
              >
                <span className="col-label">球员</span>
              </th>
              {COLUMNS.map((column) => {
                const active = column.sortable && column.key === sort;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (descending ? "descending" : "ascending") : undefined}
                    style={{ width: column.width }}
                    className="border-b border-line pb-2 pl-[0.2em] text-right font-medium whitespace-nowrap text-ink-3"
                  >
                    <span className="col-label">{column.label}</span>
                  </th>
                );
              })}
            </tr>
          </thead>

          {groups.map((group) => (
            <tbody key={group.label}>
              <tr>
                <td colSpan={COLUMNS.length + 1} className="pt-3 pb-1">
                  <span className="eyebrow text-ink-3">
                    {group.label} · {group.players.length}人
                  </span>
                </td>
              </tr>
              {group.players.map((player) => (
                <PlayerRow key={player.personId} player={player} />
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function TeamHeading({ team }: { team: TeamSide }) {
  return (
    <div className="flex items-center gap-2">
      <TeamLogo team={team} size={20} />
      <span className="text-title leading-none font-medium text-ink">{team.fullName}</span>
    </div>
  );
}

function PlayerRow({ player }: { player: PlayerLine }) {
  // On a 375px screen a long compound name is ellipsised, and `title` is no
  // help on a phone at all. Tapping the name reveals it in place instead — and
  // the whole first cell is the target (44px tall, the full column wide), not
  // just the 16px of text.
  //
  // The name is `1em` of the table's base size, i.e. the same 13px the numbers
  // use: enlarged text must enlarge it too. The column it sits in is what the
  // fixed number columns leave over, with `NAME_MIN_WIDTH` as its floor — and
  // when even that floor cannot fit, the table scrolls rather than the page.
  const [expanded, setExpanded] = useState(false);

  return (
    <tr className="border-t border-line align-middle">
      <td className="p-0 pr-1">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex min-h-11 w-full items-center text-left text-[1em] leading-tight text-ink"
        >
          <span className={expanded ? "break-words" : "block truncate"}>{player.name}</span>
        </button>
      </td>
      <td className="tnum py-2 pl-[0.2em] text-right text-[1em] leading-none whitespace-nowrap text-ink-2">
        {player.minutes}
      </td>
      <td className="tnum py-2 pl-[0.2em] text-right text-[1em] leading-none font-medium whitespace-nowrap text-ink">
        {player.points}
      </td>
      <td className="tnum py-2 pl-[0.2em] text-right text-[0.923em] leading-none whitespace-nowrap text-ink-2">
        {player.rebounds}
      </td>
      <td className="tnum py-2 pl-[0.2em] text-right text-[0.923em] leading-none whitespace-nowrap text-ink-2">
        {player.assists}
      </td>
      <td className="tnum py-2 pl-[0.2em] text-right text-[0.923em] leading-none whitespace-nowrap text-ink-2">
        {player.fg}
      </td>
      <td className="tnum py-2 pl-[0.2em] text-right text-[0.923em] leading-none whitespace-nowrap text-ink-2">
        {player.threePt}
      </td>
      <td className="tnum py-2 pl-[0.2em] text-right text-[0.923em] leading-none whitespace-nowrap text-ink-2">
        {formatPlusMinus(player.plusMinus)}
      </td>
    </tr>
  );
}
