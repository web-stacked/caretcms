import { expect, test, type Page } from "@playwright/test";
import { blurToSave, loginAsEditor, replaceText, resetCmsStorage } from "./helpers";

const drawerFrame = (page: Page) => page.locator('iframe[title="Content Studio"]');

/** Where keyboard focus is: the drawer, the toolbar, or the page behind them. */
const focusRegion = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (active?.closest(".cms-studio-panel")) return "drawer";
    if (active?.closest(".cms-toolbar")) return "toolbar";
    return "page";
  });

test.beforeEach(async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
});

test("the drawer opens the entry for the page you're on and stays where you leave it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await expect(drawerFrame(page)).toHaveAttribute("src", "/admin/cms/pages/home");
  await expect(page.locator(".cms-panel-title")).toHaveText("Edit Home");

  // Another page doesn't inherit the home page's entry.
  await page.goto("/about");
  await expect(drawerFrame(page)).toHaveAttribute("src", "/admin/cms/pages/about");
  await expect(page.locator(".cms-panel-title")).toHaveText("Edit About");

  // A route chosen in the drawer survives a reload of the same page.
  await drawerFrame(page).evaluate((frame) => { (frame as HTMLIFrameElement).contentWindow?.location.assign("/admin/cms"); });
  await expect(page.locator(".cms-panel-title")).toHaveText("Content Studio");
  await page.reload();
  await expect(page.locator(".cms-panel-title")).toHaveText("Content Studio");
  await expect(drawerFrame(page)).toHaveAttribute("src", "/admin/cms");
});

test("the drawer shows what inline edits saved, including an entry's first save", async ({ page }) => {
  await page.goto("/");
  const studioButton = page.getByRole("button", { name: "Studio", exact: true });
  const studio = page.frameLocator('iframe[title="Content Studio"]');
  await studioButton.click();
  await expect(studio.getByText("Nothing is saved for this content yet")).toBeVisible();
  await page.locator(".cms-panel-close").click();

  const headline = page.locator('[data-caret="hero.headline"]');
  await replaceText(page, headline, "Saved on the page");
  expect((await blurToSave(page, headline)).ok()).toBe(true);

  await studioButton.click();
  await expect(studio.getByRole("textbox", { name: "Headline", exact: true })).toHaveValue("Saved on the page");
});

test("the Studio overview lists the entries a page passes, with their titles", async ({ page }) => {
  const seed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id: "listed", data: { title: "Listed entry", published: true } },
  });
  expect(seed.ok(), await seed.text()).toBe(true);

  await page.goto("/admin/cms?on=studio-fixture::listed&on=pages::about-us&on=bad::id::extra&on=Bad::x");
  const section = page.getByRole("region", { name: "On this page" });
  const entries = section.locator(".studio-page-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("Listed entry");
  await expect(entries.nth(0)).toHaveAttribute("href", "/admin/cms/studio-fixture/listed");
  await expect(entries.nth(1)).toContainText("About us");
  await expect(page.getByRole("region", { name: "Collections" })).toBeVisible();

  await page.goto("/admin/cms");
  await expect(page.getByRole("region", { name: "On this page" })).toHaveCount(0);
});

test("Tab cycles through the drawer and the toolbar, never the page behind", async ({ page }) => {
  await page.goto("/");
  const studioButton = page.getByRole("button", { name: "Studio", exact: true });
  await studioButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cms-panel-title")).toHaveText("Edit Home");

  const forward = new Set<string>();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    forward.add(await focusRegion(page));
  }
  expect([...forward].sort()).toEqual(["drawer", "toolbar"]);

  const backward = new Set<string>();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Shift+Tab");
    backward.add(await focusRegion(page));
  }
  expect([...backward].sort()).toEqual(["drawer", "toolbar"]);

  await page.locator(".cms-panel-close").focus();
  await page.keyboard.press("Escape");
  await expect(studioButton).toHaveAttribute("aria-expanded", "false");
  await expect(studioButton).toBeFocused();
});

test("toolbar buttons stay under the pointer when the status changes or the drawer opens", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const studioButton = page.locator(".cms-studio-btn");
  await expect(page.locator(".cms-toolbar")).toHaveClass(/cms-toolbar-anchored/);
  // Let the toolbar's entrance animation finish before measuring.
  await page.waitForTimeout(1200);
  const box = await studioButton.boundingBox();
  if (!box) throw new Error("Studio button has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  const signOut = page.locator(".cms-exit-btn");
  const before = await signOut.boundingBox();
  await page.evaluate(() => {
    const text = document.querySelector(".cms-status-text");
    if (text) text.textContent = "Published, deploy failed";
  });
  await page.waitForTimeout(700);
  // The bar grows leftward; buttons to the right of the status stay put.
  expect((await signOut.boundingBox())?.x).toBe(before?.x);

  await page.mouse.click(x, y);
  await expect(studioButton).toHaveAttribute("aria-expanded", "true");
  await page.waitForTimeout(700);
  const under = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("button")?.className ?? "", [x, y]);
  expect(under).toContain("cms-studio-btn");

  // At a width where the drawer would cover the bar, it moves just clear.
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForTimeout(700);
  const toolbar = await page.locator(".cms-toolbar").boundingBox();
  const drawer = await page.locator(".cms-studio-panel").boundingBox();
  expect(toolbar!.x).toBeGreaterThanOrEqual(drawer!.x + drawer!.width);
});
