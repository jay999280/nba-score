import type { NextConfig } from "next";

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
