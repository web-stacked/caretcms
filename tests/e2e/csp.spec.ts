import { test, expect } from "@playwright/test";
import { blurToSave, loginAsEditor, replaceText, resetCmsStorage } from "./helpers";

const HEADLINE = 'h1[data-caret="hero.headline"]';
const NEW_HEADLINE = "Edited under a strict CSP";

/**
 * The inline editor must run with ZERO Content Security Policy violations under
 * Astro's strict CSP. The starter enables plain `security.csp: true` (hash +
 * host-allowlist). Astro auto-hashes the editor's injected bootstrap, and every
 * other editor asset (editor.js, its module imports, editor.css) is same-origin
 * from /__caret/, so the default `script-src 'self'` covers them. `strict-dynamic`
 * is deliberately NOT used — it disables 'self' and would break the editor.
 *
 * CSP is only emitted for production builds, so this runs against `astro
 * preview` via playwright.csp.config.ts — not the dev-based main suite.
 */
test.describe("inline editor — strict CSP", () => {
  test.beforeEach(() => {
    resetCmsStorage();
  });

  test("editor bootstraps, edits, and saves with no CSP violations", async ({ page }) => {
    // securitypolicyviolation fires in-page for every blocked script/style/fetch.
    // addInitScript is injected via CDP (not a page <script>), so it isn't itself
    // subject to the CSP and attaches before any page script runs.
    await page.addInitScript(() => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
          `${e.violatedDirective} blocked ${e.blockedURI || "inline"}`,
        );
      });
    });

    await loginAsEditor(page);
    const response = await page.goto("/");

    // CSP is actually active for this navigation (not just absent), and is the
    // hash + host-allowlist policy the editor relies on (every editor asset is
    // same-origin, so 'self' covers them — see examples/starter/astro.config.mjs).
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp, "no Content-Security-Policy header — CSP is not active").toMatch(/script-src/i);
    expect(csp).toContain("'self'");

    // The editor bootstrapped under CSP: the hashed bootstrap ran, injected
    // editor.js, which flipped the body into edit mode and bound the element.
    await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);
    await expect(page.locator(HEADLINE)).toHaveClass(/cms-editable/);

    // Exercise a full edit → save so editor.js, its module imports, the toast,
    // and the /api/cms fetches all execute under the policy.
    await replaceText(page, page.locator(HEADLINE), NEW_HEADLINE);
    await expect(page.locator(HEADLINE)).toHaveText(NEW_HEADLINE);
    const mutate = await blurToSave(page, page.locator(HEADLINE));
    expect(mutate.ok(), await mutate.text()).toBeTruthy();
    await expect(page.getByText("Content saved")).toBeVisible();

    // No violations were recorded at any point in the flow.
    const violations = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    expect(violations).toEqual([]);
  });
});
