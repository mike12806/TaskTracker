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
    // Threads rather than child processes. Each test file still gets its own
    // worker and its own jsdom; a thread is cheaper to start than a process, and
    // the workers share one, so a run takes less CPU and memory than forks.
    pool: "threads",
    // Pre-bundle the libraries every component imports. Unbundled, every test
    // file loads @mui/material (and Emotion, and React) as hundreds of separate
    // modules; bundled, each is a single file.
    // Leave out anything a test `vi.mock`s: its mock factory stops matching the
    // import once the module is bundled.
    deps: {
      optimizer: {
        client: {
          enabled: true,
          include: [
            "@mui/material",
            "@mui/material/styles",
            "@emotion/react",
            "@emotion/styled",
            "react",
            "react-dom",
          ],
        },
      },
    },
    // CI runs on self-hosted runner pods that get a slice of a node, but
    // vitest's default is one worker per node CPU (each one a full workerd
    // or jsdom instance). Four of those runs at once drove a 4-CPU node into
    // memory thrashing, so CI is capped at two workers; local runs keep the
    // default.
    maxWorkers: process.env.CI ? 2 : undefined,
    // The heaviest tests can pass 5 s on a 2-CPU runner pod; give them room.
    testTimeout: 25_000,
    // Setup hooks (beforeEach/beforeAll) still had vitest's 10 s default and
    // timed out on the same pods; match the test timeout.
    hookTimeout: 25_000,
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
