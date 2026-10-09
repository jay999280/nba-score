"""Regenerates the manifest screenshots (public/screenshots/).

Chrome shows these in the richer install dialog, so the preview looks like an
app listing instead of a bare "add to home screen" strip. Sizes must match
what the manifest declares (780x1688 = 390x844 at DPR 2).

Run against a production build:  pnpm build && pnpm start --port 3100
Then:                           python scripts/capture_screenshots.py
Finally rebuild once:           pnpm build
(`next start` fixes its list of public files at build time, so brand-new
screenshots 404 until the next build.)
"""

import os
import sys

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = os.environ.get("SCREENSHOT_BASE", "http://127.0.0.1:3100")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "screenshots")
CHROMIUM = os.path.expandvars(
    r"%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1223\chrome-headless-shell-win64\chrome-headless-shell.exe"
)

# A finished game: immutably present in the schedule, so the capture is
# reproducible on any day.
DETAIL_GAME = "0012600004"

os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROMIUM)
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
    )
    page = ctx.new_page()

    # ---- home: step back through dates until a slate with games shows -------
    page.goto(BASE, wait_until="networkidle", timeout=180_000)
    page.wait_for_timeout(2500)
    for _ in range(7):
        if page.locator('main a[href^="/game/"]').count() > 0:
            break
        page.get_by_label("前一天").click()
        page.wait_for_timeout(2000)

    cards = page.locator('main a[href^="/game/"]').count()
    if cards == 0:
        print("WARNING: no games found for any recent date; home shot will be an empty state")
    else:
        print(f"home slate: {cards} cards")

    page.screenshot(path=os.path.join(OUT, "home.png"))
    print("wrote public/screenshots/home.png")

    # ---- detail: the score header plus the first tab -----------------------
    page.goto(f"{BASE}/game/{DETAIL_GAME}", wait_until="networkidle", timeout=120_000)
    page.wait_for_timeout(2500)
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, "detail.png"))
    print("wrote public/screenshots/detail.png")

    browser.close()

# Report real dimensions so a manifest mismatch is impossible to miss.
try:
    from PIL import Image

    for name in ("home.png", "detail.png"):
        with Image.open(os.path.join(OUT, name)) as image:
            print(f"{name}: {image.size[0]}x{image.size[1]}")
except ImportError:
    pass
