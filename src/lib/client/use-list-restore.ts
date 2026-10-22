"use client";

import { useEffect, useRef } from "react";

import { consumeListOrigin, listOriginFor } from "./list-view";

/**
 * Put the reader back where they were when the list is re-entered.
 *
 * The URL carries the date and the filter, but not the scroll offset, and the
 * list is not the same document twice. On a return from a game the payload is
 * usually in the in-memory cache and the list paints at full height
 * immediately; after a reload it paints as a skeleton first and grows as data
 * lands. A single `scrollTo` on mount only works in the first case — the
 * review could not confirm it ever ran, and the browser regression measured it
 * landing 1 400px short on a tall list, because a short skeleton can satisfy
 * the offset for a moment and the document then grows underneath it.
 *
 * So the offset is re-applied on every frame until one of three things happens:
 * the reader scrolls (their intent wins), the deadline passes, or the
 * document has stopped moving and the offset has held still — the last one is
 * what makes the loop finish promptly on a warm cache instead of spinning for
 * the whole window.
 *
 * **What may be restored, and when**, was tightened after the second review:
 *
 *   - The attempt starts only from an *entry mark* written by a card tap on
 *     this very history entry (`listOriginFor`). A value left in
 *     `sessionStorage` is not a licence: the old code fell back to
 *     `recallListView()`, a record with no expiry and no consumption, and that
 *     is exactly the reproduced defect — navigate to the same URL again and the
 *     list landed at scroll=700 for no reason the reader could see.
 *   - The attempt is bound to the list *identity* (`date` + `filter`) **and to
 *     the visit that wrote the mark**, and a change of either cancels it, so a
 *     stale target never follows the reader onto the next day's list and the
 *     second tap on the same list does not replay the first tap's offset. That
 *     second half is the closeout review's C1: the slot was keyed by the list
 *     identity alone, so the receipt of the second visit recorded 600 while the
 *     screen went back to the first visit's 300.
 *   - The mark is spent only once the offset has actually been applied — never
 *     at the moment it is read. Reading and spending in the same tick is what
 *     broke the return in the second round: React's development remount (and,
 *     on a real device, the App Router mounting the list twice for one return)
 *     ran the decision again with the mark already consumed, found nothing to
 *     restore, and left the reader at the top while the browser's own restore
 *     quietly covered it up. Measured in
 *     `_probe/round2-2026-10-11/scroll-culprit-results.json`: zero `scrollTo`
 *     calls after the in-app back control, scrollY 700 only while
 *     `scrollRestoration` was `"auto"`.
 *
 * The loop takes the entry's restore mode over while it holds the position and
 * gives the value it found back on every way out — settled, timed out, the
 * reader scrolling, or the component unmounting. Measured write by write in
 * `tests/browser/run.py` case `r1_scroll_restoration_handed_back`; the delivery
 * notes of the previous round claimed the opposite and were wrong.
 */

/** How long the offset may keep being re-applied while the list grows. */
const RESTORE_WINDOW_MS = 8_000;
/** Consecutive settled frames that mean "the document stopped moving". */
const SETTLED_FRAMES = 12;

interface Options {
  /** Identity of the list currently on screen. */
  date: string | null;
  filter: string;
  /** Re-runs the attempt when the list changes, e.g. when its data lands. */
  signature: string;
}

/**
 * The offsets of the restores currently running, for tests and diagnostics.
 *
 * Module-level rather than React state because a probe has to read it from
 * outside the tree, and the value must never trigger a render.
 */
const running = new Map<number, number>();
let nextId = 0;

/** Targets the restore loop is still walking the document towards. */
export function pendingScrollRestores(): number[] {
  return [...running.values()];
}

function registerScrollRestore(target: number, id: number): () => void {
  running.set(id, target);
  return () => {
    running.delete(id);
  };
}

/**
 * The restore that has been decided but not yet finished.
 *
 * It lives outside React because the decision and the work it justifies happen
 * in two different effect lifetimes, and because a remount must inherit it: the
 * mark that authorized the restore can only be spent after the offset has been
 * applied, so a second mount has to be able to see that a restore is still owed.
 *
 * It is keyed by the list identity **and by the visit** that wrote the mark, so
 * a new day, a new filter or a new tap simply replaces it instead of being
 * dragged towards an offset that belongs to an earlier visit. A remount of the
 * same return presents the same key — same date, same filter, same visit token —
 * and inherits the slot unchanged.
 */
interface RestoreSlot {
  position: number;
  /** The list this offset belongs to: `date` + `filter`. */
  list: string;
  /** The visit whose receipt wrote the mark this decision came from. */
  visit: number;
  /** The game that visit opened, so a re-tap in the same millisecond is still a new visit. */
  gameId: string;
  /** Set when the entry's mark has been spent; spent exactly once. */
  spent: boolean;
}

let slot: RestoreSlot | null = null;

function listIdentityOf(date: string | null, filter: string): string {
  return `${date ?? ""}:${filter}`;
}

/** What makes one decision different from the next: the list and the visit. */
function slotIdentityOf(list: string, visit: number, gameId: string): string {
  return `${list}|${visit}|${gameId}`;
}

export function useListScrollRestore({ date, filter, signature }: Options): void {
  // `null` means "no restore wanted"; the loop then never runs. `settled` is
  // what stops a later run from starting one again: React gives the effect the
  // same cleanup for a dependency change and for unmount, so the loop cannot
  // tell them apart and the flag has to live outside it.
  const target = useRef<number | null>(null);
  const settled = useRef(false);

  /**
   * Decide once per list entry. The mark is **not** spent here.
   *
   * A change of identity is also an end: the document the offset belonged to is
   * gone the moment the list shows another day, filter or visit, so the decision
   * is re-made for the new identity and the slot is replaced — which normally
   * offers nothing, because the mark on this entry is for the old date. A
   * remount, on the other hand, inherits the slot and picks the offset up
   * again, because nothing has spent it yet.
   */
  useEffect(() => {
    const list = listIdentityOf(date, filter);
    const origin = listOriginFor(date, filter);
    if (!origin || origin.scroll <= 0) {
      target.current = null;
      if (slot && slot.list !== list) slot = null;
      return;
    }

    const identity = slotIdentityOf(list, origin.at, origin.gameId);
    const current = slot ? slotIdentityOf(slot.list, slot.visit, slot.gameId) : null;
    if (!slot || current !== identity) {
      slot = { position: origin.scroll, list, visit: origin.at, gameId: origin.gameId, spent: false };
    }
    target.current = slot.position;
    settled.current = false;
  }, [date, filter]);

  /** Re-apply the offset until the document settles; the identity is fixed. */
  useEffect(() => {
    const wanted = target.current;
    if (wanted === null || settled.current) return;

    // The browser's own restore is held off *while this loop holds the
    // position*, and the value that was in effect before is written back on
    // every way out (see `stop`). Two writers aiming at one offset is not a
    // race in general, but the browser's restore lands once, asynchronously, and
    // can land short — measured at 1 400px short on a tall list when the
    // skeleton was still the only thing in the document — so the loop owns the
    // entry for its window and hands the mode back when it is done. The mode
    // belongs to the session-history entry, which is why it is the *previous*
    // value, not a hard-coded `"auto"`, that has to come back.
    const previousRestoration =
      typeof history !== "undefined" ? history.scrollRestoration : undefined;
    if (previousRestoration !== undefined) history.scrollRestoration = "manual";

    let stopped = false;
    let frame = 0;
    let settledFrames = 0;
    let lastHeight = -1;

    const id = (nextId += 1);
    const release = registerScrollRestore(wanted, id);

    /**
     * End the attempt for good: no more frames, no more corrections.
     *
     * `final` is what stops a later run from starting one again — an unmount or
     * a signature change must not set it, or the retry that survives the
     * document growing would be killed by its own cleanup. The hand-back is
     * unconditional: every exit path restores the mode the entry had before this
     * run touched it, including the exit that only exists because the component
     * unmounted mid-restore.
     */
    const stop = (final: boolean) => {
      if (stopped) return;
      stopped = true;
      if (final) settled.current = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      if (previousRestoration !== undefined) history.scrollRestoration = previousRestoration;
      release();
    };

    const onUserScrollIntent = () => stop(true);
    window.addEventListener("wheel", onUserScrollIntent, { passive: true });
    window.addEventListener("touchstart", onUserScrollIntent, { passive: true });
    window.addEventListener("keydown", onUserScrollIntent);

    /**
     * Hold the position, not just reach it.
     *
     * Any drift away from the offset while the window is open is corrected on
     * the spot. The reader's intent still wins: wheel, touch and key events stop
     * the attempt before this can fight them, and a drag of a scrollbar is the
     * one input this cannot see — the same trade the loop already made when it
     * chose to own the position.
     */
    const onScrollDrift = () => {
      if (stopped) return;
      if (Math.abs(window.scrollY - wanted) > 1) window.scrollTo(0, wanted);
    };
    window.addEventListener("scroll", onScrollDrift, { passive: true });

    const deadline = Date.now() + RESTORE_WINDOW_MS;

    const attempt = () => {
      frame = 0;
      if (stopped) return;

      window.scrollTo(0, wanted);
      // The offset is on screen now, which is the moment the entry's mark may be
      // spent and the open visit may be closed: a later visit to this entry, or
      // a later look at this game, must not replay what the reader has already
      // been given back. Doing it here rather than when the mark was read is
      // what lets a remount inherit an owed restore.
      if (slot && !slot.spent) {
        slot.spent = true;
        consumeListOrigin();
      }

      // "Settled" means the document stopped growing *and* the offset stuck.
      // Either one alone is not enough: a skeleton satisfies the offset while
      // it is still short, and a growing document satisfies the height while
      // the offset is being clamped.
      const height = document.documentElement.scrollHeight;
      const held = Math.abs(window.scrollY - wanted) <= 1;
      settledFrames = height === lastHeight && held ? settledFrames + 1 : 0;
      lastHeight = height;

      if (settledFrames >= SETTLED_FRAMES || Date.now() > deadline) {
        stop(true);
        return;
      }
      frame = requestAnimationFrame(attempt);
    };

    frame = requestAnimationFrame(attempt);

    return () => {
      // Runs on unmount *and* on a dependency change, and cannot tell them
      // apart. It must NOT mark the restore finished: the signature changes
      // once when the list's data lands, and that cleanup would otherwise kill
      // the retry that makes the offset survive the document growing. Only a
      // real outcome — settled, timed out, or the reader scrolling — ends it.
      // The slot is left in place for the same reason: an owed restore is owed
      // to the entry, not to the component instance that happened to start it.
      stop(false);
      window.removeEventListener("wheel", onUserScrollIntent);
      window.removeEventListener("touchstart", onUserScrollIntent);
      window.removeEventListener("keydown", onUserScrollIntent);
      window.removeEventListener("scroll", onScrollDrift);
    };
  }, [signature]);
}
