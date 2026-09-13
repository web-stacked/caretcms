import { defineConfig, devices } from "@playwright/test";

const PORT = 4405;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/permissions.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "on-first-retry" },
  projects: [{ name: "chromium-permissions", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build:core --prefix ../.. && npm run build && node dist/server/entry.mjs",
    cwd: "examples/starter",
    url: `http://localhost:${PORT}/`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      CARET_E2E_POLICY: "true",
      CARET_SESSION_SECRET: "e2e-permissions-session-secret-not-for-real-use-0123456789",
      HOST: "127.0.0.1",
      PORT: String(PORT),
    },
  },
});
