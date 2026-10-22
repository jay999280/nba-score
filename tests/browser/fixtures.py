"""Deterministic, fully synthetic API fixtures for the committed browser suite.

**Every payload in this module is hand-written mock data.** Nothing here is
copied from the NBA feeds, and the suite never talks to them: `run.py` aborts
any request whose host is not the local dev server and records it, so a fixture
that silently fell through to the real API would fail the run instead of
"passing" against live data.

The team *ids* are the real NBA ids on purpose — the app's favourites store and
its team catalog are keyed by them, so a mock slate has to speak the same ids to
exercise the follow/filter path. Scores, clocks, names, minutes and plus-minus
are invented.

Where the numbers come from matters for the assertions:

`STALE_SOURCE_AT`
    The upstream data time used by the degraded scenarios. It is deliberately
    far from the machine's own clock (two days earlier at the time of writing),
    so a notice that renders it is provably rendering the *source* time and not
    the receive time.

`CACHE_WRITTEN_AT`
    The moment the (simulated) service worker wrote its offline copy. The body
    keeps a *live-looking* freshness record and the copy markers arrive as
    headers, exactly like `public/sw.js` does it in production, so the suite
    tests the client's header handling rather than a pre-baked body.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

# --------------------------------------------------------------------------
# Scenario constants
# --------------------------------------------------------------------------

#: Date the list fixtures answer for. Any `?date=` is answered with the same
#: slate; the value only has to survive the round trip through the URL.
SOURCE_DATE = "2026-10-09"
#: A second date, used to give the history tests a real previous entry.
PREV_DATE = "2026-10-10"

#: Upstream data time for the degraded scenarios: 2026-10-09 20:34 in +08.
STALE_SOURCE_AT = "2026-10-09T12:34:00Z"
#: Rendered pieces of `STALE_SOURCE_AT` in the app's Asia/Shanghai context.
STALE_SOURCE_PARTS = ("10-9", "20:34")
#: Simulated service-worker cache write: 2026-10-11 01:00 in +08.
CACHE_WRITTEN_AT = "2026-10-11T01:00:00+08:00"
CACHE_WRITTEN_PARTS = ("10-11", "01:00")

#: Detail fixture ids, one per behaviour the suite locks down.
EXTREME_ID = "0012609001"  # extreme player table, both sides populated
STATS_ONLY_ID = "0012609002"  # team stats present, both player lists empty
ONE_SIDE_ID = "0012609003"  # only the home side has player lines
UPCOMING_ID = "0012609004"  # not started: genuinely nothing published
LIVE_EMPTY_ID = "0012609005"  # under way, but no stats and no player lines
FIXTURE_IDS = (EXTREME_ID, STATS_ONLY_ID, ONE_SIDE_ID, UPCOMING_ID, LIVE_EMPTY_ID)

# --------------------------------------------------------------------------
# Teams (real ids, invented records)
# --------------------------------------------------------------------------

_TEAMS: dict[int, dict[str, str]] = {
    1610612747: {"tricode": "LAL", "city": "洛杉矶", "name": "湖人", "fullName": "洛杉矶湖人", "color": "#FDB927"},
    1610612744: {"tricode": "GSW", "city": "金州", "name": "勇士", "fullName": "金州勇士", "color": "#1D428A"},
    1610612738: {"tricode": "BOS", "city": "波士顿", "name": "凯尔特人", "fullName": "波士顿凯尔特人", "color": "#007A33"},
    1610612743: {"tricode": "DEN", "city": "丹佛", "name": "掘金", "fullName": "丹佛掘金", "color": "#0E2240"},
    1610612748: {"tricode": "MIA", "city": "迈阿密", "name": "热火", "fullName": "迈阿密热火", "color": "#98002E"},
    1610612756: {"tricode": "PHX", "city": "菲尼克斯", "name": "太阳", "fullName": "菲尼克斯太阳", "color": "#E56020"},
}

LAL, GSW, BOS = 1610612747, 1610612744, 1610612738
DEN, MIA, PHX = 1610612743, 1610612748, 1610612756
#: Teams the suite follows by seeding `localStorage.favoriteTeams`. Every game
#: in the mock slate features at least one of them, so `?fav=1` still produces a
#: list tall enough to scroll — see `_PAIRS` and `assert_fixture_invariants`.
FOLLOWED = (LAL, GSW, BOS)

#: 20 games, each pairing a followed team with someone. Written out rather than
#: generated so the slate is stable and readable.
_PAIRS: tuple[tuple[int, int], ...] = (
    (LAL, GSW), (BOS, DEN), (GSW, MIA), (LAL, PHX), (BOS, GSW),
    (DEN, LAL), (MIA, BOS), (GSW, PHX), (LAL, BOS), (DEN, GSW),
    (MIA, LAL), (PHX, BOS), (GSW, LAL), (BOS, GSW), (LAL, DEN),
    (PHX, GSW), (MIA, BOS), (LAL, MIA), (GSW, BOS), (DEN, LAL),
)

#: The statuses the mixed slate cycles through; at least one `live` game always
#: exists, which is what makes the stale/partial rules observable.
_MIXED_STATUSES = ("live", "final", "upcoming")


def _now_iso() -> str:
    """The current instant as an ISO string — used only where "fresh" is meant."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _side(team_id: int, score: int | None, *, winner: bool = False, periods: int = 0) -> dict[str, Any]:
    team = _TEAMS[team_id]
    return {
        "id": team_id,
        "tricode": team["tricode"],
        "city": team["city"],
        "name": team["name"],
        "fullName": team["fullName"],
        "score": score,
        "winner": winner,
        "record": "3-2",
        "periods": [{"period": index + 1, "score": 22 + index + (team_id % 3)} for index in range(periods)],
        "logo": f"/api/logo/{team_id}",
        "color": team["color"],
    }


_STATUS_TEXT = {"live": "第4节 · 6:21", "final": "已结束", "upcoming": "10:30"}


def _game(game_id: str, status: str, away_id: int, home_id: int, *, index: int = 0) -> dict[str, Any]:
    """One list-row game. Scores are deterministic and invented."""
    away_score = None if status == "upcoming" else 96 + (index * 7) % 23
    home_score = None if status == "upcoming" else 92 + (index * 11) % 27
    if status != "upcoming" and away_score == home_score:
        home_score += 2
    away_wins = away_score is not None and away_score > (home_score or 0)
    periods = 0 if status == "upcoming" else 4
    return {
        "id": game_id,
        "status": status,
        "statusText": _STATUS_TEXT[status],
        "period": 4 if status in ("live", "final") else 0,
        "clock": "6:21" if status == "live" else None,
        "startTime": f"2026-10-09T{18 + index % 6:02d}:30:00Z",
        "label": "季前赛",
        "postponed": False,
        "away": _side(away_id, away_score, winner=away_wins, periods=periods),
        "home": _side(home_id, home_score, winner=not away_wins and home_score is not None, periods=periods),
    }


def list_games(*, all_final: bool = False, count: int = len(_PAIRS)) -> list[dict[str, Any]]:
    """The mock slate behind every home-page assertion.

    `all_final` forces a finished slate. The partial-coverage notice only shows
    when the payload is not *also* stale, and a finished game is never called
    stale merely for being old — so the partial scenario needs final games to
    isolate the rule it is testing.
    """
    games: list[dict[str, Any]] = []
    for index, (away_id, home_id) in enumerate(_PAIRS[:count]):
        status = "final" if all_final else _MIXED_STATUSES[index % len(_MIXED_STATUSES)]
        games.append(_game(f"00126{index:05d}", status, away_id, home_id, index=index))
    return games


# --------------------------------------------------------------------------
# Player lines
# --------------------------------------------------------------------------

#: Values chosen to hit every extreme the PRD copy called out: a `38:55` minutes
#: cell, `12-24` shooting, `7-13` threes, a plus-minus of both signs *and* zero,
#: and Chinese names well past four characters.
#:
#: `ENLARGED_*` is the row the enlarged-text case measures: the longest name the
#: layout has to survive, `42:57` minutes, `13-27` shooting and `-28`, all of
#: which are the widest values their columns can ever hold. They are constants
#: because `r3_box_enlarged_font_columns` asserts *these* strings are the ones
#: it found inside their columns — a fixture that quietly lost them would
#: otherwise make the case pass by measuring nothing.
ENLARGED_LONG_NAME = "阿卜杜勒拉赫曼穆罕默德"
ENLARGED_MINUTES = "42:57"
ENLARGED_FG = "13-27"
ENLARGED_THREE = "9-16"
ENLARGED_PM = -28

_EXTREME_PLAYERS: tuple[dict[str, Any], ...] = (
    {
        "personId": 1, "name": "亚历山大沃克", "jersey": "4", "position": "G", "starter": True,
        "minutes": "38:55", "points": 31, "rebounds": 9, "assists": 11,
        "fg": "12-24", "threePt": "7-13", "ft": "2-3", "plusMinus": 12,
        "steals": 2, "blocks": 1, "turnovers": 3, "fouls": 4,
    },
    {
        "personId": 2, "name": "谢伊吉尔杰斯亚历山大", "jersey": "2", "position": "G", "starter": True,
        "minutes": "36:40", "points": 28, "rebounds": 0, "assists": 7,
        "fg": "10-19", "threePt": "3-8", "ft": "5-5", "plusMinus": -23,
        "steals": 0, "blocks": 0, "turnovers": 2, "fouls": 1,
    },
    {
        "personId": 3, "name": "小迈克尔波特", "jersey": "1", "position": "F", "starter": True,
        "minutes": "0:00", "points": 0, "rebounds": 0, "assists": 0,
        "fg": "0-0", "threePt": "0-3", "ft": "0-0", "plusMinus": 0,
        "steals": 0, "blocks": 0, "turnovers": 0, "fouls": 0,
    },
    {
        "personId": 4, "name": "尼古拉约基奇", "jersey": "15", "position": "C", "starter": True,
        "minutes": "34:12", "points": 22, "rebounds": 14, "assists": 3,
        "fg": "9-15", "threePt": "1-4", "ft": "3-4", "plusMinus": -5,
        "steals": 1, "blocks": 2, "turnovers": 4, "fouls": 3,
    },
    {
        "personId": 5, "name": "奥斯汀里夫斯", "jersey": "15", "position": "G", "starter": True,
        "minutes": "31:07", "points": 18, "rebounds": 4, "assists": 6,
        "fg": "7-14", "threePt": "2-6", "ft": "2-2", "plusMinus": 7,
        "steals": 1, "blocks": 0, "turnovers": 1, "fouls": 2,
    },
    {
        "personId": 6, "name": ENLARGED_LONG_NAME, "jersey": "23", "position": "C", "starter": False,
        "minutes": ENLARGED_MINUTES, "points": 37, "rebounds": 13, "assists": 12,
        "fg": ENLARGED_FG, "threePt": ENLARGED_THREE, "ft": "4-6", "plusMinus": ENLARGED_PM,
        "steals": 3, "blocks": 2, "turnovers": 5, "fouls": 4,
    },
)


def _extreme_players(seed: int) -> list[dict[str, Any]]:
    """Fifteen invented lines per side: the fixed extremes first, then bench."""
    players = [dict(player, personId=player["personId"] * 100 + seed) for player in _EXTREME_PLAYERS]
    for index in range(10):
        players.append(
            {
                "personId": seed * 1000 + index,
                "name": f"替补球员第{index:02d}号",
                "jersey": str(20 + index),
                "position": "F",
                "starter": False,
                "minutes": f"{8 + index}:{index * 7 % 60:02d}",
                "points": (index * 5) % 17,
                "rebounds": index % 6,
                "assists": (index * 3) % 5,
                "fg": f"{index % 6}-{6 + index % 8}",
                "threePt": f"{index % 3}-{3 + index % 5}",
                "ft": f"{index % 2}-2",
                "plusMinus": [-9, -4, 0, 3, 8, 11][index % 6],
                "steals": index % 3,
                "blocks": index % 2,
                "turnovers": index % 4,
                "fouls": index % 5,
            }
        )
    return players


def _normal_players(seed: int, count: int = 4) -> list[dict[str, Any]]:
    return [
        {
            "personId": seed * 100 + index,
            "name": f"测试球员{seed}{index}",
            "jersey": str(index + 1),
            "position": "G",
            "starter": index < 2,
            "minutes": f"{20 + index}:{10 + index:02d}",
            "points": 12 + index,
            "rebounds": 3 + index,
            "assists": 2 + index,
            "fg": f"{4 + index}-{9 + index}",
            "threePt": f"{index}-{2 + index}",
            "ft": "1-2",
            "plusMinus": index - 1,
            "steals": 1,
            "blocks": 0,
            "turnovers": 1,
            "fouls": 2,
        }
        for index in range(count)
    ]


STAT_ROWS: tuple[dict[str, str], ...] = (
    {"label": "篮板", "home": "44", "away": "41"},
    {"label": "助攻", "home": "27", "away": "23"},
    {"label": "投篮命中率", "home": "48.2", "away": "45.1"},
    {"label": "三分命中率", "home": "38.9", "away": "33.3"},
    {"label": "失误", "home": "12", "away": "15"},
    {"label": "禁区得分", "home": "52", "away": "46"},
)

_EMPTY_LEADERS = {"points": None, "rebounds": None, "assists": None}


def _box(team_id: int, players: list[dict[str, Any]]) -> dict[str, Any]:
    team = _TEAMS[team_id]
    return {"id": team_id, "tricode": team["tricode"], "name": team["name"], "players": players}


def _detail(
    game_id: str,
    *,
    status: str = "live",
    stats: list[dict[str, str]] | None = None,
    home_players: list[dict[str, Any]] | None = None,
    away_players: list[dict[str, Any]] | None = None,
    arena: str | None = "测试球馆",
    start_time: str = "2026-10-10T02:00:00Z",
) -> dict[str, Any]:
    game = _game(game_id, status, GSW, LAL, index=3)
    game.update(
        {
            "id": game_id,
            "arena": arena,
            "startTime": start_time,
            "leaders": {"home": dict(_EMPTY_LEADERS), "away": dict(_EMPTY_LEADERS)},
            "matchup": None,
            "stats": list(stats if stats is not None else STAT_ROWS),
            "boxScore": {
                "home": _box(LAL, home_players if home_players is not None else []),
                "away": _box(GSW, away_players if away_players is not None else []),
            },
        }
    )
    return game


def detail_extreme() -> dict[str, Any]:
    """Both sides populated with the extreme values the layout has to survive."""
    return _detail(
        EXTREME_ID,
        status="live",
        home_players=_extreme_players(1),
        away_players=_extreme_players(2),
    )


def detail_stats_only() -> dict[str, Any]:
    """Team stats present, both player lists empty — the R4 empty-table case."""
    return _detail(STATS_ONLY_ID, status="live")


def detail_one_side() -> dict[str, Any]:
    """Only the home side published player lines; the away side has its own note."""
    return _detail(ONE_SIDE_ID, status="live", home_players=_normal_players(3), away_players=[])


def detail_upcoming() -> dict[str, Any]:
    """Genuinely not started: no stats, no player lines. Must not read as a failure."""
    return _detail(
        UPCOMING_ID,
        status="upcoming",
        stats=[],
        arena=None,
        start_time="2026-10-14T02:00:00Z",
    )


def detail_live_unavailable() -> dict[str, Any]:
    """Under way, but nothing could be read: a failure, not "not started"."""
    return _detail(LIVE_EMPTY_ID, status="live", stats=[])


def detail_generic(game_id: str) -> dict[str, Any]:
    """A plain live game, for cards opened from the list fixtures."""
    return _detail(
        game_id,
        status="live",
        home_players=_normal_players(5, count=6),
        away_players=_normal_players(7, count=6),
    )


DETAIL_FIXTURES: dict[str, Callable[[], dict[str, Any]]] = {
    EXTREME_ID: detail_extreme,
    STATS_ONLY_ID: detail_stats_only,
    ONE_SIDE_ID: detail_one_side,
    UPCOMING_ID: detail_upcoming,
    LIVE_EMPTY_ID: detail_live_unavailable,
}


def plays(game_id: str, freshness: dict[str, Any]) -> dict[str, Any]:
    """The Plays tab's payload. Empty on purpose: this suite is about the other tabs."""
    return {
        "gameId": game_id,
        "state": "ready",
        "status": "live",
        "events": [],
        "flow": [{"t": 0, "margin": 0}, {"t": 12, "margin": 3}, {"t": 24, "margin": -2}],
        "shots": [],
        "periods": [1, 2, 3, 4],
        "freshness": freshness,
    }


# --------------------------------------------------------------------------
# Pre-game season comparison + probable lineups (v1.2)
#
# Shapes follow `LineupsResponse` in `src/lib/types.ts`. Invented on purpose:
# the block is the only place where a season average and a lineup are shown
# together, and this fixture exercises both source paths — LAL has a completed
# game (starters with averages), GSW has not (roster fallback, no averages).
# --------------------------------------------------------------------------

def _empty_comparison() -> dict[str, Any]:
    return {
        "season": "2026-27",
        "state": "unavailable",
        "rows": [],
        "sides": {"away": "unavailable", "home": "unavailable"},
    }


def _comparison() -> dict[str, Any]:
    return {
        "season": "2026-27",
        "state": "ready",
        "rows": [
            {"key": "points", "label": "场均得分", "away": None, "home": "112.4"},
            {"key": "points-allowed", "label": "场均失分", "away": None, "home": "108.1"},
            {"key": "field-goal-pct", "label": "投篮命中率", "away": None, "home": "48.2%"},
            {"key": "three-point-pct", "label": "三分命中率", "away": None, "home": "36.1%"},
            {"key": "rebounds", "label": "场均篮板", "away": None, "home": "43.8"},
            {"key": "assists", "label": "场均助攻", "away": None, "home": "26.5"},
            {"key": "turnovers", "label": "场均失误", "away": None, "home": "13.2"},
        ],
        "sides": {"away": "no-games", "home": "ready"},
    }


def _lineup_player(
    name: str,
    jersey: str,
    position: str,
    points: float | None = None,
    rebounds: float | None = None,
    assists: float | None = None,
) -> dict[str, Any]:
    return {
        "espnId": "",
        "name": name,
        "position": position,
        "jersey": jersey,
        "points": points,
        "rebounds": rebounds,
        "assists": assists,
    }


def _empty_lineup(team_id: int) -> dict[str, Any]:
    return {"teamId": team_id, "basis": "unavailable", "sourceGame": None, "completedGames": 0, "players": []}


def _lineups() -> dict[str, Any]:
    return {
        "away": {
            "teamId": GSW,
            "basis": "roster",
            "sourceGame": None,
            "completedGames": 0,
            "players": [
                _lineup_player("测试后卫甲", "30", "G"),
                _lineup_player("测试后卫乙", "1", "G"),
                _lineup_player("测试前锋甲", "10", "F"),
                _lineup_player("测试前锋乙", "23", "F"),
                _lineup_player("测试中锋", "45", "C"),
            ],
        },
        "home": {
            "teamId": LAL,
            "basis": "last-game",
            "sourceGame": {
                "id": "0012609010",
                "startTime": "2026-10-10T02:00:00Z",
                "opponentTricode": "GSW",
                "label": "季前赛",
            },
            "completedGames": 1,
            "players": [
                _lineup_player("测试控卫", "0", "PG", 28.4, 4.1, 8.2),
                _lineup_player("测试分卫", "7", "SG", 19.8, 3.4, 2.9),
                _lineup_player("测试小前", "23", "SF", 24.1, 7.2, 5.4),
                _lineup_player("测试大前", "21", "PF", 13.6, 9.8, 2.1),
                _lineup_player("测试中锋", "15", "C", 16.2, 11.3, 3.7),
            ],
        },
    }


def lineups(game_id: str, section: str | None = None) -> dict[str, Any]:
    """The eager comparison and/or the lazy lineups, mirroring the real route.

    `section` narrows the payload exactly like the route does: the pre-game page
    asks for `comparison` on mount and for `lineups` only when expanded.
    """
    return {
        "gameId": game_id,
        "season": "2026-27",
        "comparison": _comparison() if section in (None, "comparison") else _empty_comparison(),
        "lineups": (
            _lineups()
            if section in (None, "lineups")
            else {"away": _empty_lineup(GSW), "home": _empty_lineup(LAL)}
        ),
    }



MOCK_LOGO_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img">'
    '<circle cx="12" cy="12" r="10" fill="#9aa0a6"/></svg>'
)

MOCK_PUSH_STATUS = {
    "configured": False,
    "vapidPublicKey": None,
    "subscribed": False,
    "settings": None,
    "scheduler": False,
    # `store` is part of the real route's body; kept so the shape matches.
    "store": "fixture",
}


# --------------------------------------------------------------------------
# Freshness scenarios
# --------------------------------------------------------------------------

def _freshness_full() -> dict[str, Any]:
    return {
        "sourceAt": _now_iso(),
        "coverage": "full",
        "scoreboardOk": True,
        "scheduleOk": True,
        "kind": "live",
        "revalidateFailed": False,
    }


def _freshness_partial() -> dict[str, Any]:
    """Only the scoreboard answered, and the list is deliberately not stale.

    `all_final` games keep `isStaleFreshness` false, so this isolates the
    "partial coverage" wording from the "stale data" wording.
    """
    return {
        "sourceAt": STALE_SOURCE_AT,
        "coverage": "partial",
        "scoreboardOk": True,
        "scheduleOk": False,
        "kind": "partial",
        "revalidateFailed": False,
    }


def _freshness_last_good() -> dict[str, Any]:
    """Nothing answered this round; the shown copy is from before the failure."""
    return {
        "sourceAt": STALE_SOURCE_AT,
        "coverage": "full",
        "scoreboardOk": False,
        "scheduleOk": False,
        "kind": "last-good",
        "revalidateFailed": True,
    }


def _freshness_cache_body() -> dict[str, Any]:
    """What the *server* would have written: a complete, live-looking payload.

    The offline part arrives as headers (see `CACHE_HEADERS`), which is exactly
    how the service worker marks a replayed copy. If the client ignored those
    headers the notice would lose its "离线缓存" wording — that is the assertion.
    """
    return {
        "sourceAt": STALE_SOURCE_AT,
        "coverage": "full",
        "scoreboardOk": True,
        "scheduleOk": True,
        "kind": "live",
        "revalidateFailed": False,
    }


SCENARIOS: dict[str, Callable[[], dict[str, Any]]] = {
    "live": _freshness_full,
    "partial": _freshness_partial,
    "last-good": _freshness_last_good,
    "cache": _freshness_cache_body,
}

#: Present on every `/api/**` answer for the offline-cache scenario only.
CACHE_HEADERS = {
    "X-DSH-From-Cache": "1",
    "X-DSH-Cached-At": CACHE_WRITTEN_AT,
}


# --------------------------------------------------------------------------
# Route interception
# --------------------------------------------------------------------------

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

#: Any absolute URL that is *not* the local dev server. Used as a net: a request
#: that leaves the machine is recorded and aborted, so the suite can never
#: accidentally "pass" against the real NBA feeds.
EXTERNAL_URL = re.compile(
    r"^https?://(?!127\.0\.0\.1[:/]|localhost[:/]|\[::1\][:/])",
    re.IGNORECASE,
)

#: The home page asks GitHub for the latest APK release after mount (the update
#: banner). That is a request the product makes on purpose, but this suite must
#: never leave the machine, so it is answered locally instead of hitting the
#: external fence. The answer is the current reality — the repository is private,
#: so the anonymous API says 404 and the banner stays hidden — which also keeps
#: every existing layout assertion unchanged.
RELEASES_URL = re.compile(
    r"^https://api\.github\.com/repos/jay999280/nba-score/releases/latest$",
    re.IGNORECASE,
)


def is_local(url: str) -> bool:
    try:
        return urlparse(url).hostname in LOCAL_HOSTS
    except ValueError:
        return False


class Api:
    """Answers every `/api/**` request from the fixtures above.

    One object per browser context, so request logs and the external-request
    counter stay attributable to the case that produced them.
    """

    def __init__(
        self,
        *,
        scenario: str = "live",
        all_final: bool = False,
        list_count: int = len(_PAIRS),
    ) -> None:
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario: {scenario}")
        self.scenario = scenario
        self.all_final = all_final
        self.list_count = list_count
        self.freshness_factory = SCENARIOS[scenario]
        #: Every `/api/**` URL this context asked for, in order.
        self.requests: list[str] = []
        #: Non-local URLs seen by the context (expected to stay empty).
        self.external_requests: list[str] = []

    # -- route handlers ---------------------------------------------------

    def handle(self, route: Any) -> None:
        url = route.request.url
        if not is_local(url):
            self.block_external(route)
            return

        self.requests.append(url)
        parsed = urlparse(url)
        path = parsed.path
        query = parse_qs(parsed.query)
        freshness = self.freshness_factory()
        headers = CACHE_HEADERS if self.scenario == "cache" else {}

        if path == "/api/games":
            date_key = (query.get("date") or [SOURCE_DATE])[0]
            body = {"date": date_key, "games": list_games(all_final=self.all_final, count=self.list_count), "freshness": freshness}
        elif path == "/api/standings":
            body = {"season": "2026-27", "source": "ESPN", "sourceAt": None,
                    "fetchedAt": _now_iso(), "state": "ready", "stale": False,
                    "teams": [{"teamId": team_id, "tricode": team["tricode"], "name": team["name"],
                               "conference": "East" if team_id in (BOS, MIA) else "West",
                               "rank": index + 1, "wins": 3, "losses": 2, "winPct": 0.6, "gamesBehind": None}
                              for index, (team_id, team) in enumerate(_TEAMS.items())]}
        elif path.startswith("/api/games/") and path.endswith("/plays"):
            game_id = path.split("/")[3]
            body = plays(game_id, freshness)
        elif path.startswith("/api/games/") and path.endswith("/lineups"):
            game_id = path.split("/")[3]
            section = (query.get("section") or [None])[0]
            body = lineups(game_id, section)
        elif path.startswith("/api/games/"):
            game_id = path.split("/")[3]
            build = DETAIL_FIXTURES.get(game_id, lambda: detail_generic(game_id))
            body = {"game": build(), "freshness": freshness}
        elif path.startswith("/api/logo/"):
            route.fulfill(status=200, headers={"Content-Type": "image/svg+xml; charset=utf-8"}, body=MOCK_LOGO_SVG)
            return
        elif path.startswith("/api/push/"):
            body = MOCK_PUSH_STATUS
        else:
            raise AssertionError(f"unfixtured API path requested: {url}")

        route.fulfill(
            status=200,
            headers={"Content-Type": "application/json; charset=utf-8", **headers},
            body=json.dumps(body, ensure_ascii=False),
        )

    def block_external(self, route: Any) -> None:
        """Record and abort anything that is not the local dev server."""
        self.external_requests.append(route.request.url)
        route.abort()

    def block_updates(self, route: Any) -> None:
        """Answer the update check like a repository with no published release."""
        route.fulfill(
            status=404,
            headers={"Content-Type": "application/json; charset=utf-8"},
            body='{"message": "Not Found"}',
        )


#: The `/api/**` entry points the app can call on a page load or a tab tap.
#: They all share one handler, so registration order cannot change the outcome.
#:
#: The trailing `*` on the two routes that take a query string is load-bearing:
#: a Playwright URL glob is matched against the whole URL, so `.../lineups`
#: alone does not match `.../lineups?section=comparison` and the request would
#: escape to the real dev server (a 502 when it cannot reach ESPN).
API_PATTERNS = (
    "**/api/standings",
    "**/api/games*",
    "**/api/games/*",
    "**/api/games/*/plays*",
    "**/api/games/*/lineups*",
    "**/api/logo/*",
    "**/api/push/*",
)


def install_routes(context: Any, api: Api) -> None:
    """Intercept the API and fence off the network for one browser context."""
    for pattern in API_PATTERNS:
        context.route(pattern, api.handle)
    context.route(EXTERNAL_URL, api.block_external)
    # Registered *after* the external fence, so it wins for this one URL: the
    # app's update check is expected traffic, answered locally, and must not be
    # counted as a request that left the machine.
    context.route(RELEASES_URL, api.block_updates)


def local_storage_seed(*, favorites: tuple[int, ...] = FOLLOWED, theme: str | None = None) -> str:
    """An init script seeding localStorage before the app boots.

    `localStorage` throws on `about:blank`, hence the guard. Values are stored
    as JSON because that is the shape the app's store validates.
    """
    entries = [f'localStorage.setItem("favoriteTeams", {json.dumps(json.dumps(list(favorites)))})']
    if theme is not None:
        entries.append(f'localStorage.setItem("theme", {json.dumps(json.dumps(theme))})')
    body = ";".join(entries)
    return f"try{{{body}}}catch(e){{}}"


def assert_fixture_invariants() -> list[str]:
    """Cheap self-checks so a broken fixture fails loudly, not silently.

    Called by the runner before the browser opens; every problem is reported as
    a harness failure rather than a product failure.
    """
    problems: list[str] = []
    for team_id, team in _TEAMS.items():
        if team["tricode"] not in ("LAL", "GSW", "BOS", "DEN", "MIA", "PHX"):
            problems.append(f"team {team_id} has an unexpected tricode")
    if len(_TEAMS) != len({team["tricode"] for team in _TEAMS.values()}):
        problems.append("two mock teams share a tricode")
    if len(_PAIRS) < 12:
        problems.append("slate is too short to scroll")
    for index, (away_id, home_id) in enumerate(_PAIRS):
        if not ({away_id, home_id} & set(FOLLOWED)):
            problems.append(f"game {index} features no followed team; ?fav=1 would drop it")
    for game in list_games():
        if game["status"] != "upcoming" and game["away"]["score"] == game["home"]["score"]:
            problems.append(f"game {game['id']} has a tied score, which no status but final should")
    if not any(game["status"] == "live" for game in list_games()):
        problems.append("mixed slate has no live game")
    extreme = detail_extreme()
    players = extreme["boxScore"]["home"]["players"]
    if not any(p["minutes"] == "38:55" for p in players):
        problems.append("extreme fixture lost its 38:55 minutes")
    if not any(p["fg"] == "12-24" and p["threePt"] == "7-13" for p in players):
        problems.append("extreme fixture lost its 12-24 / 7-13 shooting line")
    plus_minus = {p["plusMinus"] for p in players}
    if not {12, -23, 0} <= plus_minus:
        problems.append("extreme fixture lost +12 / -23 / 0 plus-minus")
    if not any(len(p["name"]) >= 5 for p in players):
        problems.append("extreme fixture lost its long Chinese names")
    # The row the enlarged-text case is built on: without it that case would
    # measure a table whose widest value is no longer widest.
    long_row = next((p for p in players if p["name"] == ENLARGED_LONG_NAME), None)
    if long_row is None:
        problems.append(f"extreme fixture lost its {ENLARGED_LONG_NAME!r} row")
    elif (
        long_row["minutes"] != ENLARGED_MINUTES
        or long_row["fg"] != ENLARGED_FG
        or long_row["threePt"] != ENLARGED_THREE
        or long_row["plusMinus"] != ENLARGED_PM
    ):
        problems.append("the longest-name row no longer carries the widest multi-digit values")
    if len(ENLARGED_LONG_NAME) < 11:
        problems.append("ENLARGED_LONG_NAME is too short to be the long-name case")
    if detail_upcoming()["status"] != "upcoming":
        problems.append("upcoming fixture is not upcoming")
    # The pre-game blocks: the eager comparison and the lazy lineups must stay
    # in step with the route's `section` narrowing, and both sides must be named
    # (a short list would read as "no data" rather than as this fixture).
    full = lineups(UPCOMING_ID)
    if len(full["comparison"]["rows"]) != 7:
        problems.append("lineups fixture lost its seven comparison rows")
    for side in ("away", "home"):
        if len(full["lineups"][side]["players"]) != 5:
            problems.append(f"lineups fixture side {side} does not have five players")
    if lineups(UPCOMING_ID, "comparison")["lineups"]["away"]["basis"] != "unavailable":
        problems.append("the comparison-only fixture also computes the lineups")
    if lineups(UPCOMING_ID, "lineups")["comparison"]["state"] != "unavailable":
        problems.append("the lineups-only fixture also computes the comparison")
    return problems
