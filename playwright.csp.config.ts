import { defineConfig, devices } from "@playwright/test";

/**
 * CSP e2e — proves the inline editor runs with ZERO Content Security Policy
 * violations under Astro's strict CSP (`security.csp: true`, configured in
 * examples/starter/astro.config.mjs).
 *
 * Astro only emits the CSP policy for a production build (it is ignored in
 * `astro dev`), so unlike the main suite this builds the starter and serves it
 * via the Node adapter's built entrypoint. Kept in a separate config + script
 * (`test:e2e:csp`) so
 * the fast dev-based suite isn't slowed by a production build.
 */
const PORT = 4400;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/csp.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium-csp", use: { ...devices["Desktop Chrome"] } }],
  globalTeardown: "./tests/e2e/global-teardown.ts",
  webServer: {
    command:
      `npm run build:core --prefix ../.. && npm run build && ` +
      `node dist/server/entry.mjs`,
    cwd: "examples/starter",
    url: `http://localhost:${PORT}/`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      CARET_EDIT_PASSWORD: "e2e-secret",
      // The built server runs in production mode, where a session secret is required.
      CARET_SESSION_SECRET: "e2e-csp-session-secret-not-for-real-use-0123456789",
      HOST: "0.0.0.0",
      PORT: String(PORT),
    },
  },
});
