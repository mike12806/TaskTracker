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
  },
});
