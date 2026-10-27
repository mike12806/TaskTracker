import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Stamped into the bundle and shown in the nav drawer.
 *
 * A deploy does not reach an installed PWA the moment it lands — the app holds
 * the reload until it can't cost anyone a half-filled form — so "is this
 * device actually running the new build?" is a real question when chasing a
 * bug, and one that was previously unanswerable from the device itself.
 */
const buildId =
  process.env.GITHUB_SHA?.slice(0, 7) ??
  (process.env.NODE_ENV === "production" ? "local" : "dev");

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      // Hand-written worker rather than a generated one, so the caching policy
      // (none for /api/*) and the notification actions are explicit code. See
      // client/src/sw.ts.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
      },
      includeAssets: [
        "favicon.svg",
        "icons/apple-touch-icon.png",
        "icons/icon.svg",
        "icons/icon-maskable.svg",
      ],
      manifest: {
        name: "Tasks",
        short_name: "Tasks",
        description: "Tasks and reminders",
        // Long-press shortcuts on the home-screen icon.
        shortcuts: [
          { name: "Today", url: "/", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] },
          { name: "Upcoming", url: "/upcoming", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] },
          { name: "Inbox", url: "/inbox", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] },
        ],
        start_url: "/",
        scope: "/",
        display: "standalone",
        // Not "portrait": a foldable's inner display is landscape when held
        // open like a book, and the layout splits into two panes there (see
        // src/utils/fold.ts). Locked to portrait, a browser that honours the
        // lock would turn it sideways into one tall column instead.
        orientation: "any",
        theme_color: "#5b5dff",
        background_color: "#f5f5f5",
        categories: ["productivity"],
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
