import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "cloudflare-durable.spec.ts",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4411", browserName: "chromium" },
  webServer: {
    command: "npm run build:core && npm run build:cloudflare && npx wrangler dev --config tests/e2e/fixtures/cloudflare-durable/wrangler.toml --port 4411 --local",
    url: "http://127.0.0.1:4411",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
