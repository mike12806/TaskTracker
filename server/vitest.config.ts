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
    // CI runs on self-hosted runner pods that get a slice of a node, but
    // vitest's default is one worker per node CPU (each one a full workerd
    // or jsdom instance). Four of those runs at once drove a 4-CPU node into
    // memory thrashing, so CI is capped at two workers; local runs keep the
    // default.
    maxWorkers: process.env.CI ? 2 : undefined,
  },
});
