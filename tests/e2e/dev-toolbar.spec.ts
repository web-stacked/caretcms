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
    const highlight = page.getByRole("button", { name: "Highlight all" });

    expect(await present()).toBe(false);
    await expect(highlight).toHaveAttribute("aria-pressed", "false");
    await highlight.click();
    expect(await present()).toBe(true);

    // Toggling off removes the injected outline style without closing the app.
    const hide = page.getByRole("button", { name: "Hide all" });
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    await hide.click();
    expect(await present()).toBe(false);
    await expect(page.getByText("CaretCMS bindings")).toBeVisible();
    await expect(highlight).toHaveAttribute("aria-pressed", "false");
  });

  test("cleans up a repeated scroll-to flash", async ({ page }) => {
    await page.goto("/");
    await openPanel(page);

    const binding = page.locator('[data-caret="hero.headline"]');
    const initial = await binding.evaluate((el) => ({
      outline: (el as HTMLElement).style.outline,
      outlineOffset: (el as HTMLElement).style.outlineOffset,
    }));
    const jump = page.getByRole("button", { name: "scroll to" }).first();

    await jump.click();
    await expect(binding).toHaveCSS("outline-style", "solid");
    await page.waitForTimeout(100);
    await jump.click();
    await page.waitForTimeout(1_700);

    await expect
      .poll(() =>
        binding.evaluate((el) => ({
          outline: (el as HTMLElement).style.outline,
          outlineOffset: (el as HTMLElement).style.outlineOffset,
        })),
      )
      .toEqual(initial);
  });

  test("flags orphan bindings and duplicate keys", async ({ page }) => {
    await page.goto("/");

    await page.evaluate(() => {
      // Orphan: field-only attr outside any data-caret-scope ancestor.
      const orphan = document.createElement("p");
      orphan.setAttribute("data-caret", "stray_field");
      orphan.dataset.toolbarFixture = "true";
      orphan.textContent = "orphan";
      document.body.appendChild(orphan);

      // Duplicate: a second element resolving to an existing key
      // (hero.headline under the pages::home scope).
      const main = document.querySelector("main[data-caret-scope]")!;
      const dup = document.createElement("p");
      dup.setAttribute("data-caret", "hero.headline");
      dup.dataset.toolbarFixture = "true";
      dup.textContent = "dup";
      main.appendChild(dup);
    });

    await openPanel(page);

    await expect(page.getByText(/orphan binding/i)).toBeVisible();
    await expect(page.getByText("stray_field")).toBeVisible();
    await expect(page.getByText(/duplicate key/i)).toBeVisible();
    await expect(page.getByText("pages::home::hero.headline")).toBeVisible();

    const notification = page
      .getByRole("button", { name: TOOLBAR_BUTTON, exact: true })
      .locator(".notification");
    await expect(notification).toHaveAttribute("data-active", "");

    await page.evaluate(() => {
      document.querySelectorAll('[data-toolbar-fixture="true"]').forEach((el) => el.remove());
    });
    await page.getByRole("button", { name: "Rescan" }).click();

    await expect(page.getByText(/orphan binding/i)).toHaveCount(0);
    await expect(page.getByText(/duplicate key/i)).toHaveCount(0);
    await expect(notification).not.toHaveAttribute("data-active", "");
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
