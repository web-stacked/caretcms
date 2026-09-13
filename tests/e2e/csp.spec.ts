import { createHash } from "node:crypto";
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


test("Studio modules load and save under a script CSP with hashes", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  const seeded = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id: "module-entry", data: {
      title: "Module entry", summary: "First\nSecond\n", website: "", published: false, details: [], images: [],
    } },
  });
  expect(seeded.ok()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", event => {
      document.documentElement.setAttribute("data-csp-violation", event.violatedDirective);
    });
  });
  // Studio is an HTML API route. Apply a test policy to its actual server HTML,
  // hashing the existing inline shell scripts and allowing same-origin modules.
  await page.route("**/admin/cms/studio-fixture/module-entry", async route => {
    const response = await route.fetch();
    const html = await response.text();
    const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
      .map(match => "'sha256-" + createHash("sha256").update(match[1]).digest("base64") + "'");
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": "script-src 'self' " + hashes.join(" ") } });
  });
  const modules = new Set<string>();
  page.on("response", response => {
    if (response.ok() && response.url().includes("/__caret/studio/")) modules.add(new URL(response.url()).pathname);
  });
  await page.goto("/admin/cms/studio-fixture/module-entry");
  await expect(page.getByRole("textbox", { name: /^Summary/ })).toHaveValue("First\nSecond\n");
  await page.getByRole("textbox", { name: /^Title/ }).fill("Saved through Studio modules");
  page.once("dialog", dialog => dialog.accept());
  const saved = page.waitForResponse(response => response.url().includes("/api/cms/mutate") && response.request().method() === "POST");
  await page.locator("#btn-save").click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("textbox", { name: /^Title/ })).toHaveValue("Saved through Studio modules");
  await expect(page.getByRole("textbox", { name: /^Summary/ })).toHaveValue("First\nSecond\n");
  expect(modules).toEqual(new Set([
    "/__caret/studio/entry-loader.js",
    "/__caret/studio/field-model.js",
    "/__caret/studio/fields.js",
    "/__caret/studio/history-client.js",
    "/__caret/studio/mutation-client.js",
    "/__caret/studio/sync-client.js",
    "/__caret/studio/upload-client.js",
  ]));
  await expect(page.locator("html")).not.toHaveAttribute("data-csp-violation");
  expect(errors).toEqual([]);
});
