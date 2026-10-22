"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { clearDetailOrigin, detailOriginFor } from "@/lib/client/list-view";
import { canReturnFromStandings } from "@/lib/client/standings-navigation";

declare global {
  interface Window {
    __nbaHandleNativeBack?: () => "handled" | "exit";
  }
}

/** Routes Android system Back through the same receipts as the in-app controls. */
export function NativeBackHandler() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const handleBack = (): "handled" | "exit" => {
      // The sheet's own history entry and popstate listener own this press.
      const state = window.history.state as { __favoritesSheet?: boolean } | null;
      if (state?.__favoritesSheet) {
        window.history.back();
        return "handled";
      }

      const currentPath = window.location.pathname;
      if (currentPath === "/game" || currentPath === "/game/") {
        const gameId = new URLSearchParams(window.location.search).get("id") ?? "";
        if (detailOriginFor(gameId)) {
          clearDetailOrigin();
          router.back();
        } else {
          router.push("/");
        }
        return "handled";
      }

      if (currentPath === "/") return "exit";

      if (currentPath === "/standings" || currentPath === "/standings/") {
        if (canReturnFromStandings()) router.back();
        else router.push("/");
        return "handled";
      }
      // Other in-app routes return through their actual entry.
      if (window.history.length > 1) router.back();
      else router.push("/");
      return "handled";
    };

    window.__nbaHandleNativeBack = handleBack;
    return () => {
      if (window.__nbaHandleNativeBack === handleBack) {
        delete window.__nbaHandleNativeBack;
      }
    };
  }, [pathname, router]);

  return null;
}
