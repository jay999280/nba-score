import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Team logos come straight from the NBA CDN as remote SVGs; a plain <img>
      // keeps the client bundle free of the image optimizer (PRD §34).
      "@next/next/no-img-element": "off",
    },
  },
  globalIgnores([
    // Build output
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local verification material (gitignored)
    "_probe/**",
    // Generated Android artifacts. `cap sync` copies the whole web bundle into
    // the Android project, and linting that copy is what produced 10 errors and
    // ~2000 warnings about files nobody edits by hand.
    "android/app/src/main/assets/**",
    "android/app/build/**",
    "android/build/**",
    "android/.gradle/**",
    "android/capacitor-cordova-android-plugins/**",
  ]),
]);

export default eslintConfig;
