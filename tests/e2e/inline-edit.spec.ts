import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  blurToSave,
  fetchAnonymousHtml,
  isMutatePost,
  loginAsEditor,
  replaceText,
  resetCmsStorage,
} from "./helpers";

const HEADLINE = 'h1[data-caret="hero.headline"]';
const TEMPLATE_HEADLINE = "Launch an Astro site with live inline editing.";
const HERO_IMAGE = 'img[data-caret="hero.image"]';
const SAMPLE_PNG = fileURLToPath(new URL("./fixtures/sample.png", import.meta.url));

test.beforeEach(() => {
  resetCmsStorage();
});

test.describe("inline editor — security gate", () => {
  test("anonymous visitor gets the read-only template, not the editor", async ({ page }) => {
    await page.goto("/");

    // Template content renders unchanged…
    await expect(page.locator(HEADLINE)).toHaveText(TEMPLATE_HEADLINE);

    // …but the editor never mounts: no edit-mode body class, no contenteditable.
    await expect(page.locator("body")).not.toHaveClass(/cms-edit-mode/);
    await expect(page.locator(HEADLINE)).not.toHaveAttribute("contenteditable", /.*/);
  });
});

test.describe("inline editor — click to edit", () => {
  test("editor mounts for an authenticated editor", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");

    // Bootstrap probes the session then injects editor.js, which flips the body
    // into edit mode and makes bound elements contenteditable.
    await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);
    await expect(page.locator(HEADLINE)).toHaveClass(/cms-editable/);
    await expect(page.locator(HEADLINE)).toHaveAttribute(
      "contenteditable",
      "plaintext-only",
    );
  });

  test("editing a headline persists and is served to anonymous visitors", async ({ page }) => {
    const NEW_HEADLINE = "Edited inline by the E2E suite";

    await loginAsEditor(page);
    await page.goto("/");

    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await replaceText(page, headline, NEW_HEADLINE);
    // Confirm the typing actually replaced the live text before we rely on blur.
    await expect(headline).toHaveText(NEW_HEADLINE);

    // Blur fires the save. Assert the write actually hit the mutate endpoint.
    const mutate = await blurToSave(page, headline);
    expect(mutate.ok()).toBeTruthy();

    // The save-confirmation toast appears.
    await expect(page.getByText("Content saved")).toBeVisible();

    // The override is persisted and rendered by the rewrite middleware for an
    // anonymous visitor — independent of this page's live DOM mutation.
    const anonHtml = await fetchAnonymousHtml("/");
    expect(anonHtml).toContain(NEW_HEADLINE);
    expect(anonHtml).not.toContain(TEMPLATE_HEADLINE);
  });

  test("a stale edit loses to a concurrent write (409) without clobbering it", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");

    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    // First edit: revision 0 → 1. The editor now caches revision 1 for this entry.
    await replaceText(page, headline, "First edit");
    await blurToSave(page, headline);
    await expect(page.getByText("Content saved")).toBeVisible();

    // A concurrent writer bumps the entry to revision 2 out-of-band, exactly as
    // a second editor (or another tab) would. The browser editor still believes
    // the revision is 1.
    const conflict = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: {
        type: "save_field",
        collection: "pages",
        id: "home",
        field: "hero.headline",
        value: "Changed elsewhere",
        expectedRevision: 1,
      },
    });
    expect(conflict.ok()).toBeTruthy();

    // Second edit with the now-stale cached revision → the server must reject
    // with 409 rather than silently overwriting the concurrent change.
    await replaceText(page, headline, "Second edit");
    const stale = await blurToSave(page, headline);
    expect(stale.status()).toBe(409);

    // The editor surfaces the conflict and reloads the latest value rather than
    // keeping the rejected local edit.
    await expect(page.getByText("Content changed elsewhere. Loaded latest value.")).toBeVisible();
    await expect(headline).toHaveText("Changed elsewhere");

    // Storage holds the concurrent write, not the stale one.
    const anonHtml = await fetchAnonymousHtml("/");
    expect(anonHtml).toContain("Changed elsewhere");
    expect(anonHtml).not.toContain("Second edit");
  });

  test("swapping a hero image uploads, persists, and serves the new src", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");

    const image = page.locator(HERO_IMAGE);
    await expect(image).toHaveAttribute("src", "/initial.png");

    // The image editor wraps each bound <img> and injects a hidden file input.
    const fileInput = page.locator(".cms-img-wrapper input[type='file']");
    await expect(fileInput).toBeAttached();

    // Selecting a file kicks off compress → /upload → save_field(url).
    const [upload, mutate] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/cms/upload") && r.request().method() === "POST",
      ),
      page.waitForResponse(isMutatePost),
      fileInput.setInputFiles(SAMPLE_PNG),
    ]);
    expect(upload.ok()).toBeTruthy();
    expect(mutate.ok()).toBeTruthy();

    await expect(page.getByText("Image updated")).toBeVisible();

    // The live <img> now points at an uploaded asset, not the template default.
    await expect(image).toHaveAttribute("src", /^\/uploads\/.+\.(webp|png|jpe?g)$/);
    const newSrc = await image.getAttribute("src");

    // The override is persisted and served to anonymous visitors via rewrite.
    const anonHtml = await fetchAnonymousHtml("/");
    expect(anonHtml).toContain(`src="${newSrc}"`);
    expect(anonHtml).not.toContain('src="/initial.png"');
  });

  test("pressing Escape cancels an edit without saving", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");

    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await replaceText(page, headline, "This should be discarded");
    await page.keyboard.press("Escape");
    await page.locator("body").click();

    // Live DOM reverts to the template value…
    await expect(headline).toHaveText(TEMPLATE_HEADLINE);

    // …and nothing was persisted: anonymous visitor still sees the template.
    const anonHtml = await fetchAnonymousHtml("/");
    expect(anonHtml).toContain(TEMPLATE_HEADLINE);
    expect(anonHtml).not.toContain("This should be discarded");
  });
});
