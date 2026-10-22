"use client";

/**
 * The home list's reading position, remembered for the session.
 *
 * Date and filter live in the URL, so the back button restores them for free;
 * the scroll offset cannot be expressed in a URL, so it is kept here and only
 * replayed when this really was a return to the list — a cold start or a reload
 * must land at the top, not halfway down yesterday's list.
 *
 * Why `sessionStorage` is the signal rather than `performance`:
 * `PerformanceNavigationTiming.type` describes the *document* load, and a
 * Next.js App Router return is a client-side transition inside the same
 * document — the entry still reads `navigate` no matter how the reader
 * arrived. The review reproduced exactly that: the custom restore never ran
 * while the browser's own `go_back()` happened to work.
 *
 * **A stored value is a statement about the past, not a licence.** The second
 * review found the first version of this module treating "there is a marker
 * younger than 30 minutes" as "the reader came from the list". That is true for
 * a marker written by a tap in this session and false in three other cases the
 * old code could not tell apart:
 *
 *   - the reader already returned to the list once, so the marker is spent;
 *   - the reader opened this detail page in a *new tab*, where the cloned
 *     `sessionStorage` still holds the other tab's marker;
 *   - the reader drove this tab somewhere else and then opened a different
 *     game, so a back press has a real, unrelated entry behind it.
 *
 * Two bindings answer those cases, and both are needed:
 *
 *   1. **The list entry itself.** `rememberDetailOrigin` marks the *current*
 *      history entry's state (`ENTRY_KEY`) before the tap pushes the detail
 *      entry. Only a list entry carrying that mark may restore, and the mark is
 *      spent (`restored`) the moment it is used. A history traversal back to
 *      that entry — browser back or the in-app control — is therefore the only
 *      way to get the offset, while an address-bar re-entry of the same URL, a
 *      second visit, or a tab that inherited the storage is not.
 *   2. **The visit.** The receipt also names the document that wrote it, the
 *      game it was written for and the list URL and identity it came from, so
 *      the detail page can only go back for the game it is actually showing.
 *
 * The second closeout review found the *identity* of a document being taken from
 * `sessionStorage`, which cannot answer that question: the browser copies the
 * whole storage area into a tab opened with `window.open`, and the area also
 * survives a full-document navigation inside one tab, so a key read back from
 * there says "some document wrote this", never "this document is the one". Two
 * changes follow from that, and they answer the two halves of the requirement:
 *
 *   - `activeDocKey()` mints a value that only ever lives in this JavaScript
 *     realm. Nothing can copy it, so a receipt from another document — a new
 *     tab, a duplicated tab, a re-entry after the tab left the app — fails the
 *     document test even though every storage key came along;
 *   - the *detail* entry carries its own mark (`DETAIL_ENTRY_KEY`, written by
 *     `markDetailEntry` on mount and only for a visit the receipt authorized).
 *     A copied storage cannot reproduce a history entry's state, and a fresh
 *     navigation has no state at all, so that mark is navigation evidence rather
 *     than a stored claim — while still surviving a reload of the detail page,
 *     which is the same entry in a new realm.
 *
 * `sessionStorage` is a cache of the receipt, not its authority: if it was
 * cleared, the entry mark alone is still enough for a genuine return, because
 * the mark cannot be written by anything but a card tap.
 */

const ORIGIN_KEY = "nbascore:detailOrigin";
/**
 * The visit that is currently open, so a receipt copied into another tab — or
 * left behind after the reader closed a duplicated detail tab — cannot speak for
 * a navigation it did not witness.
 */
const VISIT_KEY = "nbascore:detailVisit";
/** Which document wrote the receipt; a new tab or reload is a different one. */
const DOC_KEY = "nbascore:docKey";
/** The history-entry state field that says "a card tap happened here". */
const ENTRY_KEY = "nbascoreListEntry";
/**
 * The same statement about the *detail* entry: a card tap pushed this entry.
 *
 * It lives on the entry the tap created, so it survives a reload of that page —
 * the browser keeps an entry's state across a reload — while being impossible to
 * copy into another document or onto a fresh navigation.
 */
const DETAIL_ENTRY_KEY = "nbascoreDetailEntry";

export interface ListViewPosition {
  /** Local date key the list was showing. */
  date: string | null;
  filter: string;
  scroll: number;
}

/**
 * Where a detail page was opened from, so its back affordance can restore the
 * list instead of dropping the reader on today's unfiltered home page.
 */
export interface DetailOrigin extends ListViewPosition {
  /** The game this receipt was written for. */
  gameId: string;
  /** The list entry's URL at the moment of the tap. */
  url: string;
  /** The document that wrote it, so another tab cannot claim it. */
  doc: string;
  /** When the value was written, so a stale marker can be ignored. */
  at: number;
}

/** The state attached to a list entry a card was opened from. */
interface EntryOrigin extends ListViewPosition {
  gameId: string;
  url: string;
  at: number;
  /** Set once the offset has been replayed, so it can never be replayed twice. */
  restored?: boolean;
}

/** Long enough to survive a backgrounded app, short enough not to be a lie. */
const ORIGIN_TTL_MS = 30 * 60_000;

function readSession(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeSession(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: the list simply starts at the top next time.
  }
}

function removeSession(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clean up.
  }
}

function asPosition(value: unknown): ListViewPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<ListViewPosition>;
  if (
    (candidate.date === null || typeof candidate.date === "string") &&
    typeof candidate.filter === "string" &&
    typeof candidate.scroll === "number" &&
    Number.isFinite(candidate.scroll)
  ) {
    return { date: candidate.date, filter: candidate.filter, scroll: candidate.scroll };
  }
  return null;
}

/**
 * This document's identity, stable for the life of the page.
 *
 * Deliberately **not** read back from `sessionStorage`. A copied storage (a tab
 * opened with `window.open`, a duplicated tab, a restored session) carries the
 * previous document's receipts *and* its stored key, and a full-document
 * navigation inside one tab keeps the same storage area — so a value read from
 * there identifies the storage, not the realm reading it. A value that only ever
 * exists in memory is the one thing a copy cannot bring along; `crypto.randomUUID`
 * is not in every WebView the Android build targets, so a counter plus a
 * timestamp is used instead — this value only has to be unique among the tabs
 * that share one storage area.
 *
 * The minted value is still *written* to storage: probes and the acceptance
 * suite read it there, and the next document overwrites it, which is exactly how
 * a stale receipt becomes visibly stale.
 */
let docKey: string | null = null;

export function activeDocKey(): string {
  if (docKey !== null) return docKey;
  docKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    if (typeof window !== "undefined") window.sessionStorage.setItem(DOC_KEY, docKey);
  } catch {
    // Private mode: the key still identifies this document in memory.
  }
  return docKey;
}

function currentUrl(): string {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}`;
}

/** Our own state on a history entry, or null when the entry has none. */
function readEntryState(): EntryOrigin | null {
  if (typeof window === "undefined") return null;
  const state = window.history.state as Record<string, unknown> | null;
  if (typeof state !== "object" || state === null) return null;
  const raw = state[ENTRY_KEY];
  const position = asPosition(raw);
  if (!position) return null;
  const record = raw as Partial<EntryOrigin>;
  if (typeof record.gameId !== "string" || typeof record.url !== "string") return null;
  return {
    ...position,
    gameId: record.gameId,
    url: record.url,
    at: typeof record.at === "number" ? record.at : 0,
    restored: record.restored === true,
  };
}

/** Replace the entry state, keeping whatever Next.js put there. */
function writeEntryState(value: EntryOrigin): void {
  if (typeof window === "undefined") return;
  const state = window.history.state as Record<string, unknown> | null;
  const next = { ...(typeof state === "object" && state !== null ? state : {}) };
  next[ENTRY_KEY] = value;
  try {
    // `pushState`-shaped so Next's patched `replaceState` treats it as an
    // external update and keeps its own state alongside ours.
    window.history.replaceState(next, "");
  } catch {
    // A browser that refuses the write simply loses the mark, not the app.
  }
}

/**
 * What a card tap leaves behind on the entry it pushed.
 *
 * The position fields are the same values the receipt carries, so a page that
 * has only the entry — the shape a reload leaves — can still describe the return
 * completely. `at` is the visit token of the receipt that authorized the push,
 * so the two kinds of evidence can be checked against each other instead of one
 * silently overriding the other.
 */
interface DetailEntryMark extends ListViewPosition {
  gameId: string;
  at: number;
  url: string;
}

/** Our own mark on the current entry, or null when this entry carries none. */
function readDetailEntryMark(): DetailEntryMark | null {
  if (typeof window === "undefined") return null;
  const state = window.history.state as Record<string, unknown> | null;
  if (typeof state !== "object" || state === null) return null;
  const raw = state[DETAIL_ENTRY_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const position = asPosition(raw);
  if (!position) return null;
  const record = raw as Partial<DetailEntryMark>;
  if (typeof record.gameId !== "string" || record.gameId === "") return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  return {
    ...position,
    gameId: record.gameId,
    at: record.at,
    url: typeof record.url === "string" ? record.url : "/",
  };
}

/** Replace the entry mark, keeping whatever Next.js put on this entry. */
function writeDetailEntryMark(mark: DetailEntryMark | null): void {
  if (typeof window === "undefined") return;
  const state = window.history.state as Record<string, unknown> | null;
  const next = { ...(typeof state === "object" && state !== null ? state : {}) };
  if (mark === null) delete next[DETAIL_ENTRY_KEY];
  else next[DETAIL_ENTRY_KEY] = mark;
  try {
    // `pushState`-shaped so Next's patched `replaceState` treats it as an
    // external update and keeps its own state alongside ours.
    window.history.replaceState(next, "");
  } catch {
    // A browser that refuses the write loses the mark, not the app.
  }
}

/**
 * The offset to remember for a tap that is opening a game.
 *
 * `window.scrollY` at tap time is usually the truth, but it is not always: a
 * tap on a card that is partly off screen makes the browser scroll the element
 * into view *before* the click lands, and the position recorded then is the
 * browser's convenient one, not the reader's. The continuously tracked offset
 * is the honest answer in that case, and "the view jumped by most of a screen"
 * is what tells the two apart. A genuine flick moves a screenful too, but the
 * tracked value is then the newer of the two, so taking it costs nothing —
 * this only ever prefers the recorded position over a jump that happened at
 * the last moment.
 */
export function readingPositionFor(current: number, tracked: number): number {
  if (!Number.isFinite(tracked) || tracked <= 0) return current;
  const viewport = typeof window === "undefined" ? 0 : window.innerHeight;
  if (current >= tracked) return current;
  // A jump of more than half a screen at the moment of the tap is the browser
  // repositioning the card, not the reader moving.
  return tracked - current > viewport / 2 ? tracked : current;
}

/**
 * Called when a game card is opened: marks this list entry as the place to come
 * back to, and records which game was opened from it.
 *
 * `gameId` is part of the record because "is this receipt about the visit I am
 * in?" is the question the detail page has to answer; a mark written for
 * another game must never authorize a back press.
 */
export function rememberDetailOrigin(position: ListViewPosition, gameId: string): void {
  const url = currentUrl();
  const at = Date.now();
  writeEntryState({ ...position, gameId, url, at, restored: false });
  const origin: DetailOrigin = { ...position, gameId, url, doc: activeDocKey(), at };
  // A second copy of the same facts, under the key the *detail* page reads. The
  // entry mark above is the authority for the list; this one is what answers
  // "which game was opened, and from where" when only the session is available.
  writeSession(ORIGIN_KEY, origin);
  // Which visit is open right now. Tapping a card is the only thing that writes
  // this, and coming back is the only thing that removes it, so a receipt that
  // outlives its visit (a closed duplicate tab, a later hand-typed address in
  // the same tab) cannot authorize a back press — `at` identifies the visit,
  // and a receipt whose `at` no longer matches the open one is not live.
  writeSession(VISIT_KEY, at);
}

/** End the open visit; the receipt may stay, but it stops authorizing back. */
function clearOpenVisit(): void {
  removeSession(VISIT_KEY);
}

/**
 * The receipt for this detail visit, or null when this visit was not started
 * from a list tap in this document.
 *
 * Everything a cold open, another tab or another game could get wrong is
 * checked here, so callers can treat a non-null answer as "this navigation
 * really does have our list behind it". It deliberately does **not** consume:
 * the caller decides, and `clearDetailOrigin` ends it.
 */
export function recallDetailOrigin(now = Date.now()): DetailOrigin | null {
  const value = readSession(ORIGIN_KEY);
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<DetailOrigin>;
  const position = asPosition(candidate);
  if (!position) return null;

  const at = typeof candidate.at === "number" ? candidate.at : 0;
  // Spent, stale, another document's: not ours.
  if (now - at > ORIGIN_TTL_MS) return null;
  if (candidate.doc !== activeDocKey()) return null;
  if (typeof candidate.gameId !== "string" || candidate.gameId === "") return null;
  if (typeof candidate.url !== "string") return null;

  return { ...position, gameId: candidate.gameId, url: candidate.url, doc: candidate.doc, at };
}

/**
 * Is this detail visit authorized to go back to the list?
 *
 * The answer is built from two kinds of evidence and refuses whenever the two
 * disagree:
 *
 *   - the **receipt** is what carries the values (date, filter, offset, list
 *     URL). It speaks only for the document that wrote it — a realm-scoped
 *     identity, so a copy of `sessionStorage` cannot inherit it — and only while
 *     the visit it was written for is still open;
 *   - the **entry mark** is what proves the navigation. It is written onto the
 *     detail entry by `markDetailEntry`, which the detail page calls on mount
 *     and which only writes for a visit the receipt authorized in this realm. A
 *     copied storage cannot reproduce a history entry, a fresh navigation has no
 *     state to copy, and a reload of the detail page keeps the entry — which is
 *     why the app's own back control still returns to the list after a reload.
 *
 * A receipt that is present but names another game, or belongs to a visit that
 * has already ended, is refused rather than overridden: the earlier review's
 * reproduction was exactly a stored claim being treated as a licence.
 */
export function detailOriginFor(gameId: string, now = Date.now()): DetailOrigin | null {
  if (!gameId) return null;
  const receipt = recallDetailOrigin(now);
  const mark = readDetailEntryMark();

  if (receipt && receipt.gameId !== gameId) return null;
  if (receipt && readSession(VISIT_KEY) !== receipt.at) return null;
  if (mark && mark.gameId !== gameId) return null;
  if (mark && receipt && mark.at !== receipt.at) return null;

  if (mark) {
    return { ...mark, doc: receipt?.doc ?? activeDocKey() };
  }

  if (receipt && readSession(VISIT_KEY) === receipt.at) return receipt;
  return null;
}

/**
 * Mark this detail entry as one that a card tap pushed.
 *
 * Called by the detail page when it mounts. It writes only when the receipt for
 * this very visit — this realm, this game, still the open one — authorizes the
 * navigation, so the mark records something the app witnessed rather than a
 * stored claim it inherited. Returns whether it wrote.
 *
 * The write is a `replaceState` on the entry the push created, so it survives a
 * reload of this page; `clearDetailOrigin` takes it off again when the visit is
 * spent (the entry may still be reached with the browser's forward button, and
 * by then the visit is over).
 */
export function markDetailEntry(gameId: string, now = Date.now()): boolean {
  if (!gameId) return false;
  const origin = recallDetailOrigin(now);
  if (!origin || origin.gameId !== gameId) return false;
  if (readSession(VISIT_KEY) !== origin.at) return false;
  writeDetailEntryMark({
    date: origin.date,
    filter: origin.filter,
    scroll: origin.scroll,
    gameId: origin.gameId,
    at: origin.at,
    url: origin.url,
  });
  return true;
}

/**
 * Should this list entry give the reader their old offset back?
 *
 * The entry's own state has to say a card was opened from it, and the identity
 * on screen must be the one the tap was made on. Anything else — an
 * address-bar re-entry, a reload, a day switch — starts at the top, which is
 * what the reader's own navigation implies.
 *
 * A spent mark (`restored`) is still returned **while it belongs to the visit
 * that is currently open**, and only then. Two facts make that the right rule
 * rather than a hole:
 *
 *   - the App Router can mount the list more than once for one return — measured
 *     in `_probe/round2-2026-10-11/lead-probe-fine-results.json`, where the
 *     mark was consumed at 2 052 ms and the list mounted again at 2 905 ms after
 *     the commit — and the second mount has to know where the reader was;
 *   - a *different* visit can never see it: the open visit token is written by
 *     the next card tap and by nothing else, so once the reader leaves, the
 *     spent mark stops qualifying and the offset cannot be replayed.
 *
 * Measured, not assumed: Next 16 keeps these extra fields on the entry across a
 * push and restores them on the way back. The offer of a scroll offset exists
 * purely to warm the restore: a cleared `sessionStorage` costs the receipt,
 * never the return.
 */
export function listOriginFor(date: string | null, filter: string, now = Date.now()): DetailOrigin | null {
  const entry = readEntryState();
  if (!entry) return null;
  if (entry.date !== date || entry.filter !== filter) return null;
  if (entry.restored === true && readSession(VISIT_KEY) !== entry.at) return null;

  const origin = recallDetailOrigin(now);
  // A receipt that is about some other visit must not override the entry's own
  // record of where the reader was; the entry is the authority here, and the
  // session copy only supplies the fallback values it may be missing.
  if (origin && origin.gameId !== entry.gameId) return null;

  return {
    date: entry.date,
    filter: entry.filter,
    // The entry's own value is written at the tap; the receipt's is a copy.
    scroll: entry.scroll > 0 ? entry.scroll : (origin?.scroll ?? 0),
    gameId: entry.gameId,
    url: entry.url,
    doc: origin?.doc ?? activeDocKey(),
    at: entry.at,
  };
}

/** Spend the entry mark, so the offset can never be replayed twice. */
export function consumeListOrigin(): void {
  const entry = readEntryState();
  if (!entry) return;
  writeEntryState({ ...entry, restored: true });
}

/**
 * Drop the receipt once the detail page has used it, so a later cold open of
 * the same detail page does not pretend the reader came from the list.
 *
 * The entry mark on *this* entry goes with it: the visit is over, so the entry
 * the reader is leaving stops authorizing a return. If the browser's forward
 * button brings the entry back, that visit has already been spent.
 *
 * The list's entry mark is deliberately left in place: it is the list's own
 * record of where it was, and the list — not the detail page — is what spends
 * it.
 */
export function clearDetailOrigin(): void {
  clearOpenVisit();
  removeSession(ORIGIN_KEY);
  writeDetailEntryMark(null);
}
