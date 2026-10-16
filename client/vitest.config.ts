/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Mirrors the `define` in vite.config.ts — the build stamp is a compile-time
  // constant, so anything rendering it is a ReferenceError without these.
  define: {
    __BUILD_ID__: JSON.stringify("test"),
    __BUILD_TIME__: JSON.stringify("2026-01-01T00:00:00.000Z"),
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    server: {
      deps: {
        // `@testing-library/jest-dom/vitest` calls `expect.extend` on whatever
        // `require("vitest")` hands it. Left externalised, that is resolved by
        // Node from wherever npm hoisted jest-dom — the workspace root, which
        // carries vitest 4 for `@cloudflare/vitest-pool-workers` (see
        // `server/package.json`) rather than the vitest 5 the client actually
        // runs on. The matchers then land on a *different* `expect` than the
        // one under test, and the two chai instances break the assertions
        // neither package touches: `rejects.toThrow` starts throwing
        // "Cannot read properties of undefined" instead of comparing messages.
        // Inlining routes the import through Vite's resolver, which is rooted
        // here, so jest-dom extends this package's own vitest. It can go once
        // the whole repo is back on one vitest major.
        inline: [/@testing-library\/jest-dom/],
      },
    },
  },
});
