import { expect, test } from "@playwright/test";
import { loginAsEditor, resetCmsStorage } from "./helpers";

test.beforeEach(async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  await page.goto("/links");
});

test("editable links keep normal click for editing and modifier-click for navigation", async ({ page, context }) => {
  const editable = page.getByRole("link", { name: "About" }).locator("[data-caret]");
  await expect(editable).toHaveClass(/cms-editable/);

  await editable.click();
  await expect(page).toHaveURL(/\/links$/);
  await expect(editable).toBeFocused();

  const popupPromise = context.waitForEvent("page");
  await editable.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(popup).toHaveURL(/\/about$/);
  await popup.close();
});

test("open affordance avoids adjacent editable links and works for linked images", async ({ page }) => {
  const home = page.getByRole("link", { name: "Home" }).locator("[data-caret]");
  const about = page.getByRole("link", { name: "About" }).locator("[data-caret]");

  // Hover must occur after the lazy editor has installed its link handlers.
  await expect(about).toHaveClass(/cms-editable/);
  await about.hover();
  const open = page.locator(".cms-link-follow");
  await expect(open).toBeVisible();
  const [homeBox, openBox] = await Promise.all([home.boundingBox(), open.boundingBox()]);
  expect(homeBox).not.toBeNull();
  expect(openBox).not.toBeNull();
  const overlapsHome = openBox!.x < homeBox!.x + homeBox!.width
    && openBox!.x + openBox!.width > homeBox!.x
    && openBox!.y < homeBox!.y + homeBox!.height
    && openBox!.y + openBox!.height > homeBox!.y;
  expect(overlapsHome).toBe(false);

  // The Replace control floats over the linked image; hovering it still
  // counts as hovering the image for the Open affordance.
  const linkedImage = page.locator('img[data-caret="hero.image"]');
  await expect(linkedImage).toHaveAttribute("data-caret-img-mounted", "true");
  await linkedImage.hover({ force: true }); // the Replace control covers it once shown
  await page.locator(".cms-img-overlay").hover();
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("href", "/about");

  await about.focus();
  await expect(open).toHaveAttribute("href", "/about");
  await open.focus();
  await page.waitForTimeout(250);
  await expect(open).toBeVisible();
  await expect(open).toBeFocused();
});
