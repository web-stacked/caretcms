import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { loginAsEditor, resetCmsStorage } from "./helpers";

async function expectNoAxeViolations(page: Page): Promise<void> {
  await page.waitForTimeout(350);
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}

test("login, collection list, and schema-rendered entry pass axe", async ({ page }) => {
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
  await expect(page.getByRole("dialog", { name: "Delete entry" })).toBeVisible();
  await expect(page.locator("#btn-delete-cancel")).toBeFocused();
  await expectNoAxeViolations(page);
  await page.locator("#btn-delete-cancel").press("Escape");

  await page.locator("#btn-history").click();
  await expect(page.getByRole("region", { name: "Version history" })).toBeVisible();
  await expect(page.locator("#btn-history-close")).toBeFocused();
  await expectNoAxeViolations(page);
  await page.locator("#btn-history-close").press("Escape");

  await page.goto("/");
  await expect(page.locator(".cms-img-overlay")).toBeVisible();
  await expect(page.locator('.cms-img-wrapper input[type="file"]')).toHaveAttribute(
    "aria-label",
    "Upload replacement image",
  );
});
