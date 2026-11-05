import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { STUDIO_PANEL, loginAsEditor, openStudio, resetCmsStorage, studioFrame } from "./helpers";

async function expectNoAxeViolations(page: Page, { studio = false } = {}): Promise<void> {
  // Entrance animations change opacity, so contrast is checked once they settle.
  const settled = () => document.getAnimations().every((animation) =>
    animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity);
  await page.waitForFunction(settled);
  if (studio) await (await studioFrame(page)).waitForFunction(settled);
  // Over the site, the subject is the Studio — its drawer and the frame in
  // it — not the site page behind it.
  const axe = new AxeBuilder({ page });
  const result = await (studio ? axe.include(STUDIO_PANEL) : axe).analyze();
  if (studio) {
    // axe reaches into the Studio's frame: its nodes are addressed through the
    // drawer's iframe.
    const inStudio = [...result.passes, ...result.violations]
      .flatMap((rule) => rule.nodes)
      .filter((node) => node.target.length > 1);
    expect(inStudio.length).toBeGreaterThan(0);
  }
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
}

/**
 * Put focus just before the Studio's page: on the drawer's last header
 * control, so the next Tab is the first stop in the Studio's frame.
 */
async function startTabbingFromTop(page: Page): Promise<void> {
  await page.locator(`${STUDIO_PANEL} .cms-panel-close`).focus();
}

for (const colorScheme of ["light", "dark"] as const) test(`login, collection list, and schema-rendered entry pass axe in ${colorScheme} mode`, async ({ page }) => {
  await page.emulateMedia({ colorScheme });
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
  // Arrange needs at least two entries.
  const second = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id: "second-entry", data: { title: "Second entry", summary: "", website: "", published: false, details: [], images: [] } },
  });
  expect(second.ok(), await second.text()).toBe(true);

  const studio = await openStudio(page, "/admin/cms/studio-fixture");
  await expect(studio.locator(".entry-card")).toHaveCount(2);
  await expectNoAxeViolations(page, { studio: true });

  await studio.locator("#btn-new").click();
  await expect(studio.getByRole("dialog", { name: "New entry" })).toBeVisible();
  await expect(studio.locator("#create-title-input")).toBeFocused();
  await expectNoAxeViolations(page, { studio: true });
  await studio.locator("#create-title-input").press("Escape");

  await studio.locator("#btn-reorder").click();
  await expect(studio.getByRole("region", { name: "Arrange entries" })).toBeVisible();
  const firstMove = studio.locator(".reorder-move:not([disabled])").first();
  await expect(firstMove).toBeFocused();
  await expectNoAxeViolations(page, { studio: true });
  await firstMove.press("Escape");

  await openStudio(page, "/admin/cms/studio-fixture/axe-entry");
  await expect(studio.locator("#editor")).toBeVisible();
  await expectNoAxeViolations(page, { studio: true });

  await studio.locator("#entry-more > summary").click();
  await studio.locator("#btn-delete").click();
  await expect(studio.locator("#delete-notice")).toBeVisible();
  await expectNoAxeViolations(page, { studio: true });
  await studio.getByRole("button", { name: "Undo" }).click();
  await openStudio(page, "/admin/cms/studio-fixture/axe-entry");
  await expect(studio.locator("#editor")).toBeVisible();

  await studio.locator("#btn-history").click();
  await expect(studio.getByRole("region", { name: "Version history" })).toBeVisible();
  await expect(studio.locator("#btn-history-close")).toBeFocused();
  await expectNoAxeViolations(page, { studio: true });
  await studio.locator("#btn-history-close").press("Escape");
  await expect(page.locator(`${STUDIO_PANEL}.open`)).toBeVisible();

  // Back on the site with the Studio closed.
  await page.locator(".cms-panel-close").click();
  await page.goto("/");
  await expect(page.locator(STUDIO_PANEL)).not.toHaveClass(/\bopen\b/);
  const image = page.locator("img[data-caret]").first();
  await expect(image).toHaveAttribute("data-caret-img-mounted", "true");
  await image.hover({ force: true });
  await expect(page.locator(".cms-img-overlay")).toBeVisible();
  await expect(page.locator(".cms-img-input")).toHaveAttribute(
    "aria-label",
    "Upload replacement image",
  );
});

test("the editor toolbar is one labeled Tab stop that a skip link reaches first", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  await page.goto("/");
  const toolbar = page.getByRole("toolbar", { name: "Site editor" });
  await expect(toolbar).toBeVisible();

  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to editor toolbar" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  const pill = page.locator(".cms-status-pill");
  await expect(pill).toBeFocused();

  // Arrow keys move inside the bar and wrap; the bar keeps one Tab stop.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(pill).toBeFocused();
  expect(await toolbar.locator('[tabindex="0"]').count()).toBe(1);

  // Tab returns to the control used last.
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeFocused();
});

test("Studio pages start with a skip link to the content or the form", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  const seed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id: "skip-entry", data: { title: "Skip fixture", published: false } },
  });
  expect(seed.ok(), await seed.text()).toBe(true);
  const studio = await openStudio(page, "/admin/cms/studio-fixture/skip-entry");
  await expect(studio.locator("#editor")).toBeVisible();
  // Opening the Studio puts focus on its heading; Tab into the Studio's page
  // from the drawer's header reaches the skip link first.
  await startTabbingFromTop(page);
  await page.keyboard.press("Tab");
  await expect(studio.getByRole("link", { name: "Skip to form" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(studio.locator("#fields")).toContainText("Title");
  expect(await (await studioFrame(page)).evaluate(() => Boolean(document.activeElement?.closest("#fields")))).toBe(true);

  await openStudio(page, "/admin/cms");
  await startTabbingFromTop(page);
  await page.keyboard.press("Tab");
  await expect(studio.getByRole("link", { name: "Skip to content" })).toBeFocused();
});
