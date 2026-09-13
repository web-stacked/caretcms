import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.STATIC_E2E_PORT ?? "4403";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/static-delivery.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 180_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium-static", use: { ...devices["Desktop Chrome"] } }],
});
