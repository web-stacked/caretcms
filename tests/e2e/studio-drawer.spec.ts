import { expect, test, type Page } from "@playwright/test";
import { blurToSave, loginAsEditor, openStudio, replaceText, resetCmsStorage } from "./helpers";

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
  // Nothing saved yet: the entry opens with the text the page shows.
  await expect(studio.getByRole("textbox", { name: "Headline", exact: true }))
    .toHaveValue("Launch an Astro site with live inline editing.");
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

  const studio = await openStudio(page, "/admin/cms?on=studio-fixture::listed&on=pages::about-us&on=bad::id::extra&on=Bad::x");
  const section = studio.getByRole("region", { name: "On this page" });
  const entries = section.locator(".studio-page-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("Listed entry");
  await expect(entries.nth(0)).toHaveAttribute("href", "/admin/cms/studio-fixture/listed");
  await expect(entries.nth(1)).toContainText("About us");
  await expect(studio.getByRole("region", { name: "Collections" })).toBeVisible();

  await openStudio(page, "/admin/cms");
  await expect(studio.getByRole("region", { name: "On this page" })).toHaveCount(0);
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
  const resting = await page.locator(".cms-status-text").textContent();
  await page.evaluate(() => {
    const text = document.querySelector(".cms-status-text");
    if (text) text.textContent = "Published, site not updated";
  });
  await page.waitForTimeout(700);
  // The bar grows leftward; buttons to the right of the status stay put.
  expect((await signOut.boundingBox())?.x).toBe(before?.x);
  await page.evaluate((text) => {
    const status = document.querySelector(".cms-status-text");
    if (status) status.textContent = text;
  }, resting);
  await page.waitForTimeout(700);

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

test("fixed bars move beside the pushing drawer and get their own styles back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  // A site header, a centered cookie bar, and a small chat bubble.
  await page.evaluate(() => {
    const add = (id: string, css: string) => {
      const el = document.createElement("div");
      el.id = id;
      el.style.cssText = css;
      document.body.append(el);
    };
    add("fixed-header", "position: fixed; top: 0; left: 0; right: 0; height: 48px; background: #ddd;");
    add("cookie-bar", "position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); width: 80%; height: 40px; background: #eee;");
    add("chat-bubble", "position: fixed; bottom: 16px; right: 16px; width: 56px; height: 56px;");
    // Styled only by a stylesheet: no style attribute of its own.
    const style = document.createElement("style");
    style.textContent = "#nav-bar { position: fixed; top: 0; left: 0; width: 100%; height: 30px; }";
    document.head.append(style);
    const nav = document.createElement("nav");
    nav.id = "nav-bar";
    document.body.append(nav);
  });
  const styles = () => page.evaluate(() =>
    ["fixed-header", "cookie-bar", "chat-bubble", "nav-bar"].map((id) => document.getElementById(id)!.getAttribute("style")));
  const box = async (id: string) => (await page.locator(`#${id}`).boundingBox())!;
  const original = await styles();
  const viewWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const room = viewWidth - 380;
  const bubble = await box("chat-bubble");

  await page.getByRole("button", { name: "Studio", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/cms-studio-push/);
  expect(await box("fixed-header")).toMatchObject({ x: 380, width: room });
  expect(await box("nav-bar")).toMatchObject({ x: 380, width: room });
  const cookie = await box("cookie-bar");
  expect(cookie.x).toBeCloseTo(380 + room * 0.1, 0);
  expect(cookie.width).toBeCloseTo(room * 0.8, 0);
  expect(await box("chat-bubble")).toEqual(bubble);

  await page.locator(".cms-panel-move").click();
  expect(await box("fixed-header")).toMatchObject({ x: 0, width: room });

  await page.locator(".cms-panel-expand").click();
  await expect.poll(styles).toEqual(original);
  await page.locator(".cms-panel-expand").click();
  expect(await box("fixed-header")).toMatchObject({ x: 0, width: room });

  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(async () => (await box("fixed-header")).width).toBe(await page.evaluate(() => document.documentElement.clientWidth - 380));

  await page.locator(".cms-panel-close").click();
  await expect.poll(styles).toEqual(original);
});
