import { defineConfig, devices } from "@playwright/test";

const PORT = 4402;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/markdown-body.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium-markdown", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "npm run build:core --prefix ../.. && npm run build && node dist/server/entry.mjs",
    cwd: "examples/content-site",
    url: `http://localhost:${PORT}/blog/ship-something-real/`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      CARET_EDIT_PASSWORD: "e2e-secret",
      CARET_SESSION_SECRET: "e2e-markdown-session-secret-not-for-real-use-0123456789",
      HOST: "0.0.0.0",
      PORT: String(PORT),
    },
  },
});
