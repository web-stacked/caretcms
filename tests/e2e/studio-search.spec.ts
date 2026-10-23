import { expect, test, type Page } from "@playwright/test";
import { loginAsEditor, resetCmsStorage } from "./helpers";

async function seed(page: Page, id: string, data: Record<string, unknown>) {
  const response = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id, data: { published: true, ...data } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("combobox", { name: "Go to a collection or entry" });
  await expect(input).toBeFocused();
  return input;
}

test.beforeEach(async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
});

test("search finds words inside entries and shows where they matched", async ({ page }) => {
  await seed(page, "typeface", { title: "Typeface notes", summary: "Mara <strong>draws letterforms</strong> for fun." });
  await seed(page, "letterforms", { title: "Letterforms" });
  await page.goto("/admin/cms");
  const input = await openPalette(page);
  await input.fill("letterforms");

  const options = page.getByRole("option");
  // The entry named by the query comes first, then the one that mentions it.
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Letterforms");
  await expect(options.nth(1)).toContainText("Typeface notes");
  await expect(options.nth(1).locator(".studio-palette-snippet")).toHaveText("Mara draws letterforms for fun.");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/cms\/studio-fixture\/typeface$/);
});

test("the palette runs actions: new entry, theme, open site, history", async ({ page }) => {
  await seed(page, "with-history", { title: "With history" });
  await seed(page, "with-history", { title: "With history, again" });
  await page.goto("/admin/cms");

  let input = await openPalette(page);
  await input.fill("new studio");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText("New entry");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/cms\/studio-fixture$/);
  await expect(page.getByRole("dialog", { name: "New entry" })).toBeVisible();
  await page.keyboard.press("Escape");

  input = await openPalette(page);
  await input.fill("theme dark");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  input = await openPalette(page);
  await input.fill("open site");
  await expect(page.getByRole("option")).toContainText("Open site");

  await page.goto("/admin/cms/studio-fixture/with-history");
  await expect(page.locator("#editor")).toBeVisible();
  input = await openPalette(page);
  await input.fill("history");
  await page.getByRole("option", { name: /Version history/ }).click();
  await expect(page.getByRole("region", { name: "Version history" })).toBeVisible();
});
