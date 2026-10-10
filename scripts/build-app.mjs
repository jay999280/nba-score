/**
 * `pnpm build:app` — the static export that goes inside the Android APK.
 *
 * `APP_TARGET=android next build` only works in a POSIX shell, so this sets the
 * variable and runs the local Next binary directly. Cross-platform, no
 * dependency on cross-env.
 *
 * After it finishes: `pnpm exec cap sync android`, then build the APK (CI does
 * both, see .github/workflows/android.yml).
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const result = spawnSync(process.execPath, [nextBin, "build"], {
  stdio: "inherit",
  env: { ...process.env, APP_TARGET: "android" },
});

process.exit(result.status ?? 1);
