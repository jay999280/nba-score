"""Committed browser regression for the paths that only a real browser proves.

Run it:

    python tests/browser/run.py                 # starts its own dev server
    pnpm test:browser                           # same thing
    python tests/browser/run.py --base-url http://127.0.0.1:3100
    python tests/browser/run.py --only r3       # one case (substring match)

What this suite is: a headless Chromium run against the project's own dev
server, with every `/api/**` answer replaced by the hand-written mock data in
`fixtures.py`. No request leaves the machine — a request to anything but the
local dev server is aborted and recorded, and the run fails if one appears.

What it is **not**: Android/WebView verification, a real NBA network check, or
a real service-worker offline test. The offline case feeds the service worker's
marker headers to the client through the fixture layer, which proves the
client's handling of a cache hit; it does not prove that `public/sw.js` serves
one (that needs a production build and a real offline navigation). See
`tests/browser/README.md` for the honest coverage table.

Why the cases are shaped the way they are:

- Every navigation reloads the document, which destroys the tab's in-memory
  state. Where a case needs "the reader was here and came back", it drives the
  real affordance (a card tap, `history.back()`) rather than seeding state the
  app would have written itself.
- Assertions are numeric where the requirement is numeric: `scrollWidth` vs
  `innerWidth`, bounding boxes vs 44px, a text range vs its cell. Screenshots
  are evidence, never the assertion.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))

import fixtures  # noqa: E402  (path set up above)

from playwright.sync_api import (  # noqa: E402
    Browser,
    BrowserContext,
    Error as PlaywrightError,
    Page,
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)

ARTIFACTS = HERE / "artifacts"
DEFAULT_PORT = 3210
DEFAULT_VIEWPORT = {"width": 390, "height": 844}
#: First paint in a cold dev server compiles the whole route, so the very first
#: navigation gets its own, much larger budget.
WARMUP_TIMEOUT_MS = 120_000
NAV_TIMEOUT_MS = 45_000
UI_TIMEOUT_MS = 15_000
#: How long a restore may keep writing after the reader changed day or filter.
#: React commits the new URL before the effect that cancels the loop runs, so a
#: couple of frames of writes inside this window are the framework's latency; a
#: restore that *survived* the switch would write for the rest of its 8s window.
SWITCH_GRACE_MS = 600

#: Requests to anything but the local dev server, across every context.
EXTERNAL_REQUESTS: list[dict[str, str]] = []
#: How many `/api/**` calls the fixtures answered, per case.
FIXTURE_HITS: dict[str, int] = {}


# --------------------------------------------------------------------------
# Small reporting helpers
# --------------------------------------------------------------------------

@dataclass
class CaseResult:
    """One named case, its checks, and whatever the run should remember."""

    name: str
    title: str
    status: str = "FAIL"
    duration_ms: int = 0
    checks: list[dict[str, Any]] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)
    screenshots: list[str] = field(default_factory=list)
    console: list[str] = field(default_factory=list)
    page_errors: list[str] = field(default_factory=list)
    error: str | None = None

    def check(self, ok: bool, label: str, **detail: Any) -> bool:
        entry: dict[str, Any] = {"label": label, "ok": bool(ok)}
        entry.update(detail)
        self.checks.append(entry)
        return bool(ok)

    def record(self, **values: Any) -> None:
        self.data.update(values)


def log(message: str) -> None:
    print(message, flush=True)


# --------------------------------------------------------------------------
# Dev server: reuse if something already answers, otherwise start one
# --------------------------------------------------------------------------

def http_status(url: str, timeout: float = 3.0) -> int | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 (local URL)
            return int(response.status)
    except urllib.error.HTTPError as error:
        return int(error.code)
    except Exception:
        return None


def dev_command(port: int) -> list[str]:
    """The command that `pnpm dev` runs, with an explicit port.

    `node <next bin> dev` is used directly when possible: it is one process, so
    a tree kill is unambiguous, and it avoids Windows' `.cmd` shim rules.
    """
    node = shutil.which("node")
    next_bin = REPO / "node_modules" / "next" / "dist" / "bin" / "next"
    if node and next_bin.exists():
        return [node, str(next_bin), "dev", "--port", str(port)]

    pnpm = shutil.which("pnpm")
    if pnpm:
        comspec = os.environ.get("COMSPEC", "cmd.exe")
        return [comspec, "/d", "/s", "/c", pnpm, "exec", "next", "dev", "--port", str(port)]
    raise RuntimeError("neither `node` + node_modules/next nor `pnpm` is available")


class DevServer:
    """Owns the dev server this run started, and only that one."""

    def __init__(self, base_url: str, process: subprocess.Popen[bytes], mode: str) -> None:
        self.base_url = base_url
        self.process = process
        self.mode = mode

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(self.process.pid)],
                capture_output=True,
                check=False,
            )
        else:
            self.process.terminate()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()


def app_ready(base_url: str, timeout: float = 5.0) -> bool:
    """Does this base URL answer, and does it look like this app?"""
    try:
        with urllib.request.urlopen(base_url + "/", timeout=timeout) as response:  # noqa: S310
            body = response.read(200_000).decode("utf-8", "replace")
            return response.status == 200 and ("NBA" in body or "nba" in body)
    except Exception:
        return False


def wait_for_app(base_url: str, *, timeout: float) -> bool:
    """Wait until the base URL answers *and* looks like this app."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if app_ready(base_url):
            return True
        time.sleep(0.5)
    return False


def ensure_server(args: argparse.Namespace) -> tuple[str, DevServer | None, dict[str, Any]]:
    """Resolve the base URL, starting a dev server only when it is needed."""
    if args.base_url:
        base = args.base_url.rstrip("/")
        if not wait_for_app(base, timeout=20):
            raise SystemExit(f"[harness] --base-url {base} does not answer with the app")
        return base, None, {"mode": "external", "url": base, "note": "--base-url was given"}

    port = args.port
    base = f"http://127.0.0.1:{port}"
    if http_status(base + "/") is not None:
        return base, None, {"mode": "reused", "url": base, "note": f"port {port} was already serving"}

    log_path = ARTIFACTS / "dev-server.log"
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    command = dev_command(port)
    log(f"[harness] starting dev server: {' '.join(command)}")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with open(log_path, "wb") as sink:
        process = subprocess.Popen(command, cwd=str(REPO), stdout=sink, stderr=subprocess.STDOUT, creationflags=flags)
    atexit.register(DevServer("", process, "started").stop)

    # Watch the port *and* the process: a refused start exits in about a second,
    # and there is no point waiting out the whole timeout for a dead process.
    started: DevServer | None = None
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        if app_ready(base):
            # It answered — but only trust that if it is still alive.
            if process.poll() is None:
                started = DevServer(base, process, "started")
            break
        time.sleep(0.5)

    if started is not None:
        return base, started, {"mode": "started", "url": base, "pid": process.pid, "log": str(log_path)}

    # Next 16 refuses to run two dev servers in one project directory. When the
    # server already there is serving *this* working tree, the honest move is to
    # run against it and say so, not to kill somebody else's server.
    tail = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    marker = "Another next dev server is already running"
    section = tail[tail.find(marker):] if marker in tail else ""
    # Only the `Local:` line *inside* that message counts: the failed attempt
    # prints its own `Local:` line just above it.
    existing = re.search(r"Local:\s+(https?://[^\s]+)", section) if section else None
    served_dir = re.search(r"Dir:\s+(.+)", section) if section else None

    if existing and not args.no_reuse:
        fallback = existing.group(1).rstrip("/")
        same_tree = bool(served_dir) and Path(served_dir.group(1).strip()).resolve() == REPO
        if not same_tree:
            raise SystemExit(
                "[harness] another dev server holds this project's .next/dev lock but reports "
                f"Dir: {served_dir.group(1).strip() if served_dir else '?'} — refusing to reuse it.\n"
                "Stop it, or pass --base-url to say explicitly which server to test."
            )
        log(f"[harness] another dev server already serves this tree; reusing {fallback}")
        if wait_for_app(fallback, timeout=30):
            return (
                fallback,
                None,
                {
                    "mode": "reused-existing-dev-server",
                    "url": fallback,
                    "note": "Next refuses a second dev server in one directory; the existing one serves this same working tree",
                    "log": str(log_path),
                },
            )

    raise SystemExit(f"[harness] dev server did not come up on {base}.\n--- log tail ---\n{tail[-3000:]}")


# --------------------------------------------------------------------------
# Browser helpers
# --------------------------------------------------------------------------

def new_context(
    browser: Browser,
    api: fixtures.Api,
    *,
    viewport: dict[str, int] | None = None,
    service_workers: str = "block",
    favorites: tuple[int, ...] | None = fixtures.FOLLOWED,
    theme: str | None = None,
    sampler: bool = False,
) -> tuple[BrowserContext, Page]:
    context = browser.new_context(
        viewport=viewport or dict(DEFAULT_VIEWPORT),
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
        service_workers=service_workers,
        reduced_motion="reduce",
        device_scale_factor=1,
    )
    context.set_default_timeout(UI_TIMEOUT_MS)
    fixtures.install_routes(context, api)
    page = context.new_page()
    if favorites is not None or theme is not None:
        page.add_init_script(fixtures.local_storage_seed(favorites=favorites or (), theme=theme))
    if sampler:
        page.add_init_script(SCROLL_SAMPLER)
    return context, page


def attach_logging(page: Page, case: CaseResult) -> None:
    page.on(
        "console",
        lambda message: case.console.append(f"{message.type}: {message.text}"[:300])
        if message.type in ("error", "warning")
        else None,
    )
    page.on("pageerror", lambda error: case.page_errors.append(str(error)[:400]))


def close_context(context: BrowserContext, api: fixtures.Api, case: CaseResult, page: Page | None = None) -> None:
    """Record what this context did, photograph a failure, and close it.

    The screenshot is taken here rather than in the caller because this is the
    last moment the page still exists: a case that failed a check — or that blew
    up mid-way — would otherwise leave no picture of where it got stuck.
    `sys.exc_info()` still reports the in-flight exception while a `finally`
    block unwinds, which is exactly the case that needs the widest screenshot.
    """
    failing = sys.exc_info()[0] is not None or any(not check["ok"] for check in case.checks)
    if page is not None and failing:
        shoot(page, case, "FAIL")
    for url in api.external_requests:
        EXTERNAL_REQUESTS.append({"case": case.name, "url": url})
    FIXTURE_HITS[case.name] = FIXTURE_HITS.get(case.name, 0) + len(api.requests)
    context.close()


def shoot(page: Page, case: CaseResult, label: str) -> str:
    path = ARTIFACTS / f"{case.name}-{label}.png"
    try:
        page.screenshot(path=str(path))
        case.screenshots.append(str(path.relative_to(REPO)))
    except PlaywrightError as error:  # a page that crashed cannot be photographed
        case.console.append(f"screenshot failed: {error}"[:200])
    return str(path)


def goto(page: Page, url: str, *, wait_until: str = "domcontentloaded", timeout: int = NAV_TIMEOUT_MS) -> None:
    page.goto(url, wait_until=wait_until, timeout=timeout)


def wait_js(page: Page, expression: str, *, arg: Any = None, timeout: int = UI_TIMEOUT_MS) -> None:
    page.wait_for_function(expression, arg=arg, timeout=timeout)


def settle(page: Page, milliseconds: int = 250) -> None:
    page.wait_for_timeout(milliseconds)


def js(page: Page, expression: str, arg: Any = None) -> Any:
    return page.evaluate(expression, arg) if arg is not None else page.evaluate(expression)


def wait_games(page: Page, minimum: int = 1, *, timeout: int = NAV_TIMEOUT_MS) -> int:
    page.wait_for_function(
        "(minimum) => document.querySelectorAll('main a[href^=\"/game\"]').length >= minimum",
        arg=minimum,
        timeout=timeout,
    )
    return int(js(page, "() => document.querySelectorAll('main a[href^=\"/game\"]').length"))


def open_tab(page: Page, label: str) -> None:
    page.get_by_role("tab", name=label, exact=True).click()
    settle(page, 300)


DETAIL_TABS = "() => !!document.querySelector('[role=\"tablist\"][aria-label=\"比赛详情\"]')"


def wait_detail(page: Page, *, timeout: int = NAV_TIMEOUT_MS) -> None:
    page.wait_for_function(DETAIL_TABS, timeout=timeout)
    settle(page, 200)


PREGAME_VIEW = (
    "() => document.body.innerText.includes('VS') && document.body.innerText.includes('离开赛')"
)


def wait_pre_game(page: Page, *, timeout: int = NAV_TIMEOUT_MS) -> None:
    """Before tip-off the page has no tab list at all: it opens on the pre-game view."""
    page.wait_for_function(PREGAME_VIEW, timeout=timeout)
    settle(page, 200)


def url_parts(page: Page) -> dict[str, str]:
    return js(
        page,
        """() => {
            const params = new URLSearchParams(location.search);
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            return { href: location.href, path: location.pathname, search: location.search,
                     date: params.get('date') ?? '',
                     fav: params.get('fav') ?? '',
                     id: params.get('id') ?? '',
                     today: `${d.getMonth() + 1}-${d.getDate()}`,
                     receiveLabel: `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}` };
        }""",
    )


# --------------------------------------------------------------------------
# JavaScript probes
# --------------------------------------------------------------------------

#: Patches history at document start, so every call the app (or Next) makes is
#: visible — including the ones that happen during hydration.
HISTORY_PROBE = """
(() => {
  if (window.__dshHist) return;
  window.__dshHist = [];
  const stringify = (value) => { try { return JSON.stringify(value); } catch (e) { return "unserializable"; } };
  const here = () => location.pathname + location.search;
  const log = (op, url, state) => window.__dshHist.push({
    op, url: url === undefined || url === null || url === "" ? here() : String(url),
    // For pushState/replaceState the interesting state is the *argument*: reading
    // `history.state` before the call would report the previous entry.
    state: state === undefined ? stringify(window.history.state) : stringify(state),
    length: window.history.length, at: Math.round(performance.now()),
  });
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const back = history.back.bind(history);
  const forward = history.forward.bind(history);
  history.pushState = (s, t, u) => { log("pushState", u, s); return push(s, t, u); };
  history.replaceState = (s, t, u) => { log("replaceState", u, s); return replace(s, t, u); };
  history.back = () => { log("back", here(), undefined); return back(); };
  history.forward = () => { log("forward", here(), undefined); return forward(); };
  window.__dshHistClear = () => { window.__dshHist.length = 0; };
  window.__dshHistOps = () => window.__dshHist.map((entry) => entry.op);
})();
"""

#: Geometry of the player table, measured — not eyeballed.
BOX_METRICS = """
() => {
  const R = (el) => { const r = el.getBoundingClientRect();
    return { top: r.top, right: r.right, left: r.left, bottom: r.bottom, width: r.width, height: r.height }; };
  const TB = (el) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect();
    return { left: b.left, right: b.right, width: b.width }; };
  const cellOf = (td) => td ? ({ value: td.innerText.trim(), box: R(td), textBox: TB(td),
    scrollWidth: td.scrollWidth, clientWidth: td.clientWidth }) : null;
  const table = document.querySelector("table");
  const out = {
    viewport: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    table: table ? R(table) : null,
    tableCount: document.querySelectorAll("table").length,
    headerCells: [], rows: [], plusMinus: [], rowCount: 0,
    controls: { switchTabs: [], sortButtons: [], nameButtons: [] },
    thead: null,
  };
  if (!table) return out;
  out.headerCells = [...table.querySelectorAll("thead th")].map((th) => th.innerText.trim());
  const thead = table.querySelector("thead");
  if (thead) out.thead = { position: getComputedStyle(thead).position, ...R(thead) };
  const rows = [...table.querySelectorAll("tbody tr")].filter((tr) => tr.querySelector('button[aria-expanded]'));
  out.rowCount = rows.length;
  const KEYS = ["minutes", "points", "rebounds", "assists", "fg", "threePt", "pm"];
  out.rows = rows.slice(0, 8).map((tr) => {
    const tds = [...tr.querySelectorAll("td")];
    const button = tr.querySelector('button[aria-expanded]');
    const span = button ? button.querySelector("span") : null;
    const row = {
      name: button ? button.innerText.trim() : null,
      nameButton: button ? { ...R(button), expanded: button.getAttribute("aria-expanded") } : null,
      nameTruncated: span ? span.scrollWidth > span.clientWidth + 1 : null,
      nameCell: cellOf(tds[0]),
    };
    KEYS.forEach((key, index) => { row[key] = cellOf(tds[index + 1]); });
    return row;
  });
  out.plusMinus = rows.map((tr) => {
    const tds = tr.querySelectorAll("td");
    return tds.length ? tds[tds.length - 1].innerText.trim() : null;
  }).filter((value) => value !== null);
  const switchRoot = document.querySelector('[role="tablist"][aria-label="选择球队"]');
  out.controls.switchTabs = switchRoot
    ? [...switchRoot.querySelectorAll('[role="tab"]')].map((el) => ({ text: el.innerText.trim(), ...R(el) }))
    : [];
  const sortRoot = document.querySelector('[role="group"][aria-label="球员排序"]');
  out.controls.sortButtons = sortRoot
    ? [...sortRoot.querySelectorAll("button")].map((el) => ({ text: el.innerText.trim(),
        pressed: el.getAttribute("aria-pressed"), ...R(el) }))
    : [];
  out.controls.nameButtons = rows.slice(0, 6).map((tr) => {
    const button = tr.querySelector('button[aria-expanded]');
    return button ? { text: button.innerText.trim(), ...R(button) } : null;
  }).filter(Boolean);
  return out;
}
"""

STICKY_METRICS = """
() => {
  const thead = document.querySelector("thead");
  if (!thead) return null;
  const box = thead.getBoundingClientRect();
  const rows = [...document.querySelectorAll("tbody tr")].filter((tr) => tr.querySelector('button[aria-expanded]'));
  const below = rows.filter((tr) => tr.getBoundingClientRect().top > box.bottom).length;
  return { top: box.top, bottom: box.bottom, position: getComputedStyle(thead).position,
           scrollY: window.scrollY, rowsBelowHeader: below };
}
"""

NOTICE_TEXT = """
() => {
  const nodes = [...document.querySelectorAll('[role="status"]')];
  if (nodes.length === 0) return { count: 0, text: null, sourceSegment: null };
  const text = nodes[0].innerText;
  const match = /来源时间\\s*([^\\n·]+)/.exec(text);
  return { count: nodes.length, text, sourceSegment: match ? match[1].trim() : null };
}
"""

# --------------------------------------------------------------------------
# Probes for the return-identity cases (B1/B2 in the round-2 review)
# --------------------------------------------------------------------------

#: Samples `scrollY` on every frame from document start, forces the browser's own
#: restoration off *before* the app runs, and records every `scrollTo` the page
#: makes.
#:
#: All three halves matter. The samples catch a restore that happens in the first
#: frames after paint, which a single read after `load` can miss; forcing
#: `scrollRestoration = "manual"` at document start means a measured offset can
#: only have been written by the app's own loop — a case cannot pass on
#: Chromium's built-in history restoration instead of the behaviour under test;
#: and the call log is what separates "the offset was left where it was" from
#: "the restore loop is still writing it", which no sample of `scrollY` can tell
#: apart when both end at the same number.
SCROLL_SAMPLER = """
(() => {
  try { history.scrollRestoration = 'manual'; } catch (e) {}
  window.__dshScrollSamples = [];
  window.__dshScrollCalls = [];
  const originalTo = window.scrollTo.bind(window);
  window.scrollTo = (...args) => {
    window.__dshScrollCalls.push({
      at: Math.round(performance.now()),
      args: JSON.stringify(args),
      scrollY: Math.round(window.scrollY),
    });
    return originalTo(...args);
  };
  const t0 = performance.now();
  const tick = () => {
    const elapsed = performance.now() - t0;
    window.__dshScrollSamples.push([Math.round(elapsed), Math.round(window.scrollY)]);
    if (elapsed < 15000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
"""

#: Every sessionStorage entry, keyed by name. The identity records this suite is
#: about are exactly the keys the app owns, so the dump is what lets a case say
#: "the receipt is gone" instead of "the offset looked right".
SESSION_DUMP = """
() => {
  const out = {};
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      out[key] = sessionStorage.getItem(key);
    }
  } catch (error) { out.__error = String(error); }
  return out;
}
"""

#: Our own marking on the *current* history entry, if any. A list entry a card
#: was opened from carries `nbascoreListEntry`; the detail entry never does.
ENTRY_STATE = """
() => {
  const state = history.state;
  if (!state || typeof state !== 'object') return null;
  const entry = state.nbascoreListEntry;
  return entry === undefined ? null : entry;
}
"""

#: Our own marking on the *detail* history entry, if any.
#:
#: This is the navigation evidence a card tap leaves behind: it is written onto
#: the entry the tap pushed, so it survives a reload of that entry (the browser
#: keeps the entry's state) but is never carried into a new document — a copied
#: `sessionStorage` cannot reproduce it, and a fresh navigation has no state at
#: all. The list entry's field (`nbascoreListEntry`) is the mirror image of it.
DETAIL_ENTRY_STATE = """
() => {
  const state = history.state;
  if (!state || typeof state !== 'object') return null;
  return state.nbascoreDetailEntry ?? null;
}
"""

#: Records every write to `history.scrollRestoration`, with the value that was in
#: effect before it, and counts the page's own `scrollTo` calls — **without**
#: forcing the mode, so a case can watch the app take the entry's restore mode
#: over and hand it back. The sampler above deliberately does the opposite
#: (forces `manual` before the app boots) for the offset cases.
RESTORE_TRACE = """
(() => {
  window.__dshScrollCalls = [];
  const originalTo = window.scrollTo.bind(window);
  window.scrollTo = (...args) => {
    window.__dshScrollCalls.push({ at: Math.round(performance.now()), args: JSON.stringify(args) });
    return originalTo(...args);
  };
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(history), 'scrollRestoration');
  window.__dshRestoration = [];
  if (!descriptor) return;
  window.__dshRestorationBefore = descriptor.get.call(history);
  Object.defineProperty(history, 'scrollRestoration', {
    configurable: true,
    get() { return descriptor.get.call(history); },
    set(value) {
      window.__dshRestoration.push({
        at: Math.round(performance.now()), value, before: descriptor.get.call(history),
        url: location.pathname + location.search,
      });
      descriptor.set.call(history, value);
    },
  });
})();
"""

#: How much of a player's name is actually on screen, next to the column budget.
#:
#: `visibleChars` is measured, not guessed: the name's text box divided by its
#: character count gives the advance of one character at the size it is rendered
#: at, and the column's own width divided by that is how many characters fit.
#: The fixture's long name is Chinese, so its characters are uniform width — the
#: estimate is what a reader sees, and it is compared against a floor rather than
#: a pixel-perfect count.
NAME_COLUMN = """
() => {
  const table = document.querySelector('table');
  if (!table) return null;
  const buttons = [...table.querySelectorAll('tbody td button[aria-expanded]')];
  if (!buttons.length) return null;
  const button = buttons.reduce((longest, candidate) =>
    candidate.innerText.trim().length > longest.innerText.trim().length ? candidate : longest);
  const span = button.querySelector('span');
  const cell = button.closest('td');
  const range = document.createRange();
  range.selectNodeContents(span);
  const text = range.getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  const size = parseFloat(getComputedStyle(button).fontSize);
  const characters = span.textContent.length;
  const advance = characters ? text.width / characters : size;
  return {
    text: span.textContent,
    fontSize: size,
    cellWidth: Math.round(box.width * 10) / 10,
    cellLeft: Math.round(box.left * 10) / 10,
    cellRight: Math.round(box.right * 10) / 10,
    textWidth: Math.round(text.width * 10) / 10,
    advance: Math.round(advance * 100) / 100,
    visibleChars: Math.max(0, Math.floor((box.width - 2) / (advance || size))),
    clipped: span.scrollWidth > span.clientWidth + 1,
  };
}
"""

#: A card that is fully on screen right now, with its click point.
#:
#: Playwright scrolls a target into view before clicking, so a tap on a card at
#: the top of the list would drag the page back to y=0 and make the recorded
#: position meaningless. Clicking by coordinate is how a reader actually taps.
VISIBLE_CARD = """
() => {
  const cards = [...document.querySelectorAll('main a[href^="/game"]')];
  const usable = cards.find((card) => {
    const box = card.getBoundingClientRect();
    return box.top > 80 && box.bottom < window.innerHeight - 20;
  });
  if (!usable) return null;
  const box = usable.getBoundingClientRect();
  return {
    href: usable.getAttribute('href'),
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    top: Math.round(box.top),
    bottom: Math.round(box.bottom),
  };
}
"""

#: Applies one font-size proxy and reports what it actually did.
#:
#: `root` scales the document's root font-size (the closest local analogue of a
#: system font-scale setting); `table` is the round-2 acceptance report's proxy —
#: a style tag forcing the table's own text to 17px/18px. Neither is Android
#: system font scaling, and the README says so.
FONT_PROXY = """
({ mode, px }) => {
  document.documentElement.style.fontSize = '';
  const previous = document.getElementById('dsh-font-proxy');
  if (previous) previous.remove();
  if (mode === 'root' && px) {
    document.documentElement.style.fontSize = px + 'px';
  } else if (mode === 'table' && px) {
    const style = document.createElement('style');
    style.id = 'dsh-font-proxy';
    style.textContent =
      `#panel-box table td, #panel-box table th, #panel-box table td button { font-size: ${px}px !important; }`;
    document.head.appendChild(style);
  }
  const cell = document.querySelector('#panel-box table td.tnum');
  return {
    rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
    cellFontPx: cell ? parseFloat(getComputedStyle(cell).fontSize) : null,
    proxyAttached: !!document.getElementById('dsh-font-proxy'),
  };
}
"""

#: One full audit of the player table's numeric columns.
#:
#: Every numeric cell is judged against *its own* box, so a fix that re-lays-out
#: the columns (narrower px, em/rem units, an in-table scroller) is measured on
#: the property the requirement is about. Three failures are collected:
#:
#:   `outside`  the cell's text range leaves the cell;
#:   `capacity` the column is narrower than the text it is showing;
#:   `clip`     the cell scrolls sideways (content hidden instead of laid out).
#:
#: Adjacent numeric cells whose text ranges collide are collected separately:
#: two neighbouring numbers touching is the visible symptom the review reported
#: ("时间与得分粘连"), and it is independent of how scrollWidth is reported for
#: table cells.
BOX_COLUMN_AUDIT = """
() => {
  const box = (el) => { const r = el.getBoundingClientRect();
    return { top: r.top, right: r.right, left: r.left, bottom: r.bottom, width: r.width, height: r.height }; };
  const textBox = (el) => { const range = document.createRange(); range.selectNodeContents(el);
    const r = range.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
  const table = document.querySelector('table');
  if (!table) return { error: 'no table' };
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.innerText.trim());
  const rows = [...table.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('button[aria-expanded]'));
  const offenders = [];
  const overlaps = [];
  const names = [];
  const values = [];
  let cellFont = null;
  rows.forEach((tr, rowIndex) => {
    const cells = [...tr.querySelectorAll('td')].slice(1);
    const button = tr.querySelector('button[aria-expanded]');
    const name = button ? button.innerText.trim() : `row-${rowIndex}`;
    names.push(name);
    let previous = null;
    cells.forEach((td, index) => {
      const value = td.innerText.trim();
      values.push(value);
      const fb = box(td);
      const ft = textBox(td);
      const font = parseFloat(getComputedStyle(td).fontSize);
      if (cellFont === null) cellFont = font;
      const record = { row: name, column: headers[index + 1] ?? `#${index + 1}`, value,
                       fontPx: font, textLeft: +ft.left.toFixed(2), textRight: +ft.right.toFixed(2),
                       textWidth: +ft.width.toFixed(2), cellLeft: +fb.left.toFixed(2),
                       cellRight: +fb.right.toFixed(2), cellWidth: +fb.width.toFixed(2),
                       scrollWidth: td.scrollWidth, clientWidth: td.clientWidth };
      if (ft.left < fb.left - 0.5 || ft.right > fb.right + 0.5) offenders.push({ kind: 'outside', ...record });
      else if (ft.width > fb.width + 0.5) offenders.push({ kind: 'capacity', ...record });
      else if (td.scrollWidth > td.clientWidth + 1) offenders.push({ kind: 'clip', ...record });
      if (previous && previous.textRight > ft.left + 0.5) {
        overlaps.push({ row: name, left: previous.column, right: record.column,
                        leftRight: +previous.textRight.toFixed(2), rightLeft: +record.textLeft.toFixed(2),
                        leftValue: previous.value, rightValue: value });
      }
      previous = { column: record.column, textRight: ft.right, value };
    });
  });
  const scrollerOf = (el) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/^(auto|scroll)$/.test(style.overflowX)) {
        return { tag: node.tagName, overflowX: style.overflowX, clientWidth: node.clientWidth,
                 scrollWidth: node.scrollWidth, box: box(node) };
      }
      node = node.parentElement;
    }
    return null;
  };
  const tableBox = box(table);
  return {
    viewport: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
    cellFontPx: cellFont,
    headers,
    rowCount: rows.length,
    names,
    values,
    table: tableBox,
    tableInsideViewport: tableBox.left >= -0.5 && tableBox.right <= window.innerWidth + 0.5,
    scroller: scrollerOf(table),
    offenders,
    overlaps,
  };
}
"""


# --------------------------------------------------------------------------
# Helpers for the return-identity cases
# --------------------------------------------------------------------------

#: Any game card, whichever build target produced the href: `/game?id=` on the
#: dev server, `/game/?id=` in the static export (`trailingSlash`).
GAME_CARD = 'main a[href^="/game"]'


def wait_cards(page: Page, minimum: int = 1, *, timeout: int = NAV_TIMEOUT_MS) -> int:
    page.wait_for_function(
        "(minimum) => document.querySelectorAll('main a[href^=\"/game\"]').length >= minimum",
        arg=minimum,
        timeout=timeout,
    )
    return int(js(page, "() => document.querySelectorAll('main a[href^=\"/game\"]').length"))


def game_id_of(href: str) -> str:
    """The `id` of a card href, without caring where the query sits in the path."""
    match = re.search(r"[?&]id=([^&]+)", href or "")
    return match.group(1) if match else ""


def scroll_samples(page: Page) -> list[list[int]]:
    return js(page, "() => (window.__dshScrollSamples || []).map((entry) => entry.slice())")


def scroll_calls(page: Page) -> list[dict[str, Any]]:
    """Every `window.scrollTo` the page made, in order (needs the sampler)."""
    return js(page, "() => (window.__dshScrollCalls || []).map((entry) => ({ ...entry }))")


def samples_after(samples: list[list[int]], index: int) -> list[int]:
    """The `scrollY` values recorded from sample `index` onwards."""
    return [entry[1] for entry in samples[index:]]


def max_after(samples: list[list[int]], index: int) -> int:
    values = samples_after(samples, index)
    return max(values) if values else 0


def min_after(samples: list[list[int]], index: int) -> int:
    values = samples_after(samples, index)
    return min(values) if values else 0


def session_dump(page: Page) -> dict[str, Any]:
    return js(page, SESSION_DUMP)


def entry_state(page: Page) -> dict[str, Any] | None:
    return js(page, ENTRY_STATE)


def detail_entry_state(page: Page) -> dict[str, Any] | None:
    """The tap evidence on the *detail* entry, if this entry carries any."""
    return js(page, DETAIL_ENTRY_STATE)


def detail_receipt(page: Page) -> dict[str, Any] | None:
    """The session copy a card tap wrote, as the detail page reads it."""
    return js(
        page,
        "() => { const raw = sessionStorage.getItem('nbascore:detailOrigin');"
        " try { return raw ? JSON.parse(raw) : null; } catch (error) { return null; } }",
    )


def scroll_to(page: Page, target: int, *, settle_ms: int = 400) -> dict[str, int]:
    result = js(
        page,
        """(target) => {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            window.scrollTo(0, target);
            return { max: Math.round(max), target, actual: Math.round(window.scrollY) };
        }""",
        arg=target,
    )
    settle(page, settle_ms)
    result["actual"] = int(js(page, "() => Math.round(window.scrollY)"))
    return result


def tap_visible_card(page: Page) -> dict[str, Any]:
    card = js(page, VISIBLE_CARD)
    if card is None:
        raise AssertionError("no game card is fully visible at the current scroll position")
    page.mouse.click(card["x"], card["y"])
    return card


def wait_scroll(page: Page, wanted: int, *, tolerance: int = 2, timeout: int = 10_000) -> bool:
    try:
        page.wait_for_function(
            "(want) => Math.abs(window.scrollY - want) <= 2", arg=wanted, timeout=timeout
        )
        return True
    except PlaywrightTimeoutError:
        return False


def wait_url_date(page: Page, date_key: str, *, timeout: int = NAV_TIMEOUT_MS) -> None:
    page.wait_for_function(
        "(date) => new URLSearchParams(location.search).get('date') === date",
        arg=date_key,
        timeout=timeout,
    )


def unrelated_page_url(harness: "Harness") -> str:
    """A same-origin page that is not part of the app's flow.

    The review used `/manifest.webmanifest` for this: navigating there gives the
    tab a real history entry the app knows nothing about, which is what makes
    "the back control walked into it" observable.
    """
    return harness.url("/manifest.webmanifest")


def back_control(page: Page) -> None:
    page.get_by_role("button", name="返回全部比赛").click()


# --------------------------------------------------------------------------
# Cases
# --------------------------------------------------------------------------

class Harness:
    """Context object handed to every case: the browser and the base URL."""

    def __init__(self, browser: Browser, base_url: str) -> None:
        self.browser = browser
        self.base_url = base_url

    def url(self, path: str) -> str:
        return self.base_url + path


def case_r1_back_restores_list(harness: Harness, case: CaseResult) -> None:
    """R1: the visible back control returns to the source list, position intact."""
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    try:
        source = f"/?date={fixtures.SOURCE_DATE}&fav=1"
        goto(page, harness.url(source))
        cards = wait_games(page, 5)
        settle(page, 400)

        scroll = js(
            page,
            """() => {
                const max = document.documentElement.scrollHeight - window.innerHeight;
                const target = Math.round(max * 0.6);
                window.scrollTo(0, target);
                return { max, target, actual: window.scrollY };
            }""",
        )
        settle(page, 400)
        before = url_parts(page)
        before_scroll = int(js(page, "() => window.scrollY"))
        case.record(source=source, cards=cards, scroll=scroll, beforeUrl=before["href"], beforeScroll=before_scroll)
        case.check(before["date"] == fixtures.SOURCE_DATE, "the list URL carries the source date", url=before["href"])
        case.check(before["fav"] == "1", "the list URL carries the 关注 filter", url=before["href"])
        case.check(
            scroll["max"] >= 200 and before_scroll >= 150,
            "fixture slate is tall enough for scroll restoration to mean something",
            maxScroll=scroll["max"],
            scrollY=before_scroll,
        )

        # Click a card that is *already* fully on screen. Playwright scrolls a
        # target into view before clicking, and a card at the top of the list
        # would drag the page back to y=0 — which would make the position this
        # case is about unobservable. The tap must be made from here, as a
        # reader would make it, with the scroll offset untouched.
        visible_card = js(
            page,
            """() => {
                // `href^="/game"` rather than `href^="/game?id="`: the static
                // export writes `/game/?id=` (`trailingSlash`), and this case is
                // meant to be runnable against either build target.
                const cards = [...document.querySelectorAll('main a[href^="/game"]')];
                const usable = cards.find((card) => {
                    const r = card.getBoundingClientRect();
                    return r.top > 80 && r.bottom < window.innerHeight - 20;
                });
                return usable ? { href: usable.getAttribute('href'), box: (() => {
                    const r = usable.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom };
                })() } : null;
            }""",
        )
        case.record(visibleCard=visible_card, scrollBeforeTap=before_scroll)
        case.check(visible_card is not None, "a game card is fully visible at the saved position", card=visible_card)
        scroll_before_click = int(js(page, "() => window.scrollY"))
        page.locator(f'a[href="{visible_card["href"]}"]').first.click()
        wait_detail(page)
        detail = url_parts(page)
        # What the app recorded at the tap is the app's own view of the position.
        recorded = js(
            page,
            """() => { const raw = sessionStorage.getItem('nbascore:detailOrigin');
                       try { return JSON.parse(raw); } catch (e) { return null; } }""",
        )
        case.record(
            enteredDetail=detail["href"],
            recordedOrigin=recorded,
            scrollBeforeTap=scroll_before_click,
        )
        case.check("/game" in detail["href"] and detail["id"] != "", "a card tap opens the detail page", id=detail["id"])
        case.check(
            scroll_before_click == before_scroll,
            "the tap itself did not move the list (the measured position is the real one)",
            before=before_scroll,
            atTap=scroll_before_click,
        )
        case.check(
            isinstance(recorded, dict) and recorded.get("scroll") == before_scroll,
            "the app records the reading position at the tap",
            recorded=recorded,
            expected=before_scroll,
        )

        control = js(
            page,
            """() => {
                const byLabel = document.querySelector('[aria-label="返回全部比赛"]');
                const anchor = document.querySelector('a[aria-label="返回全部比赛"]');
                return { tag: byLabel ? byLabel.tagName : null, isAnchor: anchor !== null,
                         box: byLabel ? (() => { const r = byLabel.getBoundingClientRect();
                           return { width: r.width, height: r.height, top: r.top, left: r.left }; })() : null };
            }""",
        )
        case.record(backControl=control)
        case.check(control["tag"] == "BUTTON", "the back affordance is a real button, not an href=\"/\" link", tag=control["tag"])
        case.check(not control["isAnchor"], "no anchor pretends to be the back control")
        case.check(
            control["box"] is not None and control["box"]["width"] >= 44 and control["box"]["height"] >= 44,
            "the back control is at least 44x44",
            box=control["box"],
        )

        page.get_by_role("button", name="返回全部比赛").click()
        wait_games(page, 5)
        restored = True
        try:
            wait_js(page, "(want) => Math.abs(window.scrollY - want) <= 2", arg=before_scroll, timeout=10_000)
        except PlaywrightTimeoutError:
            restored = False
        after = url_parts(page)
        after_scroll = int(js(page, "() => window.scrollY"))
        date_input = js(page, "() => { const el = document.querySelector('input[type=date]'); return el ? el.value : null; }")
        case.record(afterUrl=after["href"], afterScroll=after_scroll, expectedScroll=before_scroll, dateInput=date_input)
        shoot(page, case, "restored")

        case.check(after["path"] == "/", "back returns to the home list", path=after["path"])
        case.check(after["date"] == fixtures.SOURCE_DATE, "the source date survives the return", date=after["date"])
        case.check(after["fav"] == "1", "the 关注 filter survives the return", fav=after["fav"])
        case.check(date_input == fixtures.SOURCE_DATE, "the date picker shows the source date", value=date_input)
        case.check(restored, "the reading position is restored", expected=before_scroll, actual=after_scroll)
        case.check(not case.page_errors, "no uncaught page error during the round trip", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_deep_link_lands_on_today(harness: Harness, case: CaseResult) -> None:
    """R1: a detail page opened cold has no list behind it and falls back home."""
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    try:
        goto(page, harness.url(f"/game?id={fixtures.EXTREME_ID}"))
        wait_detail(page)
        mark = js(
            page,
            """() => ({ origin: sessionStorage.getItem('nbascore:detailOrigin'),
                        view: sessionStorage.getItem('nbascore:listView') })""",
        )
        case.record(beforeClick=mark)
        case.check(mark["origin"] is None, "a cold open carries no recorded list origin", origin=mark["origin"])

        page.get_by_role("button", name="返回全部比赛").click()
        page.wait_for_function(
            "() => !!document.querySelector('input[type=date]') && !!document.querySelector('main')",
            timeout=NAV_TIMEOUT_MS,
        )
        settle(page, 600)
        after = url_parts(page)
        today = js(
            page,
            "() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');"
            " return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }",
        )
        input_value = js(page, "() => { const el = document.querySelector('input[type=date]'); return el ? el.value : null; }")
        case.record(afterUrl=after["href"], today=today, dateInput=input_value)
        shoot(page, case, "today")

        case.check(after["path"] == "/", "a deep link goes back to the home page", path=after["path"])
        case.check(after["date"] == "" and after["fav"] == "", "the fallback is today, with no stale query", search=after["search"])
        case.check(input_value == today, "the fallback list is today's date", value=input_value, today=today)
        case.check(int(js(page, "() => window.scrollY")) == 0, "the fallback starts at the top of the list")
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


# --------------------------------------------------------------------------
# Return identity (the round-2 review's B1/B2)
# --------------------------------------------------------------------------
#
# The review found the back control deciding from "there is a sessionStorage
# marker younger than 30 minutes", which is a statement about the past rather
# than a licence for *this* navigation. Six cases below pin the boundary down;
# each one drives the real affordance and asserts the records the app keeps, not
# just the scroll offset a reader could reach by accident.


def _open_list_at(harness: Harness, page: Page, *, target: int) -> dict[str, Any]:
    """Load the followed-teams list, put it at `target`, and hand back the state."""
    goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
    cards = wait_cards(page, 5)
    settle(page, 400)
    place = scroll_to(page, target)
    return {
        "cards": cards,
        "max": place["max"],
        "target": target,
        "actual": place["actual"],
        "before": url_parts(page),
    }


def case_r1_tap_return_spends_identity(harness: Harness, case: CaseResult) -> None:
    """R1 (B1): a coordinate tap returns to the list and spends the identity.

    The tap is made by mouse coordinates on a card that is already fully on
    screen, because Playwright scrolls a target into view before clicking and a
    card at the top of the list would drag the page back to y=0 — the position
    this case is about would then be unobservable.

    What the fix has to make true is a *record* claim as much as an offset
    claim: after the return the receipt (`nbascore:detailOrigin`), the open
    visit (`nbascore:detailVisit`) and the list entry's own `restored` flag must
    say the identity was used. The review's defect was that the marker survived,
    so the next detail page opened in that tab inherited it.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, sampler=True)
    attach_logging(page, case)
    try:
        opened = _open_list_at(harness, page, target=700)
        case.record(list=opened)
        case.check(opened["before"]["date"] == fixtures.SOURCE_DATE, "the list URL carries the date", url=opened["before"]["href"])
        case.check(opened["before"]["fav"] == "1", "the list URL carries the 关注 filter", url=opened["before"]["href"])
        case.check(opened["max"] >= 700, "the fixture slate is tall enough for a 700px position", maxScroll=opened["max"])
        case.check(opened["actual"] == 700, "the list really sits at 700px before the tap", scrollY=opened["actual"])

        tapped = tap_visible_card(page)
        wait_detail(page)
        detail = url_parts(page)
        receipt = js(
            page,
            "() => { const raw = sessionStorage.getItem('nbascore:detailOrigin');"
            " try { return JSON.parse(raw); } catch (e) { return null; } }",
        )
        visit = js(page, "() => sessionStorage.getItem('nbascore:detailVisit')")
        case.record(
            tapped=tapped,
            entered=detail["href"],
            receipt=receipt,
            visit=visit,
            scrollAtTap=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(detail["id"] == game_id_of(tapped["href"]) and detail["id"] != "", "the tapped card opened that game", id=detail["id"])
        case.check(
            isinstance(receipt, dict) and receipt.get("gameId") == detail["id"],
            "the receipt names the game this visit opened",
            receipt=receipt,
            id=detail["id"],
        )
        case.check(
            isinstance(receipt, dict) and receipt.get("scroll") == 700,
            "the receipt carries the measured reading position",
            scroll=receipt.get("scroll") if isinstance(receipt, dict) else None,
        )
        case.check(visit is not None, "an open visit is recorded while the detail page is up", visit=visit)

        back_control(page)
        wait_cards(page, 5)
        restored = wait_scroll(page, 700, timeout=10_000)
        settle(page, 900)
        after = url_parts(page)
        session_after = session_dump(page)
        entry_after = entry_state(page)
        samples = scroll_samples(page)
        case.record(
            afterUrl=after["href"],
            afterScroll=int(js(page, "() => Math.round(window.scrollY)")),
            sessionAfter=session_after,
            entryAfter=entry_after,
            sampleMax=max([entry[1] for entry in samples]) if samples else None,
        )
        shoot(page, case, "returned")

        case.check(after["path"] == "/", "the control returns to the home list", path=after["path"])
        case.check(
            after["date"] == fixtures.SOURCE_DATE and after["fav"] == "1",
            "date and filter survive the return",
            url=after["href"],
        )
        case.check(restored, "the reading position is restored", scrollY=int(js(page, "() => Math.round(window.scrollY)")))
        case.check(
            "nbascore:detailOrigin" not in session_after,
            "the receipt is consumed by the return (B1)",
            session=session_after,
        )
        case.check(
            "nbascore:detailVisit" not in session_after,
            "the open visit is closed by the return",
            visit=session_after.get("nbascore:detailVisit"),
        )
        case.check(
            isinstance(entry_after, dict) and entry_after.get("restored") is True,
            "the list entry records that its offset was replayed",
            entry=entry_after,
        )
        case.check(not case.page_errors, "no uncaught page error during the round trip", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_reentry_starts_at_top(harness: Harness, case: CaseResult) -> None:
    """R1 (B2): a fresh entry to the list starts at the top, marker or not.

    Two shapes, because the old code failed both for the same reason — a stored
    position was treated as a licence to scroll:

      (a) the reader returns from a game and then *navigates* to the same list
          URL again (an address-bar entry, not a history traversal);
      (b) `sessionStorage` still holds a live-looking receipt even though this
          document never ran a card tap — what a leftover record, a restored
          session or an inherited copy looks like.

    The scroll sampler forces `scrollRestoration = "manual"` before the app
    boots, so a measured offset can only come from the app's own restore loop.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, sampler=True)
    attach_logging(page, case)
    list_url = harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1")
    try:
        opened = _open_list_at(harness, page, target=700)
        tapped = tap_visible_card(page)
        wait_detail(page)
        back_control(page)
        wait_cards(page, 5)
        wait_scroll(page, 700, timeout=10_000)
        settle(page, 600)

        # (a) after the return, a plain navigation to the same URL.
        goto(page, unrelated_page_url(harness))
        settle(page, 300)
        goto(page, list_url)
        wait_cards(page, 5)
        settle(page, 2_500)
        samples_a = scroll_samples(page)
        after_a = url_parts(page)
        entry_a = entry_state(page)
        case.record(
            tapped=tapped,
            reentryScroll=int(js(page, "() => Math.round(window.scrollY)")),
            reentrySampleMax=max([entry[1] for entry in samples_a]) if samples_a else None,
            reentryUrl=after_a["href"],
            reentryEntry=entry_a,
            reentryCards=wait_cards(page, 5),
        )
        shoot(page, case, "reentry-top")
        case.check(after_a["date"] == fixtures.SOURCE_DATE, "the re-entered list is the same date", url=after_a["href"])
        case.check(
            int(js(page, "() => Math.round(window.scrollY)")) == 0,
            "(a) returning to the same URL by navigation starts at the top",
            scrollY=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(
            max([entry[1] for entry in samples_a]) <= 2 if samples_a else False,
            "(a) no frame ever jumped to the old offset",
            sampleMax=max([entry[1] for entry in samples_a]) if samples_a else None,
        )
        case.check(
            not (isinstance(entry_a, dict) and entry_a.get("restored") is False),
            "(a) the fresh entry carries no unspent restore mark",
            entry=entry_a,
        )

        # (b) a live-looking receipt in sessionStorage, written by nobody.
        doc_key = js(page, "() => sessionStorage.getItem('nbascore:docKey')")
        seeded = js(
            page,
            """(date) => {
                const at = Date.now();
                sessionStorage.setItem('nbascore:detailOrigin', JSON.stringify({
                    date, filter: 'favorites', scroll: 700, gameId: '0012600001',
                    url: `/?date=${date}&fav=1`, doc: sessionStorage.getItem('nbascore:docKey'), at,
                }));
                sessionStorage.setItem('nbascore:detailVisit', String(at));
                return {
                    origin: sessionStorage.getItem('nbascore:detailOrigin'),
                    visit: sessionStorage.getItem('nbascore:detailVisit'),
                };
            }""",
            arg=fixtures.SOURCE_DATE,
        )
        goto(page, unrelated_page_url(harness))
        settle(page, 300)
        goto(page, list_url)
        wait_cards(page, 5)
        settle(page, 2_500)
        samples_b = scroll_samples(page)
        case.record(
            seededDocKey=doc_key,
            seeded=seeded,
            seededScroll=int(js(page, "() => Math.round(window.scrollY)")),
            seededSampleMax=max([entry[1] for entry in samples_b]) if samples_b else None,
            seededEntry=entry_state(page),
        )
        shoot(page, case, "seeded-receipt-top")
        case.check(seeded["origin"] is not None, "(b) the stale receipt really was in sessionStorage", seeded=seeded)
        case.check(
            int(js(page, "() => Math.round(window.scrollY)")) == 0,
            "(b) a stored receipt alone does not restore an offset (B2)",
            scrollY=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(
            max([entry[1] for entry in samples_b]) <= 2 if samples_b else False,
            "(b) no frame jumped to the seeded 700px",
            sampleMax=max([entry[1] for entry in samples_b]) if samples_b else None,
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_stale_marker_deep_link_falls_back_home(harness: Harness, case: CaseResult) -> None:
    """R1 (B1): a detail page with an unrelated history entry behind it must not
    walk backwards into it.

    (a) reproduces the review's exact sequence: tap a card, return, open an
        unrelated same-origin page, then address-navigate into another game.
    (b) is the adversarial version: the receipt is *live* (right document, right
        age) but names the game from the earlier visit, so a check that only
        asked "is there a marker?" would let the back control leave the app.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    try:
        opened = _open_list_at(harness, page, target=700)
        first = tap_visible_card(page)
        wait_detail(page)
        first_id = url_parts(page)["id"]
        back_control(page)
        wait_cards(page, 5)
        settle(page, 800)
        case.record(list=opened, firstCard=first, firstId=first_id, afterFirstReturn=session_dump(page))
        case.check(first_id != "", "the first game was opened and identified", id=first_id)

        # (a) the review's sequence. The second game's href has to be read here,
        # while the list is still on screen — the unrelated page has no cards.
        second_href = js(page, f"() => document.querySelectorAll('{GAME_CARD}')[3]?.getAttribute('href') ?? null")
        second_id = game_id_of(second_href or "")
        goto(page, unrelated_page_url(harness))
        settle(page, 300)
        goto(page, harness.url(f"/game?id={second_id}"))
        wait_detail(page)
        case.record(secondId=second_id, atSecondDetail=url_parts(page)["href"])
        case.check(second_id != "" and second_id != first_id, "the second game is a different game", second=second_id, first=first_id)
        back_control(page)
        settle(page, 1_200)
        landed = url_parts(page)
        case.record(landedAfterSecondBack=landed["href"])
        shoot(page, case, "second-back")
        case.check(
            "manifest.webmanifest" not in landed["href"],
            "(a) the back control does not land on the unrelated page (B1)",
            url=landed["href"],
        )
        case.check(landed["path"] == "/", "(a) the fallback is the home list", path=landed["path"])
        case.check(
            landed["search"] == "",
            "(a) the fallback is today's home, not the old list's URL",
            search=landed["search"],
        )

        # (b) a live receipt that names the *other* game.
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
        wait_cards(page, 5)
        settle(page, 400)
        forged = js(
            page,
            """(args) => {
                const at = Date.now();
                sessionStorage.setItem('nbascore:detailOrigin', JSON.stringify({
                    date: args.date, filter: 'favorites', scroll: 700, gameId: args.gameId,
                    url: `/?date=${args.date}&fav=1`, doc: sessionStorage.getItem('nbascore:docKey'), at,
                }));
                sessionStorage.setItem('nbascore:detailVisit', String(at));
                return JSON.parse(sessionStorage.getItem('nbascore:detailOrigin'));
            }""",
            arg={"date": fixtures.SOURCE_DATE, "gameId": first_id},
        )
        goto(page, unrelated_page_url(harness))
        settle(page, 300)
        goto(page, harness.url(f"/game?id={second_id}"))
        wait_detail(page)
        case.record(forgedReceipt=forged, atSecondDetailAgain=url_parts(page)["href"])
        case.check(forged.get("gameId") == first_id, "(b) the trap receipt names the *first* game", receipt=forged)
        back_control(page)
        settle(page, 1_200)
        landed_b = url_parts(page)
        case.record(landedAfterForgedBack=landed_b["href"])
        shoot(page, case, "forged-back")
        case.check(
            "manifest.webmanifest" not in landed_b["href"],
            "(b) a receipt for another game does not authorize a back press",
            url=landed_b["href"],
        )
        case.check(landed_b["path"] == "/" and landed_b["search"] == "", "(b) the fallback is today's home", url=landed_b["href"])
        case.check(
            int(js(page, "() => Math.round(window.scrollY)")) == 0,
            "(b) the fallback starts at the top",
            scrollY=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_browser_back_restores_list(harness: Harness, case: CaseResult) -> None:
    """R1: the browser's own back button restores date, filter and position.

    The sampler turns the browser's implicit restoration off at document start,
    so the offset measured here was written by the app's loop and by nothing
    else — otherwise this case could pass on Chromium's own behaviour.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, sampler=True)
    attach_logging(page, case)
    try:
        opened = _open_list_at(harness, page, target=700)
        case.check(opened["actual"] == 700, "the list sits at 700px", scrollY=opened["actual"])
        tapped = tap_visible_card(page)
        wait_detail(page)
        history_len = int(js(page, "() => history.length"))
        case.record(tapped=tapped, historyLength=history_len, atDetail=url_parts(page)["href"])

        page.go_back()
        wait_cards(page, 5)
        restored = wait_scroll(page, 700, timeout=10_000)
        settle(page, 900)
        after = url_parts(page)
        samples = scroll_samples(page)
        case.record(
            afterUrl=after["href"],
            afterScroll=int(js(page, "() => Math.round(window.scrollY)")),
            sampleMax=max([entry[1] for entry in samples]) if samples else None,
            entry=entry_state(page),
            session=session_dump(page),
            scrollRestoration=js(page, "() => history.scrollRestoration"),
        )
        shoot(page, case, "browser-back")
        case.check(restored, "the browser back button restores the 700px position", scrollY=int(js(page, "() => Math.round(window.scrollY)")))
        case.check(
            after["date"] == fixtures.SOURCE_DATE and after["fav"] == "1",
            "date and filter come back with it",
            url=after["href"],
        )
        entry = case.data.get("entry")
        case.check(
            isinstance(entry, dict) and entry.get("restored") is True,
            "the app marked the entry as replayed (so the browser did not do this alone)",
            entry=entry,
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_quick_switch_during_restore(harness: Harness, case: CaseResult) -> None:
    """R1: switching day or filter while a restore is running must not carry the
    old offset onto the new list.

    The restore loop re-applies its target for up to six seconds, so a reader who
    taps back and immediately changes the day is inside that window. The samples
    taken *after* the URL changed are the assertion: the new list may never be
    scrolled to the old position.

    The two switches do not end in the same place, and that is the product's own
    choice rather than this suite's: the day switch takes the reader back to the
    top, while the filter switch keeps the current offset because
    `changeFilter` calls `router.replace(query, { scroll: false })` explicitly.
    So (b) asserts what is actually falsifiable — no `scrollTo` call and no
    movement at all after the switch (the sampler logs both) — and *records*
    where the reader ended up; the "starts at the top" reading of a filter
    switch is covered by a real navigation to the unfiltered URL, which is the
    address-bar equivalent.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, sampler=True)
    attach_logging(page, case)
    try:
        # (a) quick day switch.
        opened = _open_list_at(harness, page, target=700)
        tapped = tap_visible_card(page)
        wait_detail(page)
        back_control(page)
        page.wait_for_function(
            "(minimum) => document.querySelectorAll('main a[href^=\"/game\"]').length >= minimum",
            arg=5,
            timeout=10_000,
        )
        page.get_by_role("button", name="前一天").click()
        wait_url_date(page, "2026-10-08")
        switch_at = int(js(page, "() => Math.round(performance.now())"))
        mark_date = len(scroll_samples(page))
        mark_date_calls = len(scroll_calls(page))
        settle(page, 1_800)
        samples_date = scroll_samples(page)
        calls_date = scroll_calls(page)[mark_date_calls:]
        late_date = [call for call in calls_date if call["at"] > switch_at + SWITCH_GRACE_MS]
        after_date = url_parts(page)
        case.record(
            tapped=tapped,
            list=opened,
            switchedTo=after_date["href"],
            dateInput=js(page, "() => { const el = document.querySelector('input[type=date]'); return el ? el.value : null; }"),
            scrollAfterSwitch=int(js(page, "() => Math.round(window.scrollY)")),
            sampleMaxAfterSwitch=max_after(samples_date, mark_date),
            scrollCallsAfterSwitch=[[call["at"], call["args"]] for call in calls_date],
        )
        shoot(page, case, "switched-day")
        case.check(after_date["date"] == "2026-10-08", "(a) the day really changed", url=after_date["href"])
        case.check(
            int(js(page, "() => Math.round(window.scrollY)")) <= 2,
            "(a) the new day's list sits at the top",
            scrollY=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(
            max_after(samples_date, mark_date) <= 2,
            "(a) the old 700px target was never written onto the new list",
            sampleMax=max_after(samples_date, mark_date),
        )
        case.check(
            late_date == [],
            f"(a) the restore stops within {SWITCH_GRACE_MS}ms of the switch",
            late=[[call["at"], call["args"]] for call in late_date][:4],
            count=len(late_date),
        )

        # (b) quick filter switch, from a fresh return.
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
        wait_cards(page, 5)
        settle(page, 500)
        scroll_to(page, 700)
        tap_visible_card(page)
        wait_detail(page)
        back_control(page)
        page.wait_for_function(
            "(minimum) => document.querySelectorAll('main a[href^=\"/game\"]').length >= minimum",
            arg=5,
            timeout=10_000,
        )
        page.locator('[role="tablist"][aria-label="比赛筛选"] [role="tab"]').first.click()
        page.wait_for_function(
            "() => !new URLSearchParams(location.search).get('fav')", timeout=NAV_TIMEOUT_MS
        )
        switch_at = int(js(page, "() => Math.round(performance.now())"))
        mark_filter = len(scroll_samples(page))
        mark_calls = len(scroll_calls(page))
        scroll_at_switch = int(js(page, "() => Math.round(window.scrollY)"))
        settle(page, 1_800)
        samples_filter = scroll_samples(page)
        calls_filter = scroll_calls(page)[mark_calls:]
        late_filter = [call for call in calls_filter if call["at"] > switch_at + SWITCH_GRACE_MS]
        after_filter = url_parts(page)
        case.record(
            switchedToAll=after_filter["href"],
            scrollAtFilterSwitch=scroll_at_switch,
            filterSwitchFinalScroll=int(js(page, "() => Math.round(window.scrollY)")),
            sampleBandAfterFilter=[min_after(samples_filter, mark_filter), max_after(samples_filter, mark_filter)],
            scrollCallsAfterFilter=[[call["at"], call["args"]] for call in calls_filter],
        )
        shoot(page, case, "switched-filter")
        case.check(after_filter["fav"] == "", "(b) the filter really changed to 全部", url=after_filter["href"])
        # The offset itself is deliberately kept across a filter change, so the
        # falsifiable claim is not "it is 0" but "the restore stops writing it":
        # had the old target survived the switch, the loop would keep calling
        # `scrollTo` on every frame for the rest of its window. The few calls
        # inside the grace window are React committing the new filter, not the
        # old restore surviving it.
        case.check(
            late_filter == [],
            f"(b) the restore stops writing within {SWITCH_GRACE_MS}ms of the filter switch",
            late=[[call["at"], call["args"]] for call in late_filter][:4],
            count=len(late_filter),
            immediate=len(calls_filter) - len(late_filter),
        )
        case.check(
            abs(int(js(page, "() => Math.round(window.scrollY)")) - scroll_at_switch) <= 2,
            "(b) the offset the reader had is left exactly where it was",
            atSwitch=scroll_at_switch,
            after=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(
            max_after(samples_filter, mark_filter) - min_after(samples_filter, mark_filter) <= 2,
            "(b) the samples stay inside a 2px band: nothing moved the page",
            band=[min_after(samples_filter, mark_filter), max_after(samples_filter, mark_filter)],
        )

        # The address-bar equivalent of "now show me everything": arrive from the
        # filtered URL by a real navigation. That one must start at the top.
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
        wait_cards(page, 5)
        settle(page, 600)
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}"))
        wait_cards(page, 5)
        settle(page, 1_200)
        navigation = url_parts(page)
        case.record(
            unfilteredByNavigation=navigation["href"],
            unfilteredNavigationScroll=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(
            navigation["fav"] == "",
            "(b) the navigated URL really has no filter",
            url=navigation["href"],
        )
        case.check(
            int(js(page, "() => Math.round(window.scrollY)")) <= 2,
            "(b) entering the unfiltered list by navigation starts at the top",
            scrollY=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_back_after_dwell(harness: Harness, case: CaseResult) -> None:
    """R1: a detail page left open for a while still returns correctly.

    The identity has to survive the reader sitting on the detail page, and the
    receipt must still be spent by the return. This is a *page* dwell, not a
    real Android background/foreground cycle — see the README's boundary table.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, sampler=True)
    attach_logging(page, case)
    try:
        opened = _open_list_at(harness, page, target=700)
        tapped = tap_visible_card(page)
        wait_detail(page)
        first_view = {
            "receipt": js(page, "() => sessionStorage.getItem('nbascore:detailOrigin')"),
            "visit": js(page, "() => sessionStorage.getItem('nbascore:detailVisit')"),
        }
        settle(page, 4_000)
        held = {
            "receipt": js(page, "() => sessionStorage.getItem('nbascore:detailOrigin')"),
            "visit": js(page, "() => sessionStorage.getItem('nbascore:detailVisit')"),
            "url": url_parts(page)["href"],
        }
        case.record(tapped=tapped, list=opened, atEntry=first_view, afterDwell=held)
        case.check(held["receipt"] is not None, "the receipt is still there after the dwell", receipt=held["receipt"])
        case.check(held["url"] == url_parts(page)["href"], "the detail page stayed where it was")

        back_control(page)
        wait_cards(page, 5)
        restored = wait_scroll(page, 700, timeout=10_000)
        settle(page, 900)
        after = url_parts(page)
        session_after = session_dump(page)
        case.record(
            afterUrl=after["href"],
            afterScroll=int(js(page, "() => Math.round(window.scrollY)")),
            sessionAfter=session_after,
            entryAfter=entry_state(page),
        )
        shoot(page, case, "after-dwell")
        case.check(restored, "the position is restored after the dwell", scrollY=int(js(page, "() => Math.round(window.scrollY)")))
        case.check(
            after["date"] == fixtures.SOURCE_DATE and after["fav"] == "1",
            "date and filter survive the dwell",
            url=after["href"],
        )
        case.check(
            "nbascore:detailOrigin" not in session_after,
            "the dwell did not stop the return from spending the receipt",
            session=session_after,
        )
        case.check(
            isinstance(entry_state(page), dict) and (entry_state(page) or {}).get("restored") is True,
            "the entry is marked as replayed",
            entry=entry_state(page),
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_modified_click_isolation(harness: Harness, case: CaseResult) -> None:
    """R1: Ctrl-click and middle-click must not write this tab's return identity.

    Both open the game somewhere else (a new tab, in Chromium) while the current
    page stays on the list. If the app recorded an origin anyway, that page would
    later believe a card tap happened in it. After each modifier click the case
    also walks the tab through an unrelated page and into a game, to prove the
    identity was not merely "not consumed yet" — pressing back there must land on
    today's home, not on the unrelated entry.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    modes = (("ctrl-click", "control"), ("middle-click", "middle"))
    try:
        for label, kind in modes:
            opened = _open_list_at(harness, page, target=700)
            # Each mode is measured from a clean slate: a receipt left behind by
            # the previous mode (or by anything else earlier in the session) must
            # not be mistaken for something *this* click wrote. `newSessionKeys`
            # is what catches a write by this click, so clearing first only makes
            # the two readings independent.
            js(
                page,
                "() => { sessionStorage.removeItem('nbascore:detailOrigin');"
                " sessionStorage.removeItem('nbascore:detailVisit'); }",
            )
            before_session = session_dump(page)
            before_entry = entry_state(page)
            pages_before = len(context.pages)
            # Clicked by coordinate on a card that is already on screen: a
            # locator click would scroll the card into view first and move the
            # very position this case asserts.
            visible = js(page, VISIBLE_CARD)
            case.check(visible is not None, f"[{label}] a card is fully visible at 700px", card=visible)
            href = visible["href"] if visible else ""
            if kind == "control":
                page.keyboard.down("Control")
                page.mouse.click(visible["x"], visible["y"])
                page.keyboard.up("Control")
            else:
                page.mouse.click(visible["x"], visible["y"], button="middle")
            settle(page, 1_000)
            after_session = session_dump(page)
            after_entry = entry_state(page)
            after_url = url_parts(page)
            new_keys = sorted(set(after_session) - set(before_session))
            case.record(
                label=label,
                card=href,
                pagesBefore=pages_before,
                pagesAfter=len(context.pages),
                urlAfter=after_url["href"],
                scrollAfter=int(js(page, "() => Math.round(window.scrollY)")),
                newSessionKeys=new_keys,
                entryBefore=before_entry,
                entryAfter=after_entry,
                list=opened,
            )
            case.check(
                len(context.pages) == pages_before + 1,
                f"[{label}] the modified click opened the game in another tab",
                pages=f"{pages_before}->{len(context.pages)}",
            )
            case.check(
                after_url["path"] == "/" and after_url["fav"] == "1",
                f"[{label}] the current page stayed on the list",
                url=after_url["href"],
            )
            case.check(
                int(js(page, "() => Math.round(window.scrollY)")) == 700,
                f"[{label}] the current page kept its reading position",
                scrollY=int(js(page, "() => Math.round(window.scrollY)")),
            )
            case.check(
                "nbascore:detailOrigin" not in after_session and "nbascore:detailVisit" not in after_session,
                f"[{label}] no return identity was written in the current page",
                newKeys=new_keys,
                origin=after_session.get("nbascore:detailOrigin"),
            )
            case.check(
                not (isinstance(after_entry, dict) and after_entry.get("restored") is False),
                f"[{label}] the list entry carries no unspent restore mark",
                entry=after_entry,
            )

            # The other tab is not this tab's business; close it before the walk.
            for extra in context.pages[1:]:
                extra.close()

            goto(page, unrelated_page_url(harness))
            settle(page, 300)
            goto(page, harness.url(f"/game?id={game_id_of(href)}"))
            wait_detail(page)
            back_control(page)
            settle(page, 1_200)
            landed = url_parts(page)
            case.record(label=label, landedAfterModified=landed["href"])
            case.check(
                "manifest.webmanifest" not in landed["href"],
                f"[{label}] the later back press does not land on the unrelated page",
                url=landed["href"],
            )
            case.check(
                landed["path"] == "/" and landed["search"] == "",
                f"[{label}] the fallback is today's home",
                url=landed["href"],
            )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_each_return_keeps_its_own_offset(harness: Harness, case: CaseResult) -> None:
    """R1 (C1): one list, three consecutive returns, three different offsets.

    The closeout review's reproduction was exact: the first return landed on the
    offset it recorded, and every later return landed on the *first* one — 300 →
    300, then 600 recorded in the receipt but 300 on screen. The receipt was
    right every time; what was stale was the module-level restore slot, keyed by
    `date + filter` alone and therefore reused across visits.

    What this case has to be able to see is therefore not "an offset came back"
    but "the offset that belongs to *this* visit came back": three taps, three
    receipts, three different offsets, each measured before the tap, inside the
    receipt, and after the return. The sampler keeps Chromium's own restoration
    off (`manual` at document start), so every restored number was written by the
    app's loop.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, sampler=True)
    attach_logging(page, case)
    try:
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
        wait_cards(page, 5)
        settle(page, 400)

        rounds: list[dict[str, Any]] = []
        for index, target in enumerate((300, 600, 900), start=1):
            place = scroll_to(page, target)
            tapped = tap_visible_card(page)
            wait_detail(page)
            receipt = detail_receipt(page)
            visit = js(page, "() => sessionStorage.getItem('nbascore:detailVisit')")
            back_control(page)
            wait_cards(page, 5)
            restored = wait_scroll(page, target, timeout=6_000)
            settle(page, 900)
            after = int(js(page, "() => Math.round(window.scrollY)"))
            landed = url_parts(page)
            entry_after = entry_state(page)
            rounds.append(
                {
                    "round": index,
                    "target": target,
                    "maxScroll": place["max"],
                    "before": place["actual"],
                    "card": tapped["href"],
                    "receipt": receipt,
                    "visit": visit,
                    "after": after,
                    "restored": restored,
                    "landed": landed["href"],
                    "entryAfter": entry_after,
                }
            )

            case.check(
                place["max"] >= target,
                f"round {index}: the list is tall enough to sit at {target}px",
                maxScroll=place["max"],
            )
            case.check(
                place["actual"] == target,
                f"round {index}: the list really sits at {target}px before the tap",
                scrollY=place["actual"],
            )
            case.check(
                isinstance(receipt, dict) and receipt.get("scroll") == target,
                f"round {index}: the receipt records this visit's own offset",
                receipt=receipt,
            )
            case.check(
                restored and abs(after - target) <= 2,
                f"round {index}: the return lands on this visit's offset, not the first one",
                wanted=target,
                scrollY=after,
            )
            case.check(
                landed["date"] == fixtures.SOURCE_DATE and landed["fav"] == "1",
                f"round {index}: date and filter survive the return",
                url=landed["href"],
            )
            case.check(
                isinstance(entry_after, dict) and entry_after.get("restored") is True,
                f"round {index}: the entry records that this visit's offset was replayed",
                entry=entry_after,
            )

        receipts = [round_["receipt"] for round_ in rounds]
        visits = [round_["visit"] for round_ in rounds]
        case.record(rounds=rounds, visits=visits)
        case.check(len(rounds) == 3, "three returns were actually driven", rounds=len(rounds))
        case.check(
            len({receipt.get("at") for receipt in receipts if isinstance(receipt, dict)}) == 3,
            "each tap opened its own visit (three distinct visit tokens)",
            visits=visits,
        )
        case.check(
            len({receipt.get("scroll") for receipt in receipts if isinstance(receipt, dict)}) == 3,
            "the three receipts carry three different offsets",
            scrolls=[receipt.get("scroll") for receipt in receipts if isinstance(receipt, dict)],
        )
        case.check(
            [round_["after"] for round_ in rounds] == [300, 600, 900],
            "the three returns land on 300, 600 and 900 in order",
            after=[round_["after"] for round_ in rounds],
        )
        case.check(not case.page_errors, "no uncaught page error during the three returns", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_new_tab_copy_has_no_back_authority(harness: Harness, case: CaseResult) -> None:
    """R1 (C2a): a browser-copied storage cannot authorize a detail return.

    The review opened an unrelated same-origin page with a real `window.open`,
    which makes Chromium copy the opener's whole `sessionStorage` — including the
    document key the old code trusted. In that copy it opened the *same* game the
    receipt named and pressed the app's back control, and the app walked back into
    the unrelated page.

    The copy is not doctored here either: every key is carried over as the browser
    carries it, `nbascore:docKey` included, and the case asserts that the copy is
    complete before it presses anything. Only then is the landing checked: with an
    unrelated entry behind it, the app's back control must reach today's home.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    try:
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
        wait_cards(page, 5)
        settle(page, 400)
        tapped = tap_visible_card(page)
        wait_detail(page)
        game_url = page.url
        game_id = url_parts(page)["id"]
        receipt = detail_receipt(page)
        opener_storage = session_dump(page)
        case.record(tapped=tapped, gameUrl=game_url, receipt=receipt, openerKeys=sorted(opener_storage))

        case.check(game_id != "", "the tapped card opened a game", id=game_id)
        case.check(
            isinstance(receipt, dict) and receipt.get("gameId") == game_id,
            "the session receipt names the game this visit opened",
            receipt=receipt,
        )

        with context.expect_page() as popup:
            page.evaluate("window.open('/manifest.webmanifest','_blank')")
        clone = popup.value
        clone.wait_for_load_state("load")
        carried = session_dump(clone)
        case.record(cloneKeys=sorted(carried))
        case.check(
            "nbascore:detailOrigin" in carried and "nbascore:detailVisit" in carried,
            "the browser copied the receipt and the open visit into the new tab",
            keys=sorted(carried),
        )
        case.check(
            "nbascore:docKey" in carried and carried.get("nbascore:docKey") == opener_storage.get("nbascore:docKey"),
            "the copy carries the document key too (nothing was deleted to make this pass)",
            copied=carried.get("nbascore:docKey"),
            opener=opener_storage.get("nbascore:docKey"),
        )

        clone.goto(game_url, wait_until="domcontentloaded")
        wait_detail(clone)
        clone_entry = detail_entry_state(clone)
        case.record(cloneEntry=clone_entry, cloneUrl=clone.url)
        case.check(
            clone_entry is None,
            "the copied document's detail entry carries no card-tap evidence",
            entry=clone_entry,
        )

        back_control(clone)
        settle(clone, 1_500)
        landed = url_parts(clone)
        case.record(landed=landed["href"])
        shoot(clone, case, "clone-back")
        case.check(
            "manifest.webmanifest" not in landed["href"],
            "the back control does not walk into the unrelated page (C2a)",
            url=landed["href"],
        )
        case.check(
            landed["path"] == "/" and landed["search"] == "",
            "the fallback is today's home, not the copied receipt's list",
            url=landed["href"],
        )
        case.check(not case.page_errors, "no uncaught page error in the copied tab", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_same_tab_reentry_has_no_back_authority(harness: Harness, case: CaseResult) -> None:
    """R1 (C2b): the same tab leaving and directly re-opening the same gameId.

    `sessionStorage` is per tab and survives a full-document navigation, so the
    receipt the review reproduced with is still there when the reader leaves for
    an unrelated page and then opens the very same game again. That is a new
    document with a new history entry, and the app's own back control has to
    refuse it: the entry behind is the unrelated page, not the list.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    try:
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
        wait_cards(page, 5)
        settle(page, 400)
        tapped = tap_visible_card(page)
        wait_detail(page)
        game_url = page.url
        receipt = detail_receipt(page)
        case.record(tapped=tapped, gameUrl=game_url, receipt=receipt)
        case.check(receipt is not None, "a real tap left a receipt before the tab left the app")

        goto(page, unrelated_page_url(harness))
        settle(page, 300)
        goto(page, game_url)
        wait_detail(page)
        storage_here = session_dump(page)
        entry_here = detail_entry_state(page)
        case.record(storageKeys=sorted(storage_here), entryState=entry_here)
        case.check(
            "nbascore:detailOrigin" in storage_here and "nbascore:docKey" in storage_here,
            "the same tab still holds the receipt and the key after the full-document leave",
            keys=sorted(storage_here),
        )
        case.check(
            entry_here is None,
            "the directly opened detail entry carries no card-tap evidence",
            entry=entry_here,
        )

        back_control(page)
        settle(page, 1_500)
        landed = url_parts(page)
        case.record(landed=landed["href"])
        shoot(page, case, "reentry-back")
        case.check(
            "manifest.webmanifest" not in landed["href"],
            "the back control does not walk into the unrelated page (C2b)",
            url=landed["href"],
        )
        case.check(
            landed["path"] == "/" and landed["search"] == "",
            "the fallback is today's home",
            url=landed["href"],
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_detail_reload_keeps_the_return(harness: Harness, case: CaseResult) -> None:
    """R1 (C2, the reload case): a reloaded detail entry still returns to its list.

    A reload is a new JavaScript realm over the *same* history entry: the session
    copy of the receipt belongs to the document that was replaced, but the entry
    itself still says a card tap pushed it. The design is explicit — the entry is
    the evidence, the session copy is only the values attached to it — and this
    case verifies both halves: the mark is still on the entry after the reload,
    and the app's back control reaches the list it came from, position included.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, sampler=True)
    attach_logging(page, case)
    try:
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
        wait_cards(page, 5)
        settle(page, 400)
        place = scroll_to(page, 700)
        tap_visible_card(page)
        wait_detail(page)
        game_id = url_parts(page)["id"]
        game_url = page.url
        receipt = detail_receipt(page)
        mark_before = detail_entry_state(page)
        case.record(gameUrl=game_url, receipt=receipt, markBeforeReload=mark_before, maxScroll=place["max"])

        case.check(
            isinstance(mark_before, dict) and mark_before.get("gameId") == game_id,
            "the card tap marked the detail entry it pushed",
            entry=mark_before,
        )
        case.check(
            isinstance(receipt, dict) and receipt.get("doc") is not None,
            "the session copy names the document that wrote it",
            receipt=receipt,
        )

        page.reload(wait_until="domcontentloaded")
        wait_detail(page)
        mark_after = detail_entry_state(page)
        session_after = session_dump(page)
        case.record(markAfterReload=mark_after, sessionAfterReload=session_after)
        case.check(
            isinstance(mark_after, dict) and mark_after.get("gameId") == game_id and mark_after.get("at") == (mark_before or {}).get("at"),
            "the entry's own mark survives the reload unchanged",
            after=mark_after,
            before=mark_before,
        )
        case.check(
            "nbascore:detailOrigin" in session_after,
            "the session copy is still in storage after the reload (it is not what authorizes)",
            keys=sorted(session_after),
        )

        back_control(page)
        wait_cards(page, 5)
        restored = wait_scroll(page, 700, timeout=10_000)
        settle(page, 900)
        landed = url_parts(page)
        case.record(landed=landed["href"], restored=restored, scrollY=int(js(page, "() => Math.round(window.scrollY)")))
        case.check(
            landed["path"] == "/" and landed["date"] == fixtures.SOURCE_DATE and landed["fav"] == "1",
            "after a reload the app back still returns to the list it came from",
            url=landed["href"],
        )
        case.check(
            restored,
            "the list's own mark still restores the offset after the detail was reloaded",
            scrollY=int(js(page, "() => Math.round(window.scrollY)")),
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r1_scroll_restoration_is_handed_back(harness: Harness, case: CaseResult) -> None:
    """R1 (§3): the app owns the restore mode only while it is restoring.

    The delivery notes claimed the loop no longer touched
    `history.scrollRestoration`; the code assigned `"manual"` twice per run and
    handed back a hard-coded `"auto"`. This case records every write — with the
    value that was in effect before it — and requires three things of the
    *behaviour* rather than of a comment: the loop takes the entry's mode over
    while it holds the position, no takeover is left without a hand-back, and the
    value that was there before comes back at the end, including when a day
    switch cancels the restore in flight.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    page.add_init_script(RESTORE_TRACE)
    try:
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}&fav=1"))
        wait_cards(page, 5)
        settle(page, 400)
        baseline = js(page, "() => window.__dshRestorationBefore")
        case.record(baselineRestoration=baseline)

        place = scroll_to(page, 700)
        tap_visible_card(page)
        wait_detail(page)
        back_control(page)
        wait_cards(page, 5)
        restored = wait_scroll(page, 700, timeout=10_000)
        settle(page, 1_600)

        writes = js(page, "() => (window.__dshRestoration || []).map((entry) => ({ ...entry }))")
        calls = int(js(page, "() => (window.__dshScrollCalls || []).length"))
        final = js(page, "() => history.scrollRestoration")
        case.record(
            maxScroll=place["max"],
            restored=restored,
            scrollY=int(js(page, "() => Math.round(window.scrollY)")),
            writes=writes,
            scrollCalls=calls,
            finalRestoration=final,
        )

        case.check(baseline == "auto", "the entry starts with the browser default restore mode", before=baseline)
        case.check(restored, "the app's own loop restored the offset", scrollY=int(js(page, "() => Math.round(window.scrollY)")))
        case.check(calls > 0, "the app really wrote the offset with its own scrollTo", calls=calls)
        case.check(
            any(write["value"] == "manual" for write in writes),
            "the loop takes the entry's restore mode over while it holds the position",
            writes=writes,
        )
        duplicated = [
            (index, writes[index], writes[index + 1])
            for index in range(len(writes) - 1)
            if writes[index]["value"] == "manual" and writes[index + 1]["value"] == "manual"
        ]
        case.check(
            not duplicated,
            "no run assigns 'manual' twice in a row: every takeover is followed by a hand-back",
            duplicated=duplicated[:3],
        )
        case.check(
            bool(writes) and writes[-1]["value"] == baseline and final == baseline,
            "the value that was there before the restore is back on the entry afterwards",
            last=writes[-1] if writes else None,
            final=final,
            before=baseline,
        )

        # Interrupted path: a day switch cancels the restore that is still running,
        # and the mode must still come back.
        scroll_to(page, 600)
        tap_visible_card(page)
        wait_detail(page)
        back_control(page)
        wait_cards(page, 5)
        page.get_by_label("前一天", exact=True).click()
        page.wait_for_function(
            "(date) => new URLSearchParams(location.search).get('date') !== date",
            arg=fixtures.SOURCE_DATE,
            timeout=NAV_TIMEOUT_MS,
        )
        settle(page, 1_600)
        writes_2 = js(page, "() => (window.__dshRestoration || []).map((entry) => ({ ...entry }))")
        final_2 = js(page, "() => history.scrollRestoration")
        case.record(writesAfterSwitch=writes_2, finalAfterSwitch=final_2)
        case.check(
            final_2 == baseline,
            "a restore cancelled by a day switch also hands the mode back",
            final=final_2,
            before=baseline,
        )
        case.check(
            bool(writes_2) and writes_2[-1]["value"] == baseline,
            "the last write after the switch is the hand-back, not another takeover",
            last=writes_2[-1] if writes_2 else None,
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r2_sheet_multiselect_and_back(harness: Harness, case: CaseResult) -> None:
    """R2: multi-select touches history not at all; one back closes the sheet only."""
    api = fixtures.Api(scenario="live")
    # One followed team: the sheet sorts followed teams first, so the three taps
    # below are one un-follow and two follows — a selection change that is easy
    # to assert exactly, and impossible to confuse with "nothing happened".
    context, page = new_context(harness.browser, api, favorites=(fixtures.LAL,))
    attach_logging(page, case)
    page.add_init_script(HISTORY_PROBE)
    try:
        # Two documents, so "the next back goes through normal history" is a real
        # claim rather than "there was nothing behind us".
        goto(page, harness.url(f"/?date={fixtures.PREV_DATE}"))
        wait_games(page, 1)
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}"))
        wait_games(page, 5)
        settle(page, 400)

        before = url_parts(page)
        history_before = js(page, "() => history.length")
        state_before = js(page, "() => { try { return history.state; } catch (e) { return null; } }")
        js(page, "() => window.__dshHistClear()")

        page.locator('button[aria-label="关注球队"]').first.click()
        page.wait_for_selector('[role="dialog"][aria-label="关注球队"]')
        settle(page, 500)
        open_trace = js(page, "() => window.__dshHist.slice()")
        open_after = url_parts(page)
        history_after_open = js(page, "() => history.length")
        case.record(
            historyBefore=history_before,
            historyAfterOpen=history_after_open,
            openTrace=[{"op": entry["op"], "url": entry["url"], "state": entry["state"]} for entry in open_trace],
            urlBefore=before["href"],
            urlAfterOpen=open_after["href"],
        )

        pushes = [entry for entry in open_trace if entry["op"] == "pushState"]
        case.check(len(pushes) == 1, "opening the sheet pushes exactly one history entry", ops=[entry["op"] for entry in open_trace])
        case.check(
            history_after_open == history_before + 1,
            "history grew by exactly one entry",
            before=history_before,
            after=history_after_open,
        )
        pushed_state = json.loads(pushes[0]["state"]) if pushes and pushes[0]["state"] != "unserializable" else None
        case.check(
            isinstance(pushed_state, dict) and pushed_state.get("__favoritesSheet") is True,
            "the pushed state is marked as the sheet's own",
            state=pushed_state,
        )
        if isinstance(state_before, dict):
            preserved = all(pushed_state.get(key) == value for key, value in state_before.items())
            case.check(preserved, "Next's own history state is preserved, not replaced", before=state_before, pushed=pushed_state)
        case.check(open_after["href"] == before["href"], "opening the sheet does not change the URL", url=open_after["href"])

        buttons = page.locator('[role="dialog"][aria-label="关注球队"] button[aria-pressed]')
        order_before = [buttons.nth(index).inner_text().strip() for index in range(buttons.count())]
        pressed_before = [
            buttons.nth(index).get_attribute("aria-pressed") == "true" for index in range(buttons.count())
        ]
        js(page, "() => window.__dshHistClear()")
        for index in range(3):
            buttons.nth(index).click()
            settle(page, 260)
        order_after = [buttons.nth(index).inner_text().strip() for index in range(buttons.count())]
        pressed_after = [
            buttons.nth(index).get_attribute("aria-pressed") == "true" for index in range(buttons.count())
        ]
        ops_during_taps = js(page, "() => window.__dshHistOps()")
        selected = page.locator('[role="dialog"][aria-label="关注球队"] button[aria-pressed="true"]').count()
        dialog_open = page.locator('[role="dialog"][aria-label="关注球队"]').count()
        tapped = [
            {
                "name": order_before[index],
                "pressedBefore": pressed_before[index],
                "pressedAfter": pressed_after[index] if index < len(pressed_after) else None,
            }
            for index in range(3)
        ]
        case.record(
            orderBefore=order_before,
            orderAfter=order_after,
            opsDuringTaps=ops_during_taps,
            selected=selected,
            tapped=tapped,
            favoritesStored=js(page, "() => localStorage.getItem('favoriteTeams')"),
        )
        shoot(page, case, "multiselect")

        case.check(ops_during_taps == [], "three taps perform zero history operations", ops=ops_during_taps)
        case.check(order_after == order_before, "the team order is frozen while the sheet is open", changed=[
            {"index": index, "before": order_before[index], "after": order_after[index]}
            for index in range(min(len(order_before), len(order_after)))
            if order_before[index] != order_after[index]
        ])
        for entry in tapped:
            case.check(
                entry["pressedBefore"] is not None and entry["pressedAfter"] is not None
                and entry["pressedAfter"] != entry["pressedBefore"],
                f"tapping {entry['name']!r} flips its selection",
                before=entry["pressedBefore"],
                after=entry["pressedAfter"],
            )
        case.check(selected == 2, "exactly the three taps' worth of selection changed", selected=selected)
        case.check(dialog_open == 1, "the sheet stays open through the taps", dialogs=dialog_open)

        js(page, "() => window.__dshHistClear()")
        js(page, "() => history.back()")
        page.wait_for_selector('[role="dialog"][aria-label="关注球队"]', state="detached", timeout=UI_TIMEOUT_MS)
        settle(page, 700)
        after_back = url_parts(page)
        back_ops = js(page, "() => window.__dshHistOps()")
        case.record(afterFirstBack=after_back["href"], opsDuringBack=back_ops, dialogsAfterBack=page.locator('[role="dialog"]').count())
        shoot(page, case, "closed-by-back")

        # A popstate makes Next re-sync its own history state with a
        # `replaceState`; that is the framework's normal bookkeeping, not the
        # sheet touching history. What must not happen is a second `back` (the
        # sheet's cleanup popping again) or another `pushState`.
        case.check(back_ops.count("back") == 1, "one back press pops exactly one entry", ops=back_ops)
        case.check("pushState" not in back_ops, "closing by back does not push a new entry", ops=back_ops)
        case.check(
            after_back["href"] == before["href"],
            "closing by back leaves the URL alone",
            url=after_back["href"],
        )
        case.check(page.locator('[role="dialog"]').count() == 0, "one back press closes the sheet")

        js(page, "() => history.back()")
        page.wait_for_function(
            "(date) => new URLSearchParams(location.search).get('date') === date",
            arg=fixtures.PREV_DATE,
            timeout=NAV_TIMEOUT_MS,
        )
        settle(page, 400)
        second = url_parts(page)
        case.record(afterSecondBack=second["href"])
        case.check(
            second["date"] == fixtures.PREV_DATE,
            "the next back press goes through normal history to the previous document",
            url=second["href"],
        )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r2_sheet_manual_close_focus(harness: Harness, case: CaseResult) -> None:
    """R2: closing by hand gives the entry back and returns focus to the trigger."""
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    try:
        goto(page, harness.url(f"/?date={fixtures.SOURCE_DATE}"))
        wait_games(page, 5)
        settle(page, 400)

        methods: list[dict[str, Any]] = []
        for method in ("escape", "close-button", "overlay"):
            trigger = page.locator('button[aria-label="关注球队"]').first
            trigger.evaluate("(el) => { el.dataset.probeTrigger = '1'; }")
            trigger.click()
            page.wait_for_selector('[role="dialog"][aria-label="关注球队"]')
            settle(page, 450)
            pushed = js(page, "() => { const s = history.state; return !!(s && s.__favoritesSheet); }")

            if method == "escape":
                page.keyboard.press("Escape")
            elif method == "close-button":
                page.locator('[role="dialog"] button[aria-label="关闭"]').first.click()
            else:
                # The overlay is the full-viewport button behind the panel; the
                # top-left corner is safely outside the bottom sheet.
                page.mouse.click(8, 8)

            page.wait_for_selector('[role="dialog"][aria-label="关注球队"]', state="detached", timeout=UI_TIMEOUT_MS)
            settle(page, 700)
            focused = js(
                page,
                "() => { const el = document.activeElement; return el ? { tag: el.tagName,"
                " label: el.getAttribute('aria-label'), probe: el.dataset ? el.dataset.probeTrigger ?? null : null } : null; }",
            )
            state_after = js(page, "() => { const s = history.state; return !!(s && s.__favoritesSheet); }")
            methods.append(
                {
                    "method": method,
                    "pushedOnOpen": pushed,
                    "focused": focused,
                    "sheetEntryStillOnStack": state_after,
                    "dialogCount": page.locator('[role="dialog"]').count(),
                }
            )
            shoot(page, case, f"closed-by-{method}")

        case.record(methods=methods)
        for entry in methods:
            label = entry["method"]
            case.check(entry["pushedOnOpen"], f"[{label}] opening pushes the sheet's own entry")
            case.check(entry["dialogCount"] == 0, f"[{label}] the sheet is closed")
            case.check(
                entry["focused"] is not None and entry["focused"].get("probe") == "1",
                f"[{label}] focus returns to the button that opened the sheet",
                focused=entry["focused"],
            )
            case.check(
                not entry["sheetEntryStillOnStack"],
                f"[{label}] the sheet's history entry is taken back off the stack",
                stillOnStack=entry["sheetEntryStillOnStack"],
            )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r3_box_extreme_layout(harness: Harness, case: CaseResult) -> None:
    """R3: the extreme player table fits 375/390/430px, in both themes, sticky intact."""
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, viewport={"width": 375, "height": 844})
    attach_logging(page, case)
    try:
        goto(page, harness.url(f"/game?id={fixtures.EXTREME_ID}"))
        wait_detail(page)
        open_tab(page, "数据统计")
        page.wait_for_selector("table")
        settle(page, 400)

        measured: list[dict[str, Any]] = []
        for width in (375, 390, 430):
            page.set_viewport_size({"width": width, "height": 844})
            settle(page, 350)
            metrics = js(page, BOX_METRICS)
            measured.append(metrics)

            case.check(metrics["viewport"] == width, f"[{width}px] viewport is what was asked for", viewport=metrics["viewport"])
            case.check(
                metrics["docScrollWidth"] <= width,
                f"[{width}px] document.scrollWidth <= innerWidth (no page-wide sideways scroll)",
                document=metrics["docScrollWidth"],
                viewport=width,
            )
            case.check(
                metrics["bodyScrollWidth"] <= width,
                f"[{width}px] body.scrollWidth <= innerWidth",
                body=metrics["bodyScrollWidth"],
            )
            case.check(metrics["rowCount"] >= 15, f"[{width}px] the table really has the player rows", rows=metrics["rowCount"])
            case.check(
                metrics["headerCells"][-1:] == ["+/-"],
                f"[{width}px] the right-most column is still +/-",
                headers=metrics["headerCells"],
            )

            for row in metrics["rows"]:
                name = row["name"] or "?"
                pm = row["pm"]
                if pm is not None:
                    case.check(
                        pm["textBox"]["right"] <= width + 0.5 and pm["box"]["right"] <= width + 0.5,
                        f"[{width}px] the +/- digits of {name} end inside the viewport",
                        value=pm["value"],
                        textRight=round(pm["textBox"]["right"], 2),
                        cellRight=round(pm["box"]["right"], 2),
                    )
                    case.check(
                        pm["scrollWidth"] <= pm["clientWidth"] + 1,
                        f"[{width}px] the +/- cell of {name} does not clip its content",
                        value=pm["value"],
                        scrollWidth=pm["scrollWidth"],
                        clientWidth=pm["clientWidth"],
                    )
                for key, label in (("minutes", "时间"), ("points", "得分")):
                    cell = row.get(key)
                    if cell is None:
                        continue
                    case.check(
                        cell["box"]["left"] - 0.5 <= cell["textBox"]["left"] and cell["textBox"]["right"] <= cell["box"]["right"] + 0.5,
                        f"[{width}px] {label} of {name} stays inside its own column",
                        value=cell["value"],
                        textLeft=round(cell["textBox"]["left"], 2),
                        textRight=round(cell["textBox"]["right"], 2),
                        cellLeft=round(cell["box"]["left"], 2),
                        cellRight=round(cell["box"]["right"], 2),
                    )

            for control_group, controls in metrics["controls"].items():
                for control in controls:
                    case.check(
                        control["width"] >= 44 and control["height"] >= 44,
                        f"[{width}px] {control_group} '{control['text']}' has a >=44x44 hit area",
                        width=round(control["width"], 2),
                        height=round(control["height"], 2),
                    )
            case.check(
                {"+12", "-23", "0"} <= set(metrics["plusMinus"]),
                f"[{width}px] the extreme plus-minus values render",
                values=sorted(set(metrics["plusMinus"])),
            )

        # The long name is ellipsised by design; tapping it must reveal it whole
        # without pushing the table sideways.
        target_row = max(measured[0]["rows"], key=lambda row: len(row["name"] or ""))
        long_name = target_row["name"]
        page.set_viewport_size({"width": 375, "height": 844})
        settle(page, 250)
        name_button = page.locator(f'tbody button[aria-expanded]', has_text=long_name).first
        before_expand = js(page, BOX_METRICS)
        name_button.click()
        settle(page, 400)
        after_expand = js(page, BOX_METRICS)
        expanded_row = next((row for row in after_expand["rows"] if row["name"] == long_name), None)
        case.record(
            longName=long_name,
            truncatedBefore=target_row["nameTruncated"],
            truncatedAfter=expanded_row["nameTruncated"] if expanded_row else None,
            nameButton=target_row["nameButton"],
        )
        case.check(bool(long_name) and len(long_name) >= 5, "the fixture carries a long Chinese name", name=long_name)
        case.check(
            expanded_row is not None and expanded_row["nameTruncated"] is False,
            "tapping the name reveals it in full (no ellipsis left)",
            truncated=expanded_row["nameTruncated"] if expanded_row else None,
        )
        case.check(
            after_expand["docScrollWidth"] <= 375,
            "expanding the long name does not introduce sideways scroll",
            document=after_expand["docScrollWidth"],
        )
        shoot(page, case, "expanded-375")

        # Sticky header: still pinned after scrolling well past its natural spot.
        js(
            page,
            """() => {
                const table = document.querySelector("table");
                const top = table.getBoundingClientRect().top + window.scrollY;
                window.scrollTo(0, Math.round(top + 420));
                return top;
            }""",
        )
        settle(page, 400)
        sticky = js(page, STICKY_METRICS)
        case.record(sticky=sticky)
        case.check(sticky is not None, "a table header exists to measure")
        if sticky:
            case.check(sticky["position"] == "sticky", "the table header is still position: sticky", position=sticky["position"])
            case.check(
                20 <= sticky["top"] <= 60,
                "the sticky header pins near the score bar (44px) after scrolling",
                top=round(sticky["top"], 2),
            )
            case.check(sticky["rowsBelowHeader"] > 0, "player rows scroll beneath the pinned header", rows=sticky["rowsBelowHeader"])
            case.check(sticky["scrollY"] > 0, "the page really scrolled", scrollY=sticky["scrollY"])
        shoot(page, case, "sticky-375")

        # Dark theme: the same numeric check, not just a screenshot.
        js(page, "() => { localStorage.setItem('theme', '\"dark\"'); document.documentElement.dataset.theme = 'dark'; }")
        settle(page, 400)
        dark = js(page, BOX_METRICS)
        case.record(dark={"document": dark["docScrollWidth"], "viewport": dark["viewport"]})
        case.check(dark["docScrollWidth"] <= 375, "the dark theme has no sideways scroll either", document=dark["docScrollWidth"])
        shoot(page, case, "dark-375")
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r3_box_enlarged_font_columns(harness: Harness, case: CaseResult) -> None:
    """R3 (§2 of the repair order): bigger text must not push digits into the
    next column.

    The round-2 acceptance report measured this at 375px with the table's text
    forced to 17px: `38:55` was 44px wide inside a 41px column, and 60 numeric
    cells left their own column. Two local CSS proxies are used here, at all
    three phone widths:

      - ``root 17/18px`` — the document root's font-size, the closest local
        analogue of a user font-scale setting;
      - ``table 17/18px`` — the acceptance report's proxy, a style tag forcing
        the table's own text to 17px/18px.

    Neither is Android system font scaling (see the README). The assertion is
    numeric and per cell: its text range must stay inside its own column, the
    column must be at least as wide as the text it shows, and the cell must not
    hide content sideways. Adjacent numeric text ranges must not collide, which
    is the visible symptom ("时间与得分粘连"). A column layout that scrolls
    inside the table is allowed, as long as the page itself never scrolls
    sideways.
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, viewport={"width": 375, "height": 844})
    attach_logging(page, case)
    scales = (
        ("默认 16px", "none", None),
        ("root 17px", "root", 17),
        ("root 18px", "root", 18),
        ("table 17px", "table", 17),
        ("table 18px", "table", 18),
    )
    try:
        goto(page, harness.url(f"/game?id={fixtures.EXTREME_ID}"))
        wait_detail(page)
        open_tab(page, "数据统计")
        page.wait_for_selector("table")
        settle(page, 400)

        baseline_font = None
        rounds: list[dict[str, Any]] = []
        for width in (375, 390, 430):
            page.set_viewport_size({"width": width, "height": 844})
            settle(page, 350)
            for label, mode, px in scales:
                applied = js(page, FONT_PROXY, arg={"mode": mode, "px": px})
                settle(page, 400)
                audit = js(page, BOX_COLUMN_AUDIT)
                if baseline_font is None:
                    baseline_font = audit["cellFontPx"]
                round_name = f"[{width}px {label}]"
                rounds.append(
                    {
                        "width": width,
                        "scale": label,
                        "rootFontPx": applied["rootFontPx"],
                        "cellFontPx": audit["cellFontPx"],
                        "docScrollWidth": audit["docScrollWidth"],
                        "tableInsideViewport": audit["tableInsideViewport"],
                        "scroller": audit["scroller"],
                        "offenders": len(audit["offenders"]),
                        "overlaps": len(audit["overlaps"]),
                    }
                )

                case.check(
                    audit["viewport"] == width,
                    f"{round_name} viewport is what was asked for",
                    viewport=audit["viewport"],
                )
                case.check(
                    audit["docScrollWidth"] <= width,
                    f"{round_name} document.scrollWidth <= innerWidth",
                    document=audit["docScrollWidth"],
                    viewport=width,
                )
                case.check(
                    audit["headers"] == ["球员", "时间", "得分", "篮板", "助攻", "投篮", "三分", "+/-"],
                    f"{round_name} the eight columns are all still there",
                    headers=audit["headers"],
                )
                case.check(
                    audit["rowCount"] >= 16,
                    f"{round_name} the long-name side really has its rows",
                    rows=audit["rowCount"],
                )
                case.check(
                    fixtures.ENLARGED_LONG_NAME in audit["names"],
                    f"{round_name} the {len(fixtures.ENLARGED_LONG_NAME)}-character name is on screen",
                    names=[name for name in audit["names"] if name][:3],
                )
                for expected in (fixtures.ENLARGED_MINUTES, fixtures.ENLARGED_FG, fixtures.ENLARGED_THREE, str(fixtures.ENLARGED_PM)):
                    case.check(
                        expected in audit["values"],
                        f"{round_name} the widest value {expected!r} is still rendered",
                        values=sorted(set(value for value in audit["values"] if value))[:12],
                    )
                case.check(
                    not audit["offenders"],
                    f"{round_name} every numeric cell stays inside its own column",
                    offenders=audit["offenders"][:6],
                    count=len(audit["offenders"]),
                )
                case.check(
                    not audit["overlaps"],
                    f"{round_name} neighbouring numbers do not collide",
                    overlaps=audit["overlaps"][:6],
                    count=len(audit["overlaps"]),
                )
                case.check(
                    audit["tableInsideViewport"] or bool(audit["scroller"]),
                    f"{round_name} the table is reachable: inside the viewport or in an in-table scroller",
                    tableRight=round(audit["table"]["right"], 2),
                    scroller=audit["scroller"],
                )
                if mode == "table":
                    # This proxy must actually have enlarged the text, or the
                    # round would pass by measuring the default layout again.
                    case.check(
                        audit["cellFontPx"] is not None and audit["cellFontPx"] >= float(px) - 0.5,
                        f"{round_name} the proxy really enlarged the cell text",
                        cellFontPx=audit["cellFontPx"],
                        requested=px,
                    )

        case.record(
            fixtureLongName=fixtures.ENLARGED_LONG_NAME,
            baselineCellFontPx=baseline_font,
            rounds=rounds,
        )
        page.set_viewport_size({"width": 375, "height": 844})
        settle(page, 300)
        shoot(page, case, "enlarged-table-375")
        js(page, FONT_PROXY, arg={"mode": "root", "px": 18})
        settle(page, 400)
        shoot(page, case, "enlarged-root-375")
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r3_box_narrow_screen_readable(harness: Harness, case: CaseResult) -> None:
    """R3 addendum: a 320px screen and enlarged text — digits whole, name readable.

    The closeout review measured two things on the narrow side: at 320px with the
    table's text forced to 18px the whole page scrolled sideways (332 > 320), and
    at 375px with the same proxy the player column was squeezed to 27px, so a long
    name showed its first character and nothing else.

    Both are answered the same way, because the digits are not allowed to shrink,
    elide or overlap: the name column keeps a floor, and when the columns together
    are wider than the space available the table itself becomes the thing that
    scrolls — the page still must not. This case measures the page, every numeric
    cell, how many characters of the longest name are actually visible, and the
    default 375px layout, which must stay exactly as the accepted round
    measured it (no scroller, sticky header alive, all eight columns on screen).
    """
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, viewport={"width": 320, "height": 844})
    attach_logging(page, case)
    rounds = (
        ("320px table 18px", 320, "table", 18),
        ("320px table 17px", 320, "table", 17),
        ("375px table 18px", 375, "table", 18),
        ("375px default", 375, "none", None),
    )
    try:
        goto(page, harness.url(f"/game?id={fixtures.EXTREME_ID}"))
        wait_detail(page)
        open_tab(page, "数据统计")
        page.wait_for_selector("table")
        settle(page, 400)

        measured: list[dict[str, Any]] = []
        for label, width, mode, px in rounds:
            page.set_viewport_size({"width": width, "height": 844})
            settle(page, 300)
            applied = js(page, FONT_PROXY, arg={"mode": mode, "px": px})
            settle(page, 400)
            audit = js(page, BOX_COLUMN_AUDIT)
            name = js(page, NAME_COLUMN)
            measured.append(
                {
                    "label": label,
                    "width": width,
                    "cellFontPx": audit["cellFontPx"],
                    "rootFontPx": applied["rootFontPx"],
                    "docScrollWidth": audit["docScrollWidth"],
                    "tableInsideViewport": audit["tableInsideViewport"],
                    "scroller": audit["scroller"],
                    "offenders": audit["offenders"][:4],
                    "overlaps": audit["overlaps"][:4],
                    "name": name,
                    "rowCount": audit["rowCount"],
                    "headers": audit["headers"],
                }
            )

            case.check(
                audit["docScrollWidth"] <= width,
                f"[{label}] the page itself does not scroll sideways",
                document=audit["docScrollWidth"],
                viewport=width,
            )
            case.check(
                audit["headers"] == ["球员", "时间", "得分", "篮板", "助攻", "投篮", "三分", "+/-"],
                f"[{label}] all eight columns are still rendered",
                headers=audit["headers"],
            )
            case.check(
                not audit["offenders"],
                f"[{label}] every digit stays whole inside its own column",
                offenders=audit["offenders"][:4],
            )
            case.check(
                not audit["overlaps"],
                f"[{label}] neighbouring numbers do not collide",
                overlaps=audit["overlaps"][:4],
            )
            case.check(
                audit["tableInsideViewport"] or bool(audit["scroller"]),
                f"[{label}] the table is reachable: inside the viewport or scrollable itself",
                tableRight=round(audit["table"]["right"], 2),
                scroller=audit["scroller"],
            )
            case.check(
                isinstance(name, dict) and name["visibleChars"] >= 4,
                f"[{label}] the longest name shows more than its first character",
                name=name,
            )
            case.check(
                isinstance(name, dict) and name["text"] == fixtures.ENLARGED_LONG_NAME,
                f"[{label}] the measured name is the fixture's long one",
                text=(name or {}).get("text"),
            )

        default_round = measured[-1]
        case.check(
            default_round["scroller"] is None and default_round["tableInsideViewport"],
            "[375px default] the accepted compact layout is untouched: no scroller, table on screen",
            scroller=default_round["scroller"],
            tableInsideViewport=default_round["tableInsideViewport"],
        )
        case.check(
            default_round["cellFontPx"] is not None and default_round["cellFontPx"] < 14,
            "[375px default] the default round really is the small-text layout",
            cellFontPx=default_round["cellFontPx"],
        )

        # The sticky header has to stay sticky exactly where it did before: the
        # page-scrolling layout is the accepted one, and a horizontal scroller
        # around the table would quietly take the sticky containing block away.
        js(
            page,
            """() => {
                const table = document.querySelector("table");
                const top = table.getBoundingClientRect().top + window.scrollY;
                window.scrollTo(0, Math.round(top + 420));
                return top;
            }""",
        )
        settle(page, 400)
        sticky = js(page, STICKY_METRICS)
        case.record(sticky=sticky)
        case.check(sticky is not None and sticky["position"] == "sticky", "the default layout keeps position: sticky", sticky=sticky)
        if sticky:
            case.check(
                20 <= sticky["top"] <= 60,
                "the sticky header still pins near the score bar at 375px",
                top=round(sticky["top"], 2),
            )
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
        case.record(rounds=measured)
    finally:
        close_context(context, api, case, page)


def case_r4_missing_player_data(harness: Harness, case: CaseResult) -> None:
    """R4: the player table says what it is missing, per side and per state."""
    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    try:
        # (a) team stats present, both player lists empty.
        goto(page, harness.url(f"/game?id={fixtures.STATS_ONLY_ID}"))
        wait_detail(page)
        open_tab(page, "数据统计")
        settle(page, 300)
        panel = js(page, "() => document.querySelector('[role=tabpanel]').innerText")
        tables = int(js(page, "() => document.querySelectorAll('#panel-box table').length"))
        switches = int(js(page, "() => document.querySelectorAll('[role=\"tablist\"][aria-label=\"选择球队\"] [role=\"tab\"]').length"))
        case.record(statsOnlyPanel=panel, statsOnlyTables=tables, statsOnlySwitches=switches)
        shoot(page, case, "stats-with-empty-rows")
        case.check("暂时读不到球员数据" in panel, "an empty player list says so instead of showing a bare table", panel=panel[:200])
        case.check(tables == 0, "no player table is rendered with zero rows beneath it", tables=tables)
        case.check(switches == 2, "the team switch stays available", tabs=switches)

        # The rest of the tab must still work: this is not an error page for the tab.
        open_tab(page, "概览")
        overview = js(page, "() => document.querySelector('[role=tabpanel]').innerText")
        case.record(overviewPanel=overview[:300])
        case.check("篮板" in overview, "the overview tab still shows the team stats that did arrive", panel=overview[:200])
        case.check("暂时读不到球员数据" not in overview, "the empty state belongs to the box tab only")

        # (b) only the home side published players.
        goto(page, harness.url(f"/game?id={fixtures.ONE_SIDE_ID}"))
        wait_detail(page)
        open_tab(page, "数据统计")
        settle(page, 300)
        one_side_panel = js(page, "() => document.querySelector('[role=tabpanel]').innerText")
        tables = int(js(page, "() => document.querySelectorAll('#panel-box table').length"))
        case.record(oneSideInitialPanel=one_side_panel, oneSideTables=tables)
        shoot(page, case, "one-side-empty")
        case.check("这一侧暂无技术统计" in one_side_panel, "the empty side gets its own sentence", panel=one_side_panel[:200])
        case.check("勇士" in one_side_panel, "that sentence names the side it is about", panel=one_side_panel[:200])
        case.check(tables == 0, "no table is drawn for the empty side", tables=tables)

        page.get_by_role("tab", name="湖人", exact=True).click()
        settle(page, 350)
        other_panel = js(page, "() => document.querySelector('[role=tabpanel]').innerText")
        rows = int(js(page, "() => document.querySelectorAll('#panel-box tbody tr').length"))
        case.record(otherSidePanel=other_panel[:200], otherSideRows=rows)
        shoot(page, case, "one-side-populated")
        case.check(rows > 0, "the populated side renders its player rows", rows=rows)
        case.check("暂时读不到球员数据" not in other_panel, "the populated side shows no empty state")

        # (c) genuinely not started must not read as a failure, and vice versa.
        goto(page, harness.url(f"/game?id={fixtures.UPCOMING_ID}"))
        wait_pre_game(page)
        upcoming_text = js(page, "() => document.body.innerText")
        case.record(upcomingBody=upcoming_text[:500])
        shoot(page, case, "upcoming-pregame")
        case.check("VS" in upcoming_text, "a game that has not started shows the matchup board", body=upcoming_text[:200])
        case.check("离开赛" in upcoming_text, "and shows when it tips off", body=upcoming_text[:200])
        case.check("未开始" in upcoming_text, "and says the game has not started", body=upcoming_text[:200])
        case.check("暂时读不到球员数据" not in upcoming_text, "a not-started game is not reported as a read failure")
        upcoming_tabs = int(js(page, "() => document.querySelectorAll('[role=tab]').length"))
        case.check(upcoming_tabs == 0, "the pre-game view does not show dead detail tabs", tabs=upcoming_tabs)

        goto(page, harness.url(f"/game?id={fixtures.LIVE_EMPTY_ID}"))
        wait_detail(page)
        open_tab(page, "数据统计")
        settle(page, 300)
        live_panel = js(page, "() => document.querySelector('[role=tabpanel]').innerText")
        case.record(liveEmptyPanel=live_panel)
        case.check("暂时读不到球员数据" in live_panel, "a live game with nothing readable is a read failure", panel=live_panel[:200])
        case.check("尚未开始" not in live_panel, "a live game is never described as not started")
        case.check("数据源暂时没有返回" in live_panel, "the failure names the missing source", panel=live_panel[:200])
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def _notice_case(
    harness: Harness,
    case: CaseResult,
    *,
    name: str,
    api: fixtures.Api,
    date_key: str,
    expect_notice: bool,
    expect_parts: tuple[str, ...] = (),
    forbid_parts: tuple[str, ...] = (),
    source_parts: tuple[str, ...] = (),
    source_forbid_receive: bool = False,
    expect_segment: tuple[str, ...] = (),
) -> None:
    """Shared body of the four provenance cases.

    The exact wording of a notice belongs to the product, not to this file, so
    the copy assertions use the shortest phrase that still identifies the
    category ("部分", "缓存", …) and the timestamps are asserted separately.
    `expect_segment` is stricter where the requirement is structural: every named
    word must sit in the *same* ` · `-separated segment of the line.
    """
    context, page = new_context(harness.browser, api)
    attach_logging(page, case)
    try:
        goto(page, harness.url(f"/?date={date_key}"))
        cards = wait_games(page, 5)
        settle(page, 500)
        notice = js(page, NOTICE_TEXT)
        state = js(page, "() => document.querySelector('main').innerText")
        text = notice["text"] or ""
        segments = [segment.strip() for segment in re.split(r"·", text)] if text else []
        case.record(
            cards=cards,
            noticeCount=notice["count"],
            noticeText=notice["text"],
            noticeSegments=segments,
            sourceSegment=notice["sourceSegment"],
            listHead=state[:240],
        )
        shoot(page, case, name)

        case.check(cards >= 5, "the list is non-empty, so the notice is about a real list", cards=cards)
        if expect_notice:
            case.check(notice["count"] >= 1, "a provenance notice is shown", count=notice["count"])
            for part in expect_parts:
                case.check(part in text, f"the notice names {part!r}", text=text)
            for part in forbid_parts:
                case.check(part not in text, f"the notice does not say {part!r}", text=text)
            if expect_segment:
                hit = any(all(part in segment for part in expect_segment) for segment in segments)
                case.check(
                    hit,
                    f"one notice segment carries {' + '.join(expect_segment)}",
                    segments=segments,
                )
            if source_parts:
                segment = notice["sourceSegment"] or ""
                case.check(segment != "", "the notice carries a 来源时间 line", text=text)
                for part in source_parts:
                    case.check(part in segment, f"the 来源时间 is the upstream time ({part!r})", segment=segment)
                if source_forbid_receive:
                    receive = url_parts(page)["receiveLabel"]
                    case.check(
                        receive not in segment,
                        "the 来源时间 is not the browser's receive time",
                        segment=segment,
                        receiveTime=receive,
                    )
        else:
            case.check(notice["count"] == 0, "a complete, current payload shows no notice", text=notice["text"])
        case.check(not case.page_errors, "no uncaught page error", errors=case.page_errors)
    finally:
        close_context(context, api, case, page)


def case_r5_partial_notice(harness: Harness, case: CaseResult) -> None:
    """R5: a non-empty list with partial coverage admits it, with the source time."""
    api = fixtures.Api(scenario="partial", all_final=True)
    _notice_case(
        harness,
        case,
        name="partial",
        api=api,
        date_key=fixtures.SOURCE_DATE,
        expect_notice=True,
        expect_parts=("部分", "来源时间"),
        forbid_parts=("更新于",),
        source_parts=fixtures.STALE_SOURCE_PARTS,
        source_forbid_receive=True,
    )


def case_r5_last_good_notice(harness: Harness, case: CaseResult) -> None:
    """R5: a kept copy from an earlier round is marked as not revalidated."""
    api = fixtures.Api(scenario="last-good")
    _notice_case(
        harness,
        case,
        name="last-good",
        api=api,
        date_key=fixtures.SOURCE_DATE,
        expect_notice=True,
        expect_parts=("刷新", "此后未更新", "来源时间"),
        forbid_parts=("更新于",),
        source_parts=fixtures.STALE_SOURCE_PARTS,
        source_forbid_receive=True,
    )


def case_r5_offline_cache_notice(harness: Harness, case: CaseResult) -> None:
    """R5: a service-worker cache hit is marked offline, with its own write time.

    The body carries a complete, live-looking freshness record; the offline part
    arrives only as the two headers `public/sw.js` adds when it replays a cached
    response. The cache wording proves the client honoured them, and the upstream
    time plus the cache write time prove the two are kept apart. The write time
    must be labelled *with* the cache, hence the single-segment assertion.
    """
    api = fixtures.Api(scenario="cache")
    _notice_case(
        harness,
        case,
        name="offline-cache",
        api=api,
        date_key=fixtures.SOURCE_DATE,
        expect_notice=True,
        expect_parts=("缓存", "来源时间"),
        forbid_parts=("更新于", "只有部分数据源返回"),
        source_parts=fixtures.STALE_SOURCE_PARTS,
        source_forbid_receive=True,
        expect_segment=("缓存", fixtures.CACHE_WRITTEN_PARTS[0], fixtures.CACHE_WRITTEN_PARTS[1]),
    )


def case_r5_live_control_silent(harness: Harness, case: CaseResult) -> None:
    """R5 control: when everything answered, the notice must stay silent."""
    api = fixtures.Api(scenario="live", all_final=True)
    _notice_case(
        harness,
        case,
        name="live-control",
        api=api,
        date_key=fixtures.SOURCE_DATE,
        expect_notice=False,
    )


def case_harness_no_external_requests(harness: Harness, case: CaseResult) -> None:
    """The suite's own fence: nothing may leave the machine while it runs.

    The pattern checks alone would only prove the regex, so the fence is also
    exercised live: the page is asked to fetch a reserved `.invalid` host (which
    can never resolve) and the request must be intercepted and aborted before it
    is sent. That fetch is expected to show up in this context's own list, which
    is why the list is cleared before the context is closed — the global
    assertion below is about the *product* code, not about this deliberate probe.
    """
    case.record(externalRequests=list(EXTERNAL_REQUESTS), fixtureHits=dict(FIXTURE_HITS))
    for url in ("https://cdn.nba.com/static/json/liveData/scoreboard.json", "http://example.com/x"):
        case.check(
            fixtures.EXTERNAL_URL.search(url) is not None,
            f"the fence pattern matches a remote host ({url.split('/')[2]})",
        )
    for url in (f"{harness.base_url}/api/games?date=x", "http://127.0.0.1:3100/", "http://localhost:3210/"):
        case.check(fixtures.EXTERNAL_URL.search(url) is None, f"the fence pattern leaves {url} alone")

    api = fixtures.Api(scenario="live")
    context, page = new_context(harness.browser, api, favorites=None)
    try:
        goto(page, harness.url("/"))
        wait_games(page, 1)
        outcome = js(
            page,
            """() => fetch('https://fixture-probe.invalid/should-never-be-sent')
                       .then(() => 'resolved').catch(() => 'blocked')""",
        )
        case.record(fenceProbeOutcome=outcome, fenceProbeSeen=list(api.external_requests))
        case.check(outcome == "blocked", "a fetch to a remote host is blocked in the page", outcome=outcome)
        case.check(
            any("fixture-probe.invalid" in url for url in api.external_requests),
            "the blocked request was recorded by the fence",
            seen=api.external_requests,
        )
    finally:
        api.external_requests.clear()
        close_context(context, api, case, page)

    case.check(
        EXTERNAL_REQUESTS == [],
        "no request left the local dev server during the whole run",
        requests=EXTERNAL_REQUESTS,
    )
    case.check(
        sum(FIXTURE_HITS.values()) > 0,
        "the fixture layer actually served the run",
        hits=sum(FIXTURE_HITS.values()),
    )


CASES: tuple[tuple[str, str, Callable[[Harness, CaseResult], None]], ...] = (
    ("r1_back_restores_list", "R1 visible back restores date, filter and position", case_r1_back_restores_list),
    ("r1_deep_link_lands_on_today", "R1 deep link falls back to today", case_r1_deep_link_lands_on_today),
    ("r1_tap_return_spends_identity", "R1 a real tap returns and spends the return identity", case_r1_tap_return_spends_identity),
    ("r1_reentry_starts_at_top", "R1 a fresh entry to the list starts at the top", case_r1_reentry_starts_at_top),
    ("r1_stale_marker_deep_link", "R1 a stale marker must not send back into an unrelated page", case_r1_stale_marker_deep_link_falls_back_home),
    ("r1_browser_back_restores_list", "R1 the browser's own back button restores the position", case_r1_browser_back_restores_list),
    ("r1_quick_switch_during_restore", "R1 switching day or filter mid-restore keeps the new list at the top", case_r1_quick_switch_during_restore),
    ("r1_back_after_dwell", "R1 a detail page left open still returns correctly", case_r1_back_after_dwell),
    ("r1_modified_click_isolation", "R1 Ctrl-click and middle-click do not write this tab's identity", case_r1_modified_click_isolation),
    ("r1_each_return_keeps_its_own_offset", "R1 three returns from one list keep their own offsets", case_r1_each_return_keeps_its_own_offset),
    ("r1_new_tab_copy_no_back_authority", "R1 a copied storage cannot authorize a detail return", case_r1_new_tab_copy_has_no_back_authority),
    ("r1_same_tab_reentry_no_back_authority", "R1 a same-tab re-entry cannot authorize a detail return", case_r1_same_tab_reentry_has_no_back_authority),
    ("r1_detail_reload_keeps_the_return", "R1 a reloaded detail entry still returns to its list", case_r1_detail_reload_keeps_the_return),
    ("r1_scroll_restoration_handed_back", "R1 the restore mode is taken over and handed back", case_r1_scroll_restoration_is_handed_back),
    ("r2_sheet_multiselect_and_back", "R2 multi-select does not touch history; back closes once", case_r2_sheet_multiselect_and_back),
    ("r2_sheet_manual_close_focus", "R2 manual close returns focus to the trigger", case_r2_sheet_manual_close_focus),
    ("r3_box_extreme_no_overflow", "R3 extreme player table fits 375/390/430px with sticky header", case_r3_box_extreme_layout),
    ("r3_box_enlarged_font_columns", "R3 enlarged text keeps every digit inside its column (CSS proxy)", case_r3_box_enlarged_font_columns),
    ("r3_box_narrow_screen_readable", "R3 320px and enlarged text: page fits, digits whole, name readable", case_r3_box_narrow_screen_readable),
    ("r4_missing_player_data", "R4 missing player data is stated per side and per state", case_r4_missing_player_data),
    ("r5_partial_notice", "R5 non-empty partial coverage is announced", case_r5_partial_notice),
    ("r5_last_good_notice", "R5 a kept copy is marked as not revalidated", case_r5_last_good_notice),
    ("r5_offline_cache_notice", "R5 a cache hit is marked offline with its write time", case_r5_offline_cache_notice),
    ("r5_live_control_silent", "R5 control: a complete payload shows no notice", case_r5_live_control_silent),
    ("harness_no_external_requests", "Harness fence: the run never left the machine", case_harness_no_external_requests),
)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Committed browser regression (synthetic fixtures, local server only).")
    parser.add_argument("--base-url", default=os.environ.get("DSH_BROWSER_BASE_URL") or None,
                        help="run against an already-running server, e.g. http://127.0.0.1:3100")
    parser.add_argument("--port", type=int, default=int(os.environ.get("DSH_BROWSER_PORT") or DEFAULT_PORT),
                        help=f"port to start the dev server on when one is needed (default {DEFAULT_PORT})")
    parser.add_argument("--only", default=None, help="run only cases whose name contains this substring")
    parser.add_argument("--list", action="store_true", help="list case names and exit")
    parser.add_argument("--out", default=None, help="where to write the JSON result (default tests/browser/artifacts/results.json)")
    parser.add_argument("--keep-server", action="store_true", help="leave a dev server this run started running")
    parser.add_argument("--no-reuse", action="store_true", help="fail instead of reusing a dev server already running in this tree")
    parser.add_argument("--show", action="store_true", help="show the browser window (debugging)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.list:
        for name, title, _ in CASES:
            log(f"{name}\t{title}")
        return 0

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else ARTIFACTS / "results.json"

    problems = fixtures.assert_fixture_invariants()
    if problems:
        log("[harness] fixture invariants failed:")
        for problem in problems:
            log(f"  - {problem}")
        return 1

    started = time.monotonic()
    base_url, server, server_info = ensure_server(args)
    log(f"[harness] base url: {base_url} ({server_info['mode']})")

    selected = [entry for entry in CASES if args.only is None or args.only in entry[0]]
    if not selected:
        log(f"[harness] no case matches --only {args.only!r}")
        return 1

    results: list[CaseResult] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not args.show)
        chromium_version = browser.version
        harness = Harness(browser, base_url)
        try:
            log("[harness] warming the dev server up (first compile is the slow one)")
            warm = fixtures.Api(scenario="live")
            warm_context, warm_page = new_context(browser, warm, viewport=dict(DEFAULT_VIEWPORT))
            try:
                goto(warm_page, harness.url("/"), wait_until="domcontentloaded", timeout=WARMUP_TIMEOUT_MS)
                wait_games(warm_page, 5, timeout=WARMUP_TIMEOUT_MS)
            finally:
                warm_context.close()

            for name, title, runner in selected:
                case = CaseResult(name=name, title=title)
                started_case = time.monotonic()
                try:
                    runner(harness, case)
                    case.status = "PASS" if all(check["ok"] for check in case.checks) else "FAIL"
                except PlaywrightTimeoutError as error:
                    case.status = "FAIL"
                    case.error = f"timeout: {error}"[:600]
                except Exception:  # noqa: BLE001 - a case must never abort the suite
                    case.status = "FAIL"
                    case.error = traceback.format_exc()[-1500:]
                case.duration_ms = int((time.monotonic() - started_case) * 1000)
                results.append(case)
                log(f"[{case.status}] {case.name} ({case.duration_ms} ms)")
                for check in case.checks:
                    if not check["ok"]:
                        log(f"         - {check['label']}: {json.dumps({k: v for k, v in check.items() if k not in ('label', 'ok')}, ensure_ascii=False)[:400]}")
                if case.error:
                    log(f"         ! {case.error.splitlines()[-1][:300]}")
        finally:
            browser.close()

        if server is not None and not args.keep_server:
            server.stop()

        payload = {
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "boundary": (
                "Headless Chromium mobile viewports against the project's own dev server, with hand-written "
                "synthetic fixtures for every /api/** answer. NOT Android/WebView, NOT the real NBA network, "
                "NOT a real service-worker offline navigation."
            ),
            "fixturesAreSynthetic": True,
            "baseUrl": base_url,
            "server": server_info,
            "python": sys.version.split()[0],
            "chromium": chromium_version,
            "durationMs": int((time.monotonic() - started) * 1000),
            "summary": {
                "total": len(results),
                "passed": sum(1 for case in results if case.status == "PASS"),
                "failed": sum(1 for case in results if case.status != "PASS"),
                "checks": sum(len(case.checks) for case in results),
                "checksFailed": sum(1 for case in results for check in case.checks if not check["ok"]),
            },
            "externalRequests": EXTERNAL_REQUESTS,
            "fixtureHits": FIXTURE_HITS,
            "tests": [
                {
                    "name": case.name,
                    "title": case.title,
                    "status": case.status,
                    "durationMs": case.duration_ms,
                    "checks": case.checks,
                    "data": case.data,
                    "screenshots": case.screenshots,
                    "console": case.console[:40],
                    "pageErrors": case.page_errors,
                    "error": case.error,
                }
                for case in results
            ],
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = payload["summary"]
    log("")
    log(f"PASS {summary['passed']}/{summary['total']} cases, {summary['checks'] - summary['checksFailed']}/{summary['checks']} checks, "
        f"{payload['durationMs']} ms")
    log(f"result JSON: {out_path}")
    log(f"artifacts:   {ARTIFACTS}")
    for case in results:
        if case.status != "PASS":
            log(f"FAILED: {case.name}")
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
