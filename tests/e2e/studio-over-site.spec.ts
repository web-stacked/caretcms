import { expect, test, type Page } from "@playwright/test";
import {
  EDIT_PASSWORD,
  STUDIO_PANEL,
  expectStudioURL,
  loginAsEditor,
  openStudio,
  resetCmsStorage,
  waitForStudioLoad,
} from "./helpers";

/**
 * The Studio lives over the site: a Studio address opened in a tab of its own
 * lands on the site page it belongs to, with the Studio open over it.
 */

const panel = (page: Page) => page.locator(STUDIO_PANEL);
const expandButton = (page: Page) => panel(page).locator(".cms-panel-expand");

test.beforeEach(async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
});

test("a Studio entry address opens over the page that shows the entry", async ({ page }) => {
  // The server hands a top-level Studio request to the site page, with the
  // route in the fragment; the drawer's own frame requests render as usual.
  const handoff = await page.request.get("/admin/cms/pages/about", {
    headers: { "Sec-Fetch-Dest": "document" },
    maxRedirects: 0,
  });
  expect(handoff.status()).toBe(303);
  expect(handoff.headers().location).toBe(`/about#caret-studio=${encodeURIComponent("/admin/cms/pages/about")}`);
  const framed = await page.request.get("/admin/cms/pages/about", {
    headers: { "Sec-Fetch-Dest": "iframe" },
    maxRedirects: 0,
  });
  expect(framed.status()).toBe(200);

  await page.goto("/admin/cms/pages/about");
  // On the entry's page, with the fragment gone from the address.
  await expect(page).toHaveURL("/about");
  await expect(panel(page)).toHaveClass(/\bopen\b/);
  await expect(panel(page)).toHaveClass(/\bexpanded\b/);
  await expect(panel(page)).toHaveAttribute("aria-hidden", "false");
  await waitForStudioLoad(page);
  await expectStudioURL(page, "/admin/cms/pages/about");
  await expect(page.locator(".cms-panel-title")).toHaveText("Edit About");
  // Expanded: two thirds of the window, the Studio's own sidebar inside.
  const box = (await panel(page).boundingBox())!;
  expect(box.width).toBeGreaterThan(800);
  const studio = page.frameLocator(`${STUDIO_PANEL} iframe`);
  await expect(studio.getByRole("navigation", { name: "Collections" })).toBeVisible();
  await expect(studio.getByRole("textbox", { name: "Headline", exact: true })).toBeVisible();
  // The page's own toolbar steps aside while the Studio is expanded.
  await expect(page.locator(".cms-toolbar")).toBeHidden();
});

test("the Studio overview and a collection open over the editor's home page", async ({ page }) => {
  await openStudio(page, "/admin/cms");
  await expect(page).toHaveURL("/");
  await expectStudioURL(page, "/admin/cms");

  await page.goto("/about");
  const studio = await openStudio(page, "/admin/cms/pages");
  await expect(page).toHaveURL("/");
  await expectStudioURL(page, "/admin/cms/pages");
  await expect(studio.locator("#entries-grid")).toBeVisible();
});

test("Shrink and Expand switch the Studio between a drawer and two thirds, across reloads", async ({ page }) => {
  await openStudio(page, "/admin/cms/pages/about");
  await expect(expandButton(page)).toHaveAccessibleName("Shrink the Studio to a drawer");
  await expect(expandButton(page)).toHaveAttribute("aria-pressed", "true");

  await expandButton(page).click();
  await expect(panel(page)).not.toHaveClass(/\bexpanded\b/);
  await expect(expandButton(page)).toHaveAccessibleName("Expand the Studio");
  await expect(expandButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await panel(page).boundingBox())?.width).toBe(380);
  await expect(page.locator(".cms-toolbar")).toBeVisible();

  // A reload keeps the drawer open, at its size, on its route.
  await page.reload();
  await expect(panel(page)).toHaveClass(/\bopen\b/);
  await expect(panel(page)).not.toHaveClass(/\bexpanded\b/);
  await waitForStudioLoad(page);
  await expectStudioURL(page, "/admin/cms/pages/about");

  await expandButton(page).click();
  await expect(panel(page)).toHaveClass(/\bexpanded\b/);
  await expect.poll(async () => (await panel(page).boundingBox())?.width).toBeGreaterThan(800);
  await page.reload();
  await expect(panel(page)).toHaveClass(/\bopen\b/);
  await expect(panel(page)).toHaveClass(/\bexpanded\b/);
  await expect(expandButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL("/about");
});

test("Close and Escape put the page back where it was", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/pages/about");
  await panel(page).getByRole("button", { name: "Close" }).click();
  await expect(panel(page)).not.toHaveClass(/\bopen\b/);
  await expect(panel(page)).toHaveAttribute("aria-hidden", "true");
  await expect(page).toHaveURL("/about");
  await expect(page.locator(".cms-toolbar")).toBeVisible();

  const studioButton = page.getByRole("button", { name: "Studio", exact: true });
  await studioButton.click();
  await expect(panel(page)).toHaveClass(/\bopen\b/);
  await expect(studio.getByRole("textbox", { name: "Headline", exact: true })).toBeVisible();
  // Escape from inside the Studio's frame.
  await studio.getByRole("textbox", { name: "Headline", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(panel(page)).not.toHaveClass(/\bopen\b/);
  await expect(page).toHaveURL("/about");
  await expect(studioButton).toBeFocused();
});

test("the Studio's View site closes it on the page it opened over", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/pages/about");
  await studio.locator("#studio-site-link").click();
  await expect(panel(page)).not.toHaveClass(/\bopen\b/);
  // Not the editor's home page: the site stays where it was.
  await expect(page).toHaveURL("/about");
  await expect(page.locator('[data-caret="hero.headline"]')).toBeVisible();
});

test("an entry's view-page link moves the site to that page with the Studio still on the entry", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/pages");
  await expect(page).toHaveURL("/");
  await studio.locator('#entries-grid a[href$="/pages/about"]').click();
  await expectStudioURL(page, "/admin/cms/pages/about");

  await studio.locator("#entry-more > summary").click();
  const preview = studio.locator("#btn-preview");
  // In the Studio the page opens behind it, not in another tab.
  await expect(preview).not.toHaveAttribute("target");
  await Promise.all([
    page.waitForURL("/about"),
    preview.click(),
  ]);
  await expect(panel(page)).toHaveClass(/\bopen\b/);
  await expect(panel(page)).toHaveClass(/\bexpanded\b/);
  await waitForStudioLoad(page);
  await expectStudioURL(page, "/admin/cms/pages/about");
  expect(page.context().pages()).toHaveLength(1);
});

test("signing out from the expanded Studio leaves the site, not just the Studio's frame", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms");
  const logout = page.waitForResponse((response) =>
    response.url().includes("/api/cms/auth/logout") && response.request().method() === "POST");
  await studio.locator("#studio-logout-btn").click();
  expect((await logout).ok()).toBe(true);
  // The whole window moves to the sign-in page.
  await expect(page).toHaveURL(/\/admin(\?.*)?$/);
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.locator(STUDIO_PANEL)).toHaveCount(0);
  expect(page.frames()).toHaveLength(1);
});

test("signing in from a Studio address ends on the site with the Studio open", async ({ browser, baseURL }) => {
  const visitor = await browser.newContext({ baseURL });
  try {
    const page = await visitor.newPage();
    await page.goto("/admin/cms/pages/about");
    // Sign-in is a page of its own, never inside the Studio's frame.
    await expect(page).toHaveURL(/\/admin\?redirect=/);
    await expect(page.locator(STUDIO_PANEL)).toHaveCount(0);
    await page.locator("#password").fill(EDIT_PASSWORD);
    await page.locator("#password").press("Enter");

    await expect(page).toHaveURL("/about");
    await expect(panel(page)).toHaveClass(/\bopen\b/);
    await expect(panel(page)).toHaveClass(/\bexpanded\b/);
    await waitForStudioLoad(page);
    await expectStudioURL(page, "/admin/cms/pages/about");
  } finally {
    await visitor.close();
  }
});
