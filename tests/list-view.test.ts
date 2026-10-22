/**
 * The return receipt, with the browser faked but the module's own rules real.
 *
 * This file exists because the second review found the *rules* wrong, not the
 * plumbing: a marker that was never consumed, a fallback with no expiry, and no
 * binding between a receipt and the navigation it claims to describe. All three
 * are decisions taken in `src/lib/client/list-view.ts`, so they are asserted
 * here without a browser, and the browser suite covers the same paths end to end
 * (`tests/browser/run.py`, cases `r6_*`).
 *
 * The fake models the two things the module reads: `sessionStorage` (a string
 * map per document) and `history.state` (one object per entry). Next 16's real
 * behaviour — extra fields survive a push and come back on the way home — was
 * measured in `_probe/round2-2026-10-11/lead-probe-trace-results.json` and is
 * what the fake reproduces.
 *
 * Every test loads its own copy of the module. That is not fussiness: the
 * module keeps this document's identity in a module-level variable precisely
 * because a document is one JavaScript realm, so a fresh realm is modelled by a
 * fresh import — and it is how the "new tab" case is expressed at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/** The module's shape, without importing it at a fixed URL. */
interface ListViewModule {
  activeDocKey(): string;
  clearDetailOrigin(): void;
  consumeListOrigin(): void;
  detailOriginFor(
    gameId: string,
    now?: number,
  ): { gameId: string; scroll: number; at: number; url: string; doc: string } | null;
  listOriginFor(
    date: string | null,
    filter: string,
    now?: number,
  ): { scroll: number; gameId: string; date: string | null; filter: string } | null;
  markDetailEntry(gameId: string, now?: number): boolean;
  readingPositionFor(current: number, tracked: number): number;
  recallDetailOrigin(now?: number): { gameId: string; at: number; doc: string; url: string } | null;
  rememberDetailOrigin(position: { date: string | null; filter: string; scroll: number }, gameId: string): void;
}

/** A `sessionStorage`/`history`/`location` triple good enough for this module. */
interface FakeBrowser {
  storage: Map<string, string>;
  history: { state: Record<string, unknown> | null };
  location: { pathname: string; search: string };
}

let documentCounter = 0;

/** Put a fresh fake in front of the module before it is imported. */
function installBrowser(): FakeBrowser {
  const storage = new Map<string, string>();
  const historyState = { state: null as Record<string, unknown> | null };
  const location = { pathname: "/", search: "?date=2026-10-09&fav=1" };

  (globalThis as Record<string, unknown>).window = {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    history: {
      get state() {
        return historyState.state;
      },
      set state(value: Record<string, unknown> | null) {
        historyState.state = value;
      },
      replaceState: (state: Record<string, unknown>) => {
        historyState.state = state;
      },
    },
    location,
    innerHeight: 800,
  };
  return { storage, history: historyState, location };
}

/**
 * One document: a fake browser plus its own realm.
 *
 * `storage` may be handed in so a *new* document can start from a copy of an old
 * one's `sessionStorage` — which is exactly what a duplicated tab does, and the
 * case a receipt must not survive.
 */
async function openDocument(storage?: Map<string, string>): Promise<{
  module: ListViewModule;
  browser: FakeBrowser;
}> {
  const browser = installBrowser();
  if (storage) {
    for (const [key, value] of storage) browser.storage.set(key, value);
  }
  documentCounter += 1;
  const lib = (await import(
    `../src/lib/client/list-view.ts?doc=${documentCounter}`
  )) as unknown as ListViewModule;
  return { lib, browser };
}

/** Navigate within the same document. */
function goTo(browser: FakeBrowser, url: string): void {
  const [pathname, search = ""] = url.split("?");
  browser.location.pathname = pathname;
  browser.location.search = search ? `?${search}` : "";
}

const LIST_URL = "/?date=2026-10-09&fav=1";
const LIST_POSITION = { date: "2026-10-09", filter: "favorites", scroll: 700 };
const GAME = "0012600015";

/* ------------------------------------------------------------------ *
 * The receipt the detail page reads
 * ------------------------------------------------------------------ */

test("a card tap records a receipt for that game in this document", async () => {
  const { lib } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);

  const receipt = lib.recallDetailOrigin();
  assert.ok(receipt, "the receipt is readable right after the tap");
  assert.equal(receipt.gameId, GAME);
  assert.equal(receipt.scroll, 700);
  assert.equal(receipt.url, LIST_URL);
  assert.equal(receipt.doc, lib.activeDocKey());
});

test("the receipt only authorizes the game it was written for", async () => {
  const { lib } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);

  assert.ok(lib.detailOriginFor(GAME), "the game that was opened may go back");
  assert.equal(
    lib.detailOriginFor("0012609001"),
    null,
    "another game opened in the same tab has no list behind it",
  );
  assert.equal(lib.detailOriginFor(""), null, "a detail page without an id cannot claim a list");
});

test("a receipt older than its lifetime is ignored", async () => {
  const { lib } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);
  const receipt = lib.recallDetailOrigin();
  assert.ok(receipt);

  assert.ok(lib.recallDetailOrigin(receipt.at + 29 * 60_000), "inside the window it still counts");
  assert.equal(
    lib.recallDetailOrigin(receipt.at + 31 * 60_000),
    null,
    "a stale marker is not a licence to go back",
  );
});

test("another document cannot use a receipt that outlived it", async () => {
  const first = await openDocument();
  first.lib.rememberDetailOrigin(LIST_POSITION, GAME);
  assert.ok(first.lib.detailOriginFor(GAME));

  // A duplicated tab — or a tab a page opened with `window.open` — copies the
  // whole `sessionStorage` area, `nbascore:docKey` included. Nothing is removed
  // here: deleting the key would change the very behaviour under test (the third
  // review found exactly that in this test). What a copy cannot bring along is
  // the realm that wrote the receipt.
  const carried = new Map(first.browser.storage);
  const second = await openDocument(carried);
  const copiedKey = second.browser.storage.get("nbascore:docKey");
  assert.ok(copiedKey, "the copy carries a document key");
  assert.equal(
    copiedKey,
    first.browser.storage.get("nbascore:docKey"),
    "and it is the opener's key, not a fresh one",
  );
  assert.ok(second.browser.storage.has("nbascore:detailOrigin"), "the receipt was carried over");

  assert.equal(second.lib.recallDetailOrigin(), null, "a copied receipt speaks for its own document");
  assert.equal(second.lib.detailOriginFor(GAME), null, "and cannot authorize the copied document's back press");
  assert.notEqual(
    second.browser.storage.get("nbascore:docKey"),
    copiedKey,
    "the new document minted its own key over the copy",
  );
  assert.equal(
    second.lib.markDetailEntry(GAME),
    false,
    "nor can it mark a navigation it never witnessed",
  );
  assert.equal(second.browser.history.state, null, "nothing was written onto its entry");

  // The document that actually made the tap is untouched by any of that.
  assert.ok(first.lib.detailOriginFor(GAME), "the opener's visit is still its own");
});

test("a reloaded detail entry keeps its mark, and the old receipt does not travel", async () => {
  const first = await openDocument();
  first.lib.rememberDetailOrigin(LIST_POSITION, GAME);
  // The entry the tap pushed, with whatever Next.js had on it.
  first.browser.history.state = { __NA: true };
  assert.equal(first.lib.markDetailEntry(GAME), true, "the authorized visit marks the entry it pushed");
  const mark = first.browser.history.state?.nbascoreDetailEntry as Record<string, unknown>;
  assert.ok(mark, "the mark is on this entry");
  assert.equal(mark.gameId, GAME);
  assert.equal(mark.scroll, 700);

  // A reload is the same history entry in a new JavaScript realm: the browser
  // keeps the entry's state, and `sessionStorage` keeps the receipt — but the
  // receipt names the document that was replaced.
  const second = await openDocument(new Map(first.browser.storage));
  second.browser.history.state = { __NA: true, nbascoreDetailEntry: mark };
  assert.equal(second.lib.recallDetailOrigin(), null, "the receipt belongs to the replaced document");
  const origin = second.lib.detailOriginFor(GAME);
  assert.ok(origin, "the entry's own mark still authorizes the return after a reload");
  assert.equal(origin.scroll, 700, "the mark carries the whole position, not just an id");
  assert.equal(origin.url, LIST_URL);
  assert.equal(origin.at, mark.at);
});

test("marking refuses a visit that is not open, or belongs to another game", async () => {
  const { lib, browser } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);
  browser.history.state = { __NA: true };

  assert.equal(lib.markDetailEntry("0012609001"), false, "another game cannot claim this visit");
  assert.equal(
    (browser.history.state as Record<string, unknown>).nbascoreDetailEntry ?? null,
    null,
    "another game leaves no mark behind",
  );
  assert.equal(lib.markDetailEntry(GAME), true, "the game the receipt names may mark its entry");

  // The same refusal for a receipt whose visit has already ended: the entry has
  // to be marked while the navigation is still the open one.
  const other = await openDocument();
  other.lib.rememberDetailOrigin(LIST_POSITION, GAME);
  other.browser.history.state = { __NA: true };
  other.browser.storage.delete("nbascore:detailVisit");
  assert.equal(other.lib.markDetailEntry(GAME), false, "a receipt that outlived its visit cannot mark an entry");
});

test("evidence that contradicts itself refuses the back press", async () => {
  const { lib, browser } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);
  browser.history.state = { __NA: true };
  assert.equal(lib.markDetailEntry(GAME), true, "this entry's mark belongs to the tap's visit");
  const marked = (browser.history.state as Record<string, unknown>).nbascoreDetailEntry as { at: number };

  // The session copy is rewritten as a *later* visit while the entry still
  // carries the earlier mark: the two claims disagree, so neither is trusted.
  const later = marked.at + 1_000;
  browser.storage.set(
    "nbascore:detailOrigin",
    JSON.stringify({ ...LIST_POSITION, gameId: GAME, url: LIST_URL, doc: lib.activeDocKey(), at: later }),
  );
  browser.storage.set("nbascore:detailVisit", String(later));
  assert.equal(lib.detailOriginFor(GAME), null, "contradicting visit tokens do not authorize a return");

  // Ending the visit takes the entry's mark off with it.
  lib.clearDetailOrigin();
  assert.equal(
    (browser.history.state as Record<string, unknown>).nbascoreDetailEntry ?? null,
    null,
    "the entry mark is removed when the visit ends",
  );
  assert.equal(lib.detailOriginFor(GAME), null, "and then nothing authorizes a return");
});

test("consuming the receipt is what stops a second cold open from going back", async () => {
  const { lib } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);
  assert.ok(lib.detailOriginFor(GAME));

  lib.clearDetailOrigin();
  assert.equal(lib.detailOriginFor(GAME), null, "the back control falls back to today's home page");
  assert.equal(lib.recallDetailOrigin(), null);
});

test("a receipt that outlived its visit cannot authorize a back press", async () => {
  const { lib, browser } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);
  assert.ok(lib.detailOriginFor(GAME), "the visit that was opened may go back");

  // The reader closed the detail tab and later typed the same URL: the receipt
  // is still in the session, but nothing is open for it to belong to.
  browser.storage.delete("nbascore:detailVisit");
  assert.ok(lib.recallDetailOrigin(), "the receipt itself is still there");
  assert.equal(lib.detailOriginFor(GAME), null, "but it no longer authorizes a return");
});

/* ------------------------------------------------------------------ *
 * The list entry
 * ------------------------------------------------------------------ */

test("the entry a card was opened from offers the offset exactly once per visit", async () => {
  const { lib } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);

  const offer = lib.listOriginFor("2026-10-09", "favorites");
  assert.ok(offer, "the entry that was tapped may restore");
  assert.equal(offer.scroll, 700);

  // Spending the mark is not the same as ending the visit: the list may be
  // mounted again while the same return is still committing, and that mount has
  // to inherit the offset rather than find nothing. Measured in
  // `_probe/round2-2026-10-11/lead-probe-fine-results.json`.
  lib.consumeListOrigin();
  const afterSpend = lib.listOriginFor("2026-10-09", "favorites");
  assert.ok(afterSpend, "the visit that is still open can still be restored");
  assert.equal(afterSpend.scroll, 700);

  // Leaving the detail page is what ends the visit; from then on the spent mark
  // is worth nothing, however the reader gets back to this URL.
  lib.clearDetailOrigin();
  assert.equal(
    lib.listOriginFor("2026-10-09", "favorites"),
    null,
    "once the visit is over the spent mark cannot restore anything",
  );
});

test("a re-entry of the same URL does not inherit the offset", async () => {
  const { lib, browser } = await openDocument();
  // What the browser does on an address-bar navigation: a fresh entry with only
  // Next's own state on it.
  browser.history.state = { __NA: true };

  assert.equal(lib.listOriginFor("2026-10-09", "favorites"), null);
});

test("a leftover session record with no entry mark is not a licence", async () => {
  const { lib, browser } = await openDocument();
  // The shape the old fallback trusted: an offset written by a scroll handler,
  // with nothing about a navigation attached to it.
  browser.storage.set("nbascore:listView", JSON.stringify(LIST_POSITION));
  browser.history.state = { __NA: true };

  assert.equal(lib.listOriginFor("2026-10-09", "favorites"), null, "a bare offset restores nothing");
});

test("switching day or filter cannot inherit another list's offset", async () => {
  const { lib } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);

  assert.equal(lib.listOriginFor("2026-10-10", "favorites"), null, "another date is another list");
  assert.equal(lib.listOriginFor("2026-10-09", "all"), null, "another filter is another list");
  assert.ok(
    lib.listOriginFor("2026-10-09", "favorites"),
    "the identity it was written for still works",
  );
});

test("a receipt from an earlier visit cannot overwrite the entry's own offset", async () => {
  const { lib } = await openDocument();
  // First visit: tap at 700, come back, and spend the mark.
  lib.rememberDetailOrigin(LIST_POSITION, GAME);
  lib.consumeListOrigin();
  lib.clearDetailOrigin();

  // Second visit from the same entry, at a different offset.
  lib.rememberDetailOrigin({ ...LIST_POSITION, scroll: 1200 }, GAME);
  const offer = lib.listOriginFor("2026-10-09", "favorites");
  assert.ok(offer);
  assert.equal(offer.scroll, 1200, "the value written at this tap is the one that counts");
});

test("the entry mark alone is enough when sessionStorage was cleared", async () => {
  const { lib, browser } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);
  browser.storage.clear();

  const offer = lib.listOriginFor("2026-10-09", "favorites");
  assert.ok(offer, "the mark is written by a card tap and nothing else");
  assert.equal(offer.scroll, 700);
  assert.equal(offer.gameId, GAME);
});

test("a navigation to another entry does not re-offer the offset", async () => {
  const { lib, browser } = await openDocument();
  lib.rememberDetailOrigin(LIST_POSITION, GAME);
  lib.consumeListOrigin();

  // Back to a list, then a fresh entry for the same URL — the shape a later
  // `router.push("/?date=…")` leaves behind.
  goTo(browser, "/");
  browser.history.state = { __NA: true };
  goTo(browser, LIST_URL);

  assert.equal(lib.listOriginFor("2026-10-09", "favorites"), null);
});

/* ------------------------------------------------------------------ *
 * The tap-time offset
 * ------------------------------------------------------------------ */

test("readingPositionFor keeps the reader's position and rejects a last-moment jump", async () => {
  const { lib } = await openDocument();

  assert.equal(lib.readingPositionFor(700, 698), 700, "the tracked value never wins when behind");
  assert.equal(lib.readingPositionFor(700, 900), 700, "a small forward drift is the reader");
  assert.equal(
    lib.readingPositionFor(20, 900),
    900,
    "a jump of most of a screen at the tap is the browser scrolling the card into view",
  );
  assert.equal(lib.readingPositionFor(0, 0), 0, "no tracked value means the current one");
  assert.equal(lib.readingPositionFor(300, Number.NaN), 300, "a non-finite value is ignored");
});

