# Tests

Two suites, two jobs. Neither one starts a build, and neither one touches the
network: the pure tests import the app's own TypeScript, the browser suite talks
only to a local dev server with mocked `/api/**`.

## `pnpm test` — pure and service-level regression (no browser)

```powershell
pnpm test        # node --test --import ./tests/register.mjs "tests/**/*.test.ts"
```

Node's own test runner, no framework, no new dependencies.
[register.mjs](register.mjs) installs [resolve-hooks.mjs](resolve-hooks.mjs),
which teaches Node the `@/` alias, extensionless relative imports and the JSON
import attribute, so the tests import `src/**` exactly as it is written.

| file | what it locks down |
|---|---|
| [format.test.ts](format.test.ts) | local-day windows and the time/clock/percentage formatters |
| [game-state.test.ts](game-state.test.ts) | merge rules (a degraded payload may not move a game backwards), `detailAvailability`, `boxAvailability`, the freshness notice wording |
| [storage-validators.test.ts](storage-validators.test.ts) | the `localStorage` boundary: wrong-shaped values degrade instead of crashing the page |
| [freshness.test.ts](freshness.test.ts) | provenance classification and the stale/partial rules, including "a final is not stale merely for being old" |
| [guards.test.ts](guards.test.ts) | upstream structural guards: `[null]` is rejected, a legal empty array is not |
| [nba-service.test.ts](nba-service.test.ts) | service-layer degradation with injected upstream responses — last-good schedule retention, the plays route refusing to pretend a game has not started |
| [polling.test.ts](polling.test.ts) | the poll loop with a fake clock: wake coalescing, one in-flight request, a slow response never overwriting a newer one |
| [day-change.test.ts](day-change.test.ts) | the local-midnight chain and the timezone-change reschedule |
| [service-worker.test.ts](service-worker.test.ts) | `public/sw.js` driven with `caches`/`fetch` injected: the offline copy is marked, push status is never cached |
| [game-stage-series.test.ts](game-stage-series.test.ts) | competition classification, excluding preseason records, playoff series scope and home/away swaps |
| [standings.test.ts](standings.test.ts) | season/type validation, complete conferences, tied official ranks, unopened-season boundaries and a captured upstream fixture |

Prerequisites: Node 22+ and `node_modules`. Nothing else — no browser, no
Android SDK, no network.

## `pnpm test:browser` — browser regression (Playwright)

```powershell
pnpm test:browser    # = python tests/browser/run.py
```

Prerequisites: Python 3 with `playwright` and a Chromium build
(`python -m playwright install chromium`), plus this project's `node_modules`
(it may start the dev server itself). The suite serves every `/api/**` response
from hand-written mock fixtures and aborts any request that is not the local dev
server.

It covers what only a browser can prove — the visible back path, the favourites
sheet's history lifecycle, the player table's real layout at 375/390/430px,
missing-player states, and the offline/partial provenance notices. See
[browser/README.md](browser/README.md) for the case-by-case table, the port and
`BASE_URL` options, and the list of things it deliberately does **not** cover
(Android, real NBA traffic, a real service-worker offline reload).

`tests/browser/artifacts/` is a runtime directory: screenshots, the result JSON
and the dev-server log are written there and ignored by git.

## Which suite owns which requirement

| requirement | where |
|---|---|
| R1 back path / deep link | browser |
| R2 favourites sheet history and focus | browser |
| R3 player table layout, sticky header, 44px targets | browser |
| R4 missing-player states per tab and per side | browser |
| R5 partial / last-good / offline-cache notices | browser (rendering) + `freshness.test.ts`, `service-worker.test.ts` (rules) |
| R6 merge, guards, service degradation | `game-state.test.ts`, `guards.test.ts`, `nba-service.test.ts`, `freshness.test.ts` |
| R7 polling wake, timezone timer | `polling.test.ts`, `day-change.test.ts` |
| R8 CI gate | `.github/workflows/android.yml` runs `pnpm lint`, `pnpm typecheck` and `pnpm test` before packaging. The browser suite is **not** part of CI: it needs a Chromium install plus a dev server, so it stays a local/manual gate (`pnpm test:browser`). |
