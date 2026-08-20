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

  await page.goto("/admin/cms/studio-fixture/axe-entry");
  await expect(page.locator("#editor")).toBeVisible();
  await expectNoAxeViolations(page);

  await page.goto("/");
  await expect(page.locator(".cms-img-overlay")).toBeVisible();
  await expect(page.locator('.cms-img-wrapper input[type="file"]')).toHaveAttribute(
    "aria-label",
    "Upload replacement image",
  );
});
