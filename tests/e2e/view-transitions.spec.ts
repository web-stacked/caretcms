import { expect, test } from "@playwright/test";
import { expectStudioURL, fetchAnonymousHtml, loginAsEditor, openStudio, resetCmsStorage } from "./helpers";

/** Sites using Astro's <ClientRouter /> change pages without a reload. */

test.beforeEach(() => resetCmsStorage());

test("the editor keeps working across view-transition navigations", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/vt/one");
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  await expect(page.locator("main h1[data-caret]")).toHaveClass(/cms-editable/);
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });

  await page.getByRole("link", { name: "Go to page two" }).click();
  await expect(page).toHaveURL(/\/vt\/two$/);
  // Scoped to the page: Astro's dev toolbar has headings in its shadow DOM.
  await expect(page.locator("main h1")).toHaveText("Page two headline");
  expect(navigations.filter((url) => url.endsWith("/vt/two"))).toHaveLength(1);
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  await expect(page.locator(".cms-toolbar")).toHaveCount(1);
  await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);

  // The new page's bindings are editable, and saving works.
  const headline = page.locator("main h1[data-caret]");
  await expect(headline).toHaveClass(/cms-editable/);
  await headline.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Edited after a view transition");
  await headline.evaluate((el) => (el as HTMLElement).blur());
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await fetchAnonymousHtml("/vt/two")).toContain("Edited after a view transition");

  // And back again.
  // A client-side back: no load event, so not page.goBack().
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/vt\/one$/);
  await expect(page.locator("main h1[data-caret]")).toHaveClass(/cms-editable/);
  await expect(page.locator(".cms-toolbar")).toHaveCount(1);
});

test("following fields and links in the drawer doesn't add to the tab's history", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/about");
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  // Arrive on the home page by a normal navigation: one history entry.
  await page.goto("/");
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  const before = await page.evaluate(() => history.length);

  // Moving around inside the drawer: Back to the Studio home, then a link.
  const studio = await openStudio(page, "/admin/cms/pages/home");
  await page.locator(".cms-panel-back").click();
  await expectStudioURL(page, "/admin/cms");
  await studio.locator('a[href="/admin/cms/pages"]').first().click();
  await expectStudioURL(page, "/admin/cms/pages");

  // Clicking a field moves the drawer to that field's entry.
  await page.locator(".cms-panel-expand").click();
  await page.locator('h1[data-caret]').click();
  await expectStudioURL(page, "/admin/cms/pages/home");

  // Only the Studio address itself was a navigation of the tab.
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/localhost:\d+\/$/);
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/about$/);
});
