"""Deterministic UI checks for stages, regular standings and playoff series.

Run against an existing web server: python tests/browser/season-context.py --base-url http://127.0.0.1:3210
All API responses are fixtures. This is browser validation, not Android acceptance.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright
import fixtures

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "tests/browser/artifacts/season-context"


def standings_fixture() -> dict:
    catalog = (ROOT / "src/lib/nba/team-catalog.ts").read_text(encoding="utf-8")
    teams = re.findall(r'id: (\d+), tricode: "(\w+)", city: "[^"]+", name: "([^"]+)"', catalog)
    east = {"ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DET", "IND", "MIA", "MIL", "NYK", "ORL", "PHI", "TOR", "WAS"}
    rows = []
    for region in ("East", "West"):
        clubs = [(team_id, code, name) for team_id, code, name in teams if (code in east) == (region == "East")]
        for rank, (team_id, code, name) in enumerate(clubs, 1):
            wins, losses = 60 - rank, 22 + rank
            rows.append({"teamId": int(team_id), "tricode": code, "name": name, "conference": region,
                         "rank": rank, "wins": wins, "losses": losses, "winPct": wins / 82, "gamesBehind": None})
    assert len(rows) == 30
    return {"season": "2026-27", "source": "ESPN", "sourceAt": None, "fetchedAt": fixtures._now_iso(),
            "state": "ready", "stale": False, "teams": rows}


class SeasonApi(fixtures.Api):
    def __init__(self) -> None:
        super().__init__(all_final=True, list_count=3)
        self.standings = standings_fixture()
        self.fail_standings = False
        self.games = fixtures.list_games(all_final=True, count=3)
        for game, game_id, stage, label in zip(self.games,
                ("0012600001", "0022600001", "0042600104"),
                ("preseason", "regular-season", "playoffs"), ("季前赛", "常规赛", "季后赛")):
            game.update(id=game_id, stage=stage, label=label, series=None)
            game["home"]["record"] = game["away"]["record"] = "99-99"
        self.games[2]["series"] = {"homeWins": 1, "awayWins": 2, "gameNumber": 4, "round": "首轮", "source": "schedule"}

    def handle(self, route) -> None:
        path = urlparse(route.request.url).path
        if path == "/api/standings":
            if self.fail_standings:
                route.fulfill(status=502, json={"error": "test failure"})
            else:
                route.fulfill(json=self.standings)
        elif path == "/api/games":
            route.fulfill(json={"date": fixtures.SOURCE_DATE, "games": self.games, "freshness": fixtures._freshness_full()})
        elif path.startswith("/api/games/") and not path.endswith("/plays"):
            game_id = path.split("/")[3]
            game = next(game for game in self.games if game["id"] == game_id)
            detail = fixtures.detail_extreme()
            detail.update(copy.deepcopy(game))
            route.fulfill(json={"game": detail, "freshness": fixtures._freshness_full()})
        else:
            super().handle(route)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:3210")
    args = parser.parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    results = []
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        for width in (320, 360, 430):
            api = SeasonApi()
            context = browser.new_context(viewport={"width": width, "height": 860}, locale="zh-CN", timezone_id="Asia/Shanghai", service_workers="block")
            fixtures.install_routes(context, api)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(args.base_url + "/")
            page.wait_for_load_state("networkidle")
            page.get_by_test_id("game-stage").first.wait_for()
            assert page.get_by_test_id("game-stage").all_text_contents() == ["季前赛", "常规赛", "季后赛"]
            assert "99-99" not in page.inner_text("body")
            assert page.get_by_label("季后赛系列赛大比分", exact=True).count() == 1
            assert page.get_by_label(re.compile("常规赛西部第")).count() > 0
            # Hidden scores also hide records and the final series result.
            page.get_by_role("button", name="隐藏已结束比赛的比分", exact=True).click()
            assert page.get_by_label("季后赛系列赛大比分", exact=True).count() == 0
            assert page.get_by_label(re.compile("常规赛西部第")).count() == 0
            page.get_by_role("button", name="关闭隐藏比分", exact=True).click()
            page.screenshot(path=str(ARTIFACTS / f"games-{width}.png"), full_page=True)
            # A real card entry retains the normal detail/list navigation.
            page.locator('a[href="/game?id=0042600104"]').click()
            page.get_by_role("button", name="返回全部比赛", exact=True).wait_for()
            page.get_by_label("季后赛系列赛大比分", exact=True).wait_for()
            page.evaluate("window.__nbaHandleNativeBack()")
            page.wait_for_url(re.compile(r"/$"))
            page.get_by_role("link", name="排名", exact=True).click()
            table = page.get_by_role("table", name="东部常规赛球队排名", exact=True)
            table.wait_for()
            assert table.locator("tbody tr").count() == 15
            assert table.locator("tbody tr td:first-child").all_text_contents() == [str(i) for i in range(1, 16)]
            page.get_by_role("tab", name="西部", exact=True).click()
            table = page.get_by_role("table", name="西部常规赛球队排名", exact=True)
            assert table.locator("tbody tr").count() == 15
            assert "湖人" in table.inner_text()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(ARTIFACTS / f"standings-{width}.png"), full_page=True)
            # Browser font enlargement is a layout check, not Android text zoom.
            page.add_style_tag(content="html { font-size: 20.8px !important; }")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(ARTIFACTS / f"standings-font130-{width}.png"), full_page=True)
            api.fail_standings = True
            page.get_by_role("button", name="刷新", exact=True).click()
            page.get_by_text("更新失败，以下为上次获取的数据。", exact=True).wait_for()
            assert table.locator("tbody tr").count() == 15
            page.evaluate("window.__nbaHandleNativeBack()")
            page.wait_for_url(re.compile(r"/$"))
            assert not api.external_requests
            results.append({"width": width, "passed": True})
            context.close()
        # Preseason zeros carry no artificial ordering.
        api = SeasonApi()
        api.standings["state"] = "not-started"
        for team in api.standings["teams"]:
            team.update(rank=None, wins=0, losses=0, winPct=None)
        context = browser.new_context(viewport={"width": 360, "height": 800}, service_workers="block")
        fixtures.install_routes(context, api)
        page = context.new_page()
        page.goto(args.base_url + "/standings")
        page.wait_for_load_state("networkidle")
        assert "暂无排名" in page.inner_text("body")
        assert page.locator("tbody tr td:first-child").all_text_contents() == ["—"] * 15
        page.screenshot(path=str(ARTIFACTS / "not-started.png"), full_page=True)
        page.evaluate("window.__nbaHandleNativeBack()")
        page.wait_for_url(re.compile(r"/$"))
        context.close()
        browser.close()
    assert not errors, errors
    (ARTIFACTS / "results.json").write_text(json.dumps({"fixtureData": True, "physicalDevice": False, "viewports": results, "notStarted": True, "pageErrors": errors}, indent=2), encoding="utf-8")
    print("PASS: stages, regular records, playoff series, spoiler handling, 30 standings, navigation, stale data and mobile layouts")


if __name__ == "__main__":
    main()
