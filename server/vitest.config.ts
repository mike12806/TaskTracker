import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
      miniflare: {
        d1Databases: { DB: "test-db" },
        kvNamespaces: { CACHE: "test-cache" },
      },
    }),
  ],
  test: {
    pool: "@cloudflare/vitest-pool-workers",
    // CI runs on GitHub-hosted runners with 4 CPUs, so it gets one worker per
    // CPU (each one a full workerd or jsdom instance); local runs keep vitest's
    // default.
    maxWorkers: process.env.CI ? 4 : undefined,
    // The heaviest tests can pass 5 s on a 2-CPU runner pod; give them room.
    testTimeout: 25_000,
    // Setup hooks (beforeEach/beforeAll) still had vitest's 10 s default and
    // timed out on the same pods; match the test timeout.
    hookTimeout: 25_000,
  },
});
