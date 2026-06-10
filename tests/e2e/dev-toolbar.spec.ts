import { test, expect } from "@playwright/test";

/**
 * Dev Toolbar app E2E. The toolbar only exists under `astro dev` (which this
 * suite uses — see playwright.config.ts), and the app is deliberately
 * login-free, so none of these tests authenticate. Playwright's role/text
 * locators pierce the toolbar's open shadow roots, so we can drive the panel
 * without manual shadowRoot traversal.
 *
 * The orphan / duplicate / empty states are exercised by mutating the live DOM
 * via page.evaluate before opening the panel — the scan reads the document at
 * open time, so injected elements show up without needing dedicated fixtures.
 */

const TOOLBAR_BUTTON = "CaretCMS"; // accessible name of the dev-toolbar app button

async function openPanel(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: TOOLBAR_BUTTON, exact: true }).click();
  await expect(page.getByText("CaretCMS bindings")).toBeVisible();
}

test.describe("dev toolbar — config injection", () => {
  test("injects window.__CARET_DEV__ with mount/api paths in dev", async ({ page }) => {
    await page.goto("/");
    const cfg = await page.evaluate(() => (window as { __CARET_DEV__?: unknown }).__CARET_DEV__);
    expect(cfg).toEqual({ mountPath: "/admin", apiBasePath: "/api/cms" });
  });
});

test.describe("dev toolbar — binding inspector", () => {
  test("registers a CaretCMS app and lists bindings grouped by entry", async ({ page }) => {
    await page.goto("/");
    await openPanel(page);

    // Header count reflects the four bindings on the starter home page.
    await expect(page.getByText("4 on page")).toBeVisible();

    // All four resolve under the single pages::home scope (three field-only
    // attrs via data-caret-scope + one full-key binding), proving scope
    // resolution works from the toolbar.
    await expect(page.getByText("pages::home", { exact: true })).toBeVisible();
    for (const field of ["hero.headline", "hero.subtext", "hero.image", "our_teaching_philosophy"]) {
      await expect(page.getByText(field, { exact: true })).toBeVisible();
    }

    // image vs text classification (badge label is lowercase in the DOM,
    // shown uppercase via CSS text-transform).
    await expect(page.getByText("image", { exact: true })).toBeVisible();

    // Studio deep-link respects the configured mountPath.
    const studio = page.getByRole("link", { name: /Open in Studio/ });
    await expect(studio).toHaveAttribute("href", "/admin/cms/pages/home");
  });

  test("highlights bindings without logging in", async ({ page }) => {
    await page.goto("/");
    await openPanel(page);

    const styleId = "__caret-devtoolbar-highlight__";
    const present = () => page.evaluate((id) => !!document.getElementById(id), styleId);

    expect(await present()).toBe(false);
    await page.getByRole("button", { name: "Highlight all" }).click();
    expect(await present()).toBe(true);

    // Toggling off removes the injected outline style.
    await page.getByRole("button", { name: "Hide all" }).click();
    expect(await present()).toBe(false);
  });

  test("flags orphan bindings and duplicate keys", async ({ page }) => {
    await page.goto("/");

    await page.evaluate(() => {
      // Orphan: field-only attr outside any data-caret-scope ancestor.
      const orphan = document.createElement("p");
      orphan.setAttribute("data-caret", "stray_field");
      orphan.textContent = "orphan";
      document.body.appendChild(orphan);

      // Duplicate: a second element resolving to an existing key
      // (hero.headline under the pages::home scope).
      const main = document.querySelector("main[data-caret-scope]")!;
      const dup = document.createElement("p");
      dup.setAttribute("data-caret", "hero.headline");
      dup.textContent = "dup";
      main.appendChild(dup);
    });

    await openPanel(page);

    await expect(page.getByText(/orphan binding/i)).toBeVisible();
    await expect(page.getByText("stray_field")).toBeVisible();
    await expect(page.getByText(/duplicate key/i)).toBeVisible();
    await expect(page.getByText("pages::home::hero.headline")).toBeVisible();
  });

  test("shows an empty state when the page has no bindings", async ({ page }) => {
    await page.goto("/");

    // Strip every binding, then open — the scan should report none.
    await page.evaluate(() => {
      document.querySelectorAll("[data-caret]").forEach((el) => el.removeAttribute("data-caret"));
    });

    await openPanel(page);
    await expect(page.getByText(/No .*data-caret.* bindings found/i)).toBeVisible();
  });
});
