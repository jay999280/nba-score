"use client";

import { useInstall } from "@/lib/client/use-install";
import { CloseIcon, DownloadIcon } from "./icons";

/**
 * Install-to-home-screen row (v0.7).
 *
 * Rendered only when the browser reports the app is installable and the
 * reader has never answered the prompt. Installing swaps the browser tab for
 * a real app window: launcher icon, no address bar, push notifications and an
 * offline shell.
 */
export function InstallPrompt() {
  const { canInstall, install, dismiss } = useInstall();
  if (!canInstall) return null;

  return (
    <div className="card animate-fade flex items-center gap-3 px-4 py-3">
      <DownloadIcon size={16} className="shrink-0 text-ink-3" />
      <p className="min-w-0 flex-1 text-body leading-snug text-ink-2">
        装到主屏幕，全屏打开
      </p>
      <button type="button" onClick={() => void install()} className="btn-primary shrink-0">
        安装
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="不再提示"
        className="btn-ghost -mr-1 shrink-0"
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
