/** A pending same-document link authorizes exactly one standings history entry. */
let pendingEntry = false;

export function rememberStandingsEntry(): void {
  pendingEntry = true;
}

export function markStandingsEntry(): void {
  if (!pendingEntry) return;
  pendingEntry = false;
  window.history.replaceState({ ...window.history.state, __nbaStandingsFromApp: true }, "");
}

export function canReturnFromStandings(): boolean {
  return window.history.state?.__nbaStandingsFromApp === true;
}
