import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { loginAsEditor, resetCmsStorage } from "./helpers";

async function expectNoAxeViolations(page: Page): Promise<void> {
  // Entrance animations change opacity, so contrast is checked once they settle.
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) test(`login, collection list, and schema-rendered entry pass axe in ${colorScheme} mode`, async ({ page }) => {
  await page.emulateMedia({ colorScheme });
  resetCmsStorage();

  await page.goto("/admin");
  await expect(page.locator("#login-form")).toBeVisible();
  await expectNoAxeViolations(page);

  await loginAsEditor(page);
  const seed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "studio-fixture",
      id: "axe-entry",
      data: {
        title: "Accessibility fixture",
        summary: "Representative Studio fields",
        website: "https://example.com",
        published: false,
        details: [{ label: "Medium", value: "Mixed media" }],
        images: [{
          id: "axe-image",
          src: "/initial.png",
          title: "Fixture image",
          alt: "Fixture image",
          width: 1600,
          height: 1200,
        }],
      },
    },
  });
  expect(seed.ok()).toBe(true);

  await page.goto("/admin/cms/studio-fixture");
  await expect(page.locator(".entry-card")).toBeVisible();
  await expectNoAxeViolations(page);

  await page.locator("#btn-new").click();
  await expect(page.getByRole("dialog", { name: "New entry" })).toBeVisible();
  await expect(page.locator("#create-title-input")).toBeFocused();
  await expectNoAxeViolations(page);
  await page.locator("#create-title-input").press("Escape");

  await page.locator("#btn-reorder").click();
  await expect(page.getByRole("region", { name: "Arrange entries" })).toBeVisible();
  await expect(page.locator("#btn-reorder-cancel")).toBeFocused();
  await expectNoAxeViolations(page);
  await page.locator("#btn-reorder-cancel").press("Escape");

  await page.goto("/admin/cms/studio-fixture/axe-entry");
  await expect(page.locator("#editor")).toBeVisible();
  await expectNoAxeViolations(page);

  await page.locator("#entry-more > summary").click();
  await page.locator("#btn-delete").click();
  await expect(page.locator("#delete-notice")).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.goto("/admin/cms/studio-fixture/axe-entry");
  await expect(page.locator("#editor")).toBeVisible();

  await page.locator("#btn-history").click();
  await expect(page.getByRole("region", { name: "Version history" })).toBeVisible();
  await expect(page.locator("#btn-history-close")).toBeFocused();
  await expectNoAxeViolations(page);
  await page.locator("#btn-history-close").press("Escape");

  await page.goto("/");
  const image = page.locator("img[data-caret]").first();
  await expect(image).toHaveAttribute("data-caret-img-mounted", "true");
  await image.hover({ force: true });
  await expect(page.locator(".cms-img-overlay")).toBeVisible();
  await expect(page.locator(".cms-img-input")).toHaveAttribute(
    "aria-label",
    "Upload replacement image",
  );
});

test("the editor toolbar is one labeled Tab stop that a skip link reaches first", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  await page.goto("/");
  const toolbar = page.getByRole("toolbar", { name: "Site editor" });
  await expect(toolbar).toBeVisible();

  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to editor toolbar" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  const pill = page.locator(".cms-status-pill");
  await expect(pill).toBeFocused();

  // Arrow keys move inside the bar and wrap; the bar keeps one Tab stop.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(pill).toBeFocused();
  expect(await toolbar.locator('[tabindex="0"]').count()).toBe(1);

  // Tab returns to the control used last.
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeFocused();
});

test("Studio pages start with a skip link to the content or the form", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  const seed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id: "skip-entry", data: { title: "Skip fixture", published: false } },
  });
  expect(seed.ok(), await seed.text()).toBe(true);
  await page.goto("/admin/cms/studio-fixture/skip-entry");
  await expect(page.locator("#editor")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to form" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator("#fields")).toContainText("Title");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("#fields")))).toBe(true);

  await page.goto("/admin/cms");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
});
