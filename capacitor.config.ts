import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android packaging for the scoreboard (v0.8).
 *
 * The web assets are bundled into the APK (`webDir: "out"`, produced by
 * `APP_TARGET=android next build`), so the app carries its own UI and needs no
 * server, no domain and no network round-trip to render. Scores are fetched
 * straight from the NBA sources through the native HTTP bridge
 * (see src/lib/client/data-source.ts).
 */
const config: CapacitorConfig = {
  appId: "com.jay.nbascore",
  appName: "NBA比分",
  webDir: "out",
  // A real https origin inside the WebView: localStorage, service workers and
  // secure-context APIs behave exactly as they do on the web.
  server: {
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#ffffff",
  },
};

export default config;
