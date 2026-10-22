# Browser regression (`tests/browser`)

The committed home for the checks that only a real browser can make: real
layout (does the table overflow?), real hit areas (is the button 44px?), real
history (`history.back()` closes the sheet), real scroll restoration.

Everything here is deterministic and offline. Every `/api/**` answer comes from
the hand-written mock payloads in [fixtures.py](fixtures.py); nothing is copied
from the NBA feeds, and a request to any host other than the local dev server is
aborted, recorded, and fails the run.

## Running it

```powershell
pnpm test:browser                  # = python tests/browser/run.py
python tests/browser/run.py        # the same thing
python tests/browser/season-context.py --base-url http://127.0.0.1:3210
```

`season-context.py` uses synthetic API responses for competition labels,
regular-season records, playoff series, both 15-team conference tables,
spoiler handling, stale data, deep-link return and 320/360/430px layouts.
Its enlarged-font check is a browser layout proxy, not Android text zoom.

Useful flags:

| flag | what it does |
|---|---|
| `--base-url http://127.0.0.1:3100` | run against a server that is already up (no server is started) |
| `--port 3210` | port to start the dev server on (default `3210`, or `$env:DSH_BROWSER_PORT`) |
| `--only r3` | run only the cases whose name contains this substring |
| `--list` | print the case names and exit |
| `--keep-server` | leave a dev server this run started running (debugging) |
| `--no-reuse` | fail instead of reusing a dev server that already holds this project |
| `--out path.json` | write the result JSON somewhere other than `artifacts/results.json` |
| `--show` | show the browser window |

Environment variables: `DSH_BROWSER_BASE_URL` (same as `--base-url`),
`DSH_BROWSER_PORT` (same as `--port`).

Exit code is `0` when every case passed, `1` otherwise. Progress is printed one
line per case; every failed check prints its measured values.

## What it needs

- **Windows or any OS with Python 3** — the runner is plain `python` + stdlib.
- **`playwright` for Python with a Chromium build installed**
  (`python -m playwright install chromium`). The runner lets Playwright resolve
  its own browser; it does not hard-code a path.
- **Node and this project's `node_modules`** — only because the runner may need
  to start the dev server.
- No network access, no NBA data, no APK, no Android SDK.

## Which server it talks to

1. `--base-url` / `$env:DSH_BROWSER_BASE_URL` given → use it, start nothing.
   Any server that answers with the app works: a dev server, a `next start`
   production server, or a static `build:app` export served from `out/`. Card
   hrefs are matched as `a[href^="/game"]`, so the export's `/game/?id=` shape
   (`trailingSlash`) is driven the same way as the web build's `/game?id=`.
2. Otherwise `http://127.0.0.1:<port>`; if something already answers there, use it.
3. Otherwise start `node node_modules/next/dist/bin/next dev --port <port>`
   (the same thing `pnpm dev` runs) and stop it when the run ends.
4. **Next 16 refuses to run two dev servers in one project directory.** If the
   start is refused because another dev server already serves *this same working
   tree*, the run prints that it is doing so, reuses that server, and records
   `server.mode = "reused-existing-dev-server"` in the result JSON. Pass
   `--no-reuse` if you would rather see it fail.

The `server` object in `results.json` always says which of these happened, so a
result can never be read as "it started its own server" when it did not.

## What is covered

| case | requirement | how it is proved |
|---|---|---|
| `r1_back_restores_list` | R1 — the visible back control restores date, 关注 filter and reading position | scrolls the list, taps a card that is **already in the viewport** (so the tap itself cannot move the page), reads the origin the app recorded in `sessionStorage`, then clicks the control and compares the URL, the date picker and `window.scrollY` |
| `r1_deep_link_lands_on_today` | R1 — a cold/deep link falls back to today's home | opens a detail page with no list behind it, asserts no recorded origin, clicks back, asserts `/` with an empty query and today's date |
| `r1_tap_return_spends_identity` | R1/B1 — a real tap returns **and the identity is spent** | taps by mouse coordinates at 700px, asserts the receipt names the game that opened and carries the measured offset, then asserts that after the return `nbascore:detailOrigin` and `nbascore:detailVisit` are gone and the list entry itself reads `restored: true` |
| `r1_reentry_starts_at_top` | R1/B2 — a fresh entry to the list starts at the top | (a) after a real return, leaves for an unrelated same-origin page and navigates back to the same list URL; (b) leaves a live-looking receipt in `sessionStorage` that no tap wrote. Both must land at 0, sampled per frame, with `scrollRestoration = "manual"` forced before the app boots so only the app's own loop could have scrolled |
| `r1_stale_marker_deep_link` | R1/B1 — a stale marker must not walk back into an unrelated page | (a) the review's sequence: tap, return, open `/manifest.webmanifest`, address-navigate into another game, press back — must land on today's home with an empty query; (b) the adversarial version: a live receipt for the *first* game (`doc`, `at` and visit all current) while the second game is open — the game mismatch must still refuse the back press |
| `r1_browser_back_restores_list` | R1 — the browser's own back button also restores the position | taps a card, then `page.go_back()`: URL, date, filter and 700px must come back, and the entry must read `restored: true` (the sampler's manual `scrollRestoration` means Chromium's own restoration cannot be what passed the case) |
| `r1_quick_switch_during_restore` | R1/B2 — a restore in flight must not write the old offset onto a new list | returns from a game and immediately (while the restore loop is still running) switches the day, then repeats with the 关注→全部 filter. Both switches assert that the sampler's `scrollTo` log goes quiet within 600ms of the URL changing (a restore that survived the switch would write for the rest of its window). The day switch also ends at 0 with no frame ever showing 700; the filter switch deliberately keeps the reader's offset (`router.replace(..., { scroll: false })`), so what is asserted there is that the offset does not move by more than 2px and nothing writes it again — and a real navigation to the unfiltered URL must start at the top |
| `r1_back_after_dwell` | R1 — a detail page left open still returns correctly | sits on the detail page for four seconds, asserts the receipt survived the wait, then returns: 700px restored and the receipt spent. A page dwell, not a real Android background/foreground cycle |
| `r1_modified_click_isolation` | R1 — Ctrl-click and middle-click must not write this tab's identity | for each modifier: asserts the game opened in another tab, the current page stayed on the list at 700px, and no `nbascore:detailOrigin` / `nbascore:detailVisit` / unspent entry mark appeared; then walks the tab through an unrelated page into a game and asserts the back press lands on today's home |
| `r1_each_return_keeps_its_own_offset` | C1 — one list, three consecutive returns, three offsets | taps three cards from the same list at 300/600/900 and asserts for each that the list really sat there before the tap, that the receipt records *that* visit's offset, and that the return lands on it (300 → 300, 600 → 600, 900 → 900 — the review measured 600 and 900 both landing on 300). Also asserts the three taps produced three distinct visit tokens and that each entry mark was spent. The sampler keeps Chromium's own restoration off, so every restored number was written by the app's loop |
| `r1_new_tab_copy_no_back_authority` | C2a — a browser copy of the storage cannot authorize a return | taps a card, opens `/manifest.webmanifest` with a real `window.open`, asserts the copy carries **every** key including `nbascore:docKey` (nothing is deleted to make the case pass), then opens the *same* game in the copy and presses the app's back control: with an unrelated entry behind it, the fallback must be today's home. Asserts the copied document's detail entry carries no tap evidence |
| `r1_same_tab_reentry_no_back_authority` | C2b — leaving the tab and re-opening the same gameId | the reader leaves the tab for an unrelated same-origin document (a full document load, so `sessionStorage` survives) and then opens the same `gameId` directly: the receipt and the document key are still there, the entry carries no tap evidence, and the app's back control must reach today's home rather than the unrelated page |
| `r1_detail_reload_keeps_the_return` | C2 — the defined behaviour for a detail refresh | a reload is a new JavaScript realm over the same history entry: asserts the tap's mark is on the entry, that it is unchanged after the reload, that the session receipt from the replaced document is still in storage but is not what authorizes anything, and that the app's back control still returns to the list with date, filter and 700px |
| `r1_scroll_restoration_handed_back` | §3 — the restore mode is borrowed, not taken | records every write to `history.scrollRestoration` together with the value in effect before it (no sampler, so the mode is the browser's own `"auto"`): asserts the loop takes the entry over (`manual`) while it holds the position, that no run assigns `manual` twice in a row, that the value from before comes back at the end, that the app's own `scrollTo` did the restoring, and that a restore cancelled by a day switch also hands the mode back |
| `r2_sheet_multiselect_and_back` | R2 — multi-select touches history zero times; one back press closes the sheet; the next one goes through normal history | patches `history.pushState/replaceState/back/forward` at document start, asserts one `pushState` on open (with Next's own state preserved), zero ops across three taps, a frozen team order, then `history.back()` twice |
| `r2_sheet_manual_close_focus` | R2 — closing by hand returns focus to the trigger | Esc, the close button and the overlay each close the sheet; asserts focus lands back on the exact button that opened it and that the sheet's history entry was taken back off the stack |
| `r3_box_extreme_no_overflow` | R3 — extreme player table at 375/390/430px, sticky header | `documentElement.scrollWidth <= innerWidth`, every `+/-` cell's **text range** inside the viewport and its cell, minutes/points inside their own columns, ≥44×44 bounding boxes for the team switch, sort buttons and name buttons, tap-to-expand removes the ellipsis without adding sideways scroll, `thead` still `sticky` and pinned at 44px after scrolling, dark theme re-measured |
| `r3_box_enlarged_font_columns` | R3 §2 — bigger text keeps every digit inside its own column | 375/390/430px × five font sizes: default 16px, `root 17/18px` (document root font-size) and `table 17/18px` (the round-2 proxy: a style tag forcing the table's own text to 17px/18px). Per numeric cell: text range inside its own box, column at least as wide as the text it shows, no sideways clipping — plus "neighbouring numbers do not collide", `document.scrollWidth <= innerWidth`, and the table reachable (inside the viewport or in an `overflow-x` scroller). The fixture carries an 11-character name with `42:57` / `13-27` / `9-16` / `-28` |
| `r3_box_narrow_screen_readable` | R3 addendum — 320px and enlarged text | 320px × `table 17/18px`, 375px × `table 18px` and the 375px default: the page itself must never scroll sideways (the review measured 332 > 320), every digit stays whole in its own column, neighbouring numbers do not collide, and the longest name shows **at least four characters** instead of one. The 375px default round must stay exactly as the accepted rounds measured it: no scroller, the table inside the viewport, 13px cells and the sticky header still pinning at 44px after scrolling |
| `r4_missing_player_data` | R4 — per-tab availability | stats-but-no-players shows 「暂时读不到球员数据」 and no table while the 概览 tab still shows the stats; one populated side + one empty side gives the empty side its own sentence; upcoming reads 「尚未开始」 while a live game with nothing readable reads as a read failure |
| `r5_partial_notice` | R5 — a non-empty partial list says so, with the source time | `coverage=partial, scheduleOk=false` over a finished slate: the notice exists, carries the partial wording and the *upstream* time, and is not the receive time |
| `r5_last_good_notice` | R5 — a kept copy is marked as not revalidated | `kind=last-good`: the notice says the refresh failed and the data is the previous read |
| `r5_offline_cache_notice` | R5 — a service-worker cache hit is marked offline, with its own write time | the body looks live and complete; only the `X-DSH-From-Cache` / `X-DSH-Cached-At` headers say otherwise. Asserts the cache wording, the upstream time *and* the cache write time, and that 「更新于」 never appears |
| `r5_live_control_silent` | control | a complete, current payload shows **no** notice at all (the whole app has exactly one `role="status"`) |
| `harness_no_external_requests` | the suite's own fence | asserts no request left the local server in the whole run, and proves the fence has teeth by making the page `fetch()` a reserved `.invalid` host and checking it is blocked and recorded |

Screenshots and the result JSON land in [`artifacts/`](artifacts), which is a
runtime directory (see `artifacts/.gitignore`). They are evidence for a human,
never the assertion: every claim above is a measured number.

## What is **not** covered

Be precise about this when quoting the suite:

- **Android / real device.** No APK, no WebView, no system back gesture, no
  font scaling, no background/foreground lifecycle. This is desktop Chromium at
  phone viewport sizes.
- **Android system font scaling.** `r3_box_enlarged_font_columns` uses two local
  CSS proxies only: the document root's `font-size` (`root 17/18px`) and the
  round-2 acceptance report's override (`table 17/18px`, a style tag forcing the
  table's own text to 17px/18px). They prove the *layout capacity* under bigger
  text; they are **not** a device or emulator font-scale setting, and passing
  them does not mean "Android 字体放大通过".
- **The sticky header while the table is in its own scroller.** When enlarged text
  makes the seven numeric columns wider than the phone, the player column takes
  its floor and the table — not the page — scrolls sideways
  (`r3_box_narrow_screen_readable`). An `overflow-x` ancestor is the sticky
  header's scrollport, so in exactly that state the header no longer pins to the
  viewport; every layout the accepted rounds measured (375/390/430px at every
  font size up to an 18px root) stays a plain block and keeps the pinned header,
  which `r3_box_extreme_no_overflow` and the 375px default round both assert.
  Whether the trade is right on a real device at a real system font scale is a
  device question, not a browser one.
- **A real Android background/foreground cycle.** `r1_back_after_dwell` sits on
  the detail page for four seconds in the same document. It does not freeze the
  page, does not fire a platform visibility change and cannot prove the WebView
  lifecycle behaves the same. The reload case (`r1_detail_reload_keeps_the_return`)
  is a document reload, not a process death and restore.
- **The browser's own scroll restoration standing in for the app's.** Every case
  about the reading position (`r1_tap_return_spends_identity`,
  `r1_reentry_starts_at_top`, `r1_browser_back_restores_list`,
  `r1_quick_switch_during_restore`, `r1_back_after_dwell`) installs a
  document-start script that sets `history.scrollRestoration = "manual"` and
  samples `window.scrollY` every frame. A measured offset therefore has to have
  been written by the app's own restore loop; Chromium's automatic restoration
  cannot make one of those cases pass. The round-2 review's finding that the
  app's loop never ran on the dev server while Chromium's restoration covered
  for it was measured exactly this way
  (`_probe/round2-2026-10-11/scroll-culprit-results.json`).
- **The real NBA network.** No request leaves the machine, by design. Whether
  the CDN is reachable, fast, or stable from a phone is not tested here.
- **A real service-worker offline navigation.** `next dev` never registers the
  worker (`ServiceWorkerRegister` returns early outside production), so the
  offline case feeds the worker's marker headers through the fixture layer. It
  proves the *client's* handling of a cache hit, not that `public/sw.js` serves
  one. That needs a production build and a real offline reload.
- **Real NBA data correctness.** Scores, clocks, player lines and the fixture
  slate are invented. The Lead validates against live data separately.
- **The in-app update prompt.** The home page asks GitHub for the latest APK
  release after mount; `fixtures.py` answers that one URL with 404 (no published
  release), so no case renders the banner and the external-request fence stays
  green. The banner's three states — newer release, no newer release, GitHub
  unreachable — are verified separately in `_probe/update-2026-10-22/` with the
  release response intercepted per state.
- **Polling, guards, freshness merging and the midnight/timezone timer** —
  covered by `pnpm test` (see [../README.md](../README.md)), deliberately not
  repeated in the browser.
- **Colour contrast, font rendering and the shot chart's touch target** — not
  asserted here.
