import { expect, test, type Page } from "@playwright/test";
import { STUDIO_PANEL, expectStudioURL, loginAsEditor, openStudio, resetCmsStorage } from "./helpers";

async function seed(page: Page, id: string, data: Record<string, unknown>) {
  const response = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id, data: { published: true, ...data } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.frameLocator(`${STUDIO_PANEL} iframe`).getByRole("combobox", { name: "Go to a collection or entry" });
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
  const studio = await openStudio(page, "/admin/cms");
  const input = await openPalette(page);
  await input.fill("letterforms");

  const options = studio.getByRole("option");
  // The entry named by the query comes first, then the one that mentions it.
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Letterforms");
  await expect(options.nth(1)).toContainText("Typeface notes");
  await expect(options.nth(1).locator(".studio-palette-snippet")).toHaveText("Mara draws letterforms for fun.");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expectStudioURL(page, /\/admin\/cms\/studio-fixture\/typeface$/);
});

test("the palette runs actions: new entry, theme, open site, history", async ({ page }) => {
  await seed(page, "with-history", { title: "With history" });
  await seed(page, "with-history", { title: "With history, again" });
  const studio = await openStudio(page, "/admin/cms");

  let input = await openPalette(page);
  await input.fill("new studio");
  await expect(studio.getByRole("option")).toHaveCount(1);
  await expect(studio.getByRole("option")).toContainText("New entry");
  await page.keyboard.press("Enter");
  await expectStudioURL(page, /\/admin\/cms\/studio-fixture$/);
  await expect(studio.getByRole("dialog", { name: "New entry" })).toBeVisible();
  await page.keyboard.press("Escape");

  input = await openPalette(page);
  await input.fill("theme dark");
  await expect(studio.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(studio.locator("html")).toHaveAttribute("data-theme", "dark");

  input = await openPalette(page);
  await input.fill("open site");
  await expect(studio.getByRole("option")).toContainText("Open site");
  // The Studio is over the site already: opening the site closes it there.
  await page.keyboard.press("Enter");
  await expect(page.locator(STUDIO_PANEL)).not.toHaveClass(/\bopen\b/);
  await expect(page).toHaveURL("/");

  await openStudio(page, "/admin/cms/studio-fixture/with-history");
  await expect(studio.locator("#editor")).toBeVisible();
  input = await openPalette(page);
  await input.fill("history");
  await studio.getByRole("option", { name: /Version history/ }).click();
  await expect(studio.getByRole("region", { name: "Version history" })).toBeVisible();
});
