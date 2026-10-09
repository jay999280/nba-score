"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { STORAGE_KEYS } from "./storage";
import { useStoredValue } from "./local-store";

/**
 * Chrome's install prompt, which `lib.dom` does not describe yet.
 * `prompt()` opens the native dialog; `userChoice` resolves with the answer.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const STANDALONE_QUERY = "(display-mode: standalone)";

function subscribeDisplayMode(listener: () => void): () => void {
  const query = window.matchMedia(STANDALONE_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function installedSnapshot(): boolean {
  if (window.matchMedia(STANDALONE_QUERY).matches) return true;
  // iOS Safari predates the display-mode media query.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Assume installed on the server, so no prompt is ever rendered into the HTML. */
const installedServerSnapshot = () => true;

/**
 * Install-to-home-screen state (v0.7).
 *
 * Chrome decides when an app is installable and announces it with
 * `beforeinstallprompt`; catching that event lets us offer the install in our
 * own UI, in our own words, at a moment the reader is already looking at the
 * app — the built-in mini-infobar is easy to miss and easy to dismiss by
 * accident. The prompt is offered once: either answer records a dismissal.
 */
export function useInstall() {
  const installed = useSyncExternalStore(
    subscribeDisplayMode,
    installedSnapshot,
    installedServerSnapshot,
  );
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useStoredValue<boolean>(
    STORAGE_KEYS.installDismissed,
    false,
  );

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Suppress Chrome's own banner: we show our own.
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    await promptEvent.userChoice.catch(() => undefined);
    // The native dialog has now been shown once; never ask again.
    setPromptEvent(null);
    setDismissed(true);
  }, [promptEvent, setDismissed]);

  const dismiss = useCallback(() => setDismissed(true), [setDismissed]);

  return {
    installed,
    canInstall: !installed && !dismissed && promptEvent !== null,
    install,
    dismiss,
  };
}
