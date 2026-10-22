import type { Metadata, Viewport } from "next";

import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { NativeBackHandler } from "@/components/native-back-handler";
import "./globals.css";

export const metadata: Metadata = {
  title: "NBA 比分",
  description: "今天的 NBA 比分。打开、扫一眼、关掉。",
  applicationName: "NBA 比分",
  appleWebApp: {
    capable: true,
    title: "NBA比分",
    statusBarStyle: "default",
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Applies the stored theme before the first paint so dark mode never flashes
 * white. The value is stored as JSON, matching the client store.
 */
const THEME_INIT = `try{var r=localStorage.getItem("theme");var t=r?JSON.parse(r):"light";if(t!=="light"&&t!=="dark"){t="light"}document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="preconnect" href="https://cdn.nba.com" crossOrigin="anonymous" />
      </head>
      <body>
        <ServiceWorkerRegister />
        <NativeBackHandler />
        {children}
      </body>
    </html>
  );
}
