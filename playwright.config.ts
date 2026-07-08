import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the inline editor — the product's headline feature.
 *
 * Target app: examples/starter (Node standalone adapter, default filesystem
 * storage, embedded mode). It is the simplest faithful integration of
 * `@caretcms/core`, so a green run here proves the click→edit→save→
 * rewrite path end-to-end.
 *
 * The core package must be built (`npm run build:core`) before the starter's
 * dev server can resolve `@caretcms/core` from `dist`.
 */
const PORT = 4399;

export default defineConfig({
  testDir: "./tests/e2e",
  // The CSP spec runs against a production build via playwright.csp.config.ts
  // (CSP is ignored in `astro dev`, which this dev-based suite uses).
  testIgnore: "**/csp.spec.ts",
  fullyParallel: false, // tests share one filesystem-backed app; keep writes serial
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Astro 7's `astro dev` is a managed background server (it daemonizes), which a
  // Playwright `webServer` can't reliably stop on teardown. globalSetup/teardown
  // own its lifecycle deterministically instead. See tests/e2e/global-setup.ts.
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
});
