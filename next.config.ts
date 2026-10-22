import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NextConfig } from "next";

/**
 * The version the client-side update check compares a release tag against.
 *
 * It is injected at build time instead of imported by the component: pulling
 * package.json into a client module ships the whole manifest for one string.
 * `env` entries are inlined by the compiler, so this works for the web bundle
 * and for the statically exported Android bundle alike.
 *
 * Read with `node:fs` rather than `require`/import so both of Next 16's
 * TypeScript config loaders (the SWC-transpiled CJS one and the native Node
 * strip-types ESM import) can run this file unchanged.
 */
function readAppVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    // A build without a readable manifest still has to work; the banner then
    // stays silent, which is the safe direction for an update prompt.
    return "";
  }
}

/**
 * One codebase, two build targets.
 *
 * - **web** (default): a Next server. The route handlers under `src/app/api`
 *   proxy the NBA sources server-side, which is necessary because the CDN
 *   sends no CORS headers and requires custom headers a browser may not set.
 * - **android** (`APP_TARGET=android`): a static export for the Capacitor
 *   shell. A phone has no server, so the app talks to the NBA sources through
 *   the native HTTP bridge instead; `pageExtensions` drops the route handlers
 *   from the build (`route.api.ts` no longer resolves to `route`).
 */
const isApp = process.env.APP_TARGET === "android";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: readAppVersion(),
  },
  /**
   * Browser regression runs may drive the dev server over `127.0.0.1` (a
   * harness cannot always use `localhost`). Next 16 blocks its own dev
   * resources for origins that are not listed, and a blocked bundle/HMR
   * request means the page never hydrates — the suite would silently measure a
   * static skeleton and report "no games". Only the two loopback spellings are
   * allowed; this has no effect on a production build.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  pageExtensions: isApp ? ["tsx", "ts"] : ["tsx", "ts", "api.ts"],
  ...(isApp
    ? {
        output: "export" as const,
        // Assets are served from a local file store by the WebView, so every
        // route must be a real directory with an index.html.
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
