import { expect, test } from "@playwright/test";
import { loginAsEditor, resetCmsStorage } from "./helpers";

const originalHeadline = "Launch an Astro site with live inline editing.";
const previewHeadline = "Sidebar visual preview";

test.beforeEach(async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);

  const seed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "pages",
      id: "home",
      data: {
        hero: {
          headline: originalHeadline,
          subtext: "Annotate normal HTML with data-caret and edit content in place.",
          image: "/initial.png",
        },
        our_teaching_philosophy: "Our Teaching Philosophy",
      },
    },
  });
  expect(seed.ok()).toBe(true);
  const aboutSeed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "pages",
      id: "about",
      data: {
        hero: {
          headline: "About CaretCMS",
          subtext: "A second route for cross-page Studio preview navigation.",
          image: "/initial.png",
        },
        our_teaching_philosophy: "About philosophy",
      },
    },
  });
  expect(aboutSeed.ok()).toBe(true);
});

test("sidebar Studio links fields in both directions and stays on the entry after save", async ({ page }) => {
  await page.goto("/");
  const headline = page.locator('[data-caret="hero.headline"]');
  await expect(headline).toHaveText(originalHeadline);

  await page.locator(".cms-studio-btn").click();
  const panel = page.locator(".cms-studio-panel");
  await expect(panel).toHaveClass(/open/);

  const iframe = page.locator('iframe[title="Content Studio"]');
  const studio = page.frameLocator('iframe[title="Content Studio"]');
  await expect(studio.getByRole("heading", { name: "Content Studio" })).toBeVisible();

  await headline.dispatchEvent("pointerdown", { bubbles: true });
  await expect(iframe).toHaveAttribute("src", "/admin/cms/pages/home");
  await expect(headline).toHaveClass(/cms-linked-selection/);
  await expect(studio.locator('[data-field-path="hero.headline"]')).toHaveClass(/caret-field-selected/);
  const headlineInput = studio.getByRole("textbox", { name: "Headline", exact: true });
  await expect(headlineInput).toHaveValue(originalHeadline);
  await expect(headlineInput).toHaveAttribute("id", "caret-field-hero-headline");

  const subtext = page.locator('[data-caret="hero.subtext"]');
  await studio.getByRole("textbox", { name: "Subtext" }).focus();
  await expect(subtext).toHaveClass(/cms-linked-selection/);

  await headlineInput.fill(previewHeadline);
  await expect(headline).toHaveText(previewHeadline);

  const saved = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  const refreshed = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await studio.locator("#btn-save").click();
  await studio.getByRole("dialog", { name: "Save live changes?" }).getByRole("button", { name: "Save live" }).click();
  expect((await saved).ok()).toBe(true);
  await refreshed;

  await expect(headline).toHaveText(previewHeadline);
  await expect(panel).toHaveClass(/open/);
  await expect(studio.getByRole("textbox", { name: "Headline", exact: true })).toHaveValue(previewHeadline);
  await expect(iframe).toHaveAttribute("src", "/admin/cms/pages/home");
});

test("standalone Studio and preview tab link fields through BroadcastChannel", async ({ page, context }) => {
  await page.goto("/");
  const headline = page.locator('[data-caret="hero.headline"]');
  const subtext = page.locator('[data-caret="hero.subtext"]');

  const studioPage = await context.newPage();
  await studioPage.goto("/admin/cms/pages/home");
  const subtextInput = studioPage.getByRole("textbox", { name: "Subtext" });
  await expect(subtextInput).toBeVisible();

  await subtextInput.focus();
  await expect(subtext).toHaveClass(/cms-linked-selection/);

  await headline.dispatchEvent("pointerdown", { bubbles: true });
  await expect(headline).toHaveClass(/cms-linked-selection/);
  await expect(studioPage.locator('[data-field-path="hero.headline"]')).toHaveClass(/caret-field-selected/);
});

test("Studio selection navigates to another preview route before highlighting the field", async ({ page, context }) => {
  await page.goto("/");

  const studioPage = await context.newPage();
  await studioPage.goto("/admin/cms/pages/about");
  const headlineInput = studioPage.getByRole("textbox", { name: "Headline", exact: true });
  await expect(headlineInput).toBeVisible();

  await headlineInput.focus();
  await page.waitForURL("/about");
  await expect(page.locator('[data-caret="hero.headline"]')).toHaveClass(/cms-linked-selection/);
});
