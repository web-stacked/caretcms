import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
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

function stegaTag(value: string, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const start = String.fromCodePoint(0xe0000);
  const end = String.fromCodePoint(0xe0001);
  const body = [...encoded]
    .map((character) => String.fromCodePoint(0xe0000 + character.charCodeAt(0)))
    .join("");
  return `${value}${start}${body}${end}`;
}

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

  test("Edit and Preview modes switch page interactions without losing editability", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);

    const modes = page.getByRole("group", { name: "Page mode" });
    const edit = modes.getByRole("button", { name: "Edit", exact: true });
    const preview = modes.getByRole("button", { name: "Preview", exact: true });
    await expect(edit).toHaveAttribute("aria-pressed", "true");

    await preview.click();
    await expect(page.locator("body")).toHaveClass(/cms-preview-mode/);
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(HEADLINE)).toHaveAttribute("contenteditable", "false");
    await expect(page.locator(".cms-img-overlay")).toBeHidden();
    await expect(page.locator(".cms-section-controls").first()).toBeHidden();

    await edit.click();
    await expect(page.locator("body")).not.toHaveClass(/cms-preview-mode/);
    await expect(edit).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(HEADLINE)).toHaveAttribute("contenteditable", "plaintext-only");
  });

  test("stega hydration promotes only valid bindings and removes hidden metadata", async ({ page }) => {
    const valid = stegaTag("Hydrated headline", "pages::home::hero.headline");
    const invalid = stegaTag("Invalid metadata", "not-a-binding");
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.resourceType() !== "document" || url.pathname !== "/") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /(<main\b[^>]*data-caret-scope="pages::home"[^>]*>)/,
        `$1<p id="stega-valid">${valid}</p><p id="stega-invalid">${invalid}</p>`,
      );
      await route.fulfill({ response, body });
    });
    await loginAsEditor(page);
    await page.goto("/");

    const validElement = page.locator("#stega-valid");
    await expect(validElement).toHaveText("Hydrated headline");
    await expect(validElement).toHaveAttribute("data-caret", "pages::home::hero.headline");
    await expect(validElement).toHaveClass(/cms-editable/);
    const invalidElement = page.locator("#stega-invalid");
    await expect(invalidElement).toHaveText("Invalid metadata");
    await expect(invalidElement).not.toHaveAttribute("data-caret", /.*/);
  });

  test("Studio panel survives blocked session storage and closes from iframe Escape", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const originalGet = Storage.prototype.getItem;
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.getItem = function getItem(key) {
        if (String(key).startsWith("cms-panel")) throw new DOMException("Blocked", "SecurityError");
        return originalGet.call(this, key);
      };
      Storage.prototype.setItem = function setItem(key, value) {
        if (String(key).startsWith("cms-panel")) throw new DOMException("Blocked", "SecurityError");
        return originalSet.call(this, key, value);
      };
    });
    await loginAsEditor(page);
    await page.goto("/");

    const studioButton = page.getByRole("button", { name: "Studio", exact: true });
    await studioButton.focus();
    await studioButton.click();
    const panel = page.getByRole("dialog", { name: "Content Studio" });
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await expect(studioButton).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByRole("button", { name: "Close" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Expand" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Move Studio panel right" })).toBeVisible();

    const studio = page.frameLocator('iframe[title="Content Studio"]');
    await expect(studio.getByRole("button", { name: "Sign out" })).toBeHidden();
    await expect(studio.locator(".studio-header")).toBeHidden();
    await studio.getByRole("link", { name: /Pages/ }).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".cms-studio-panel")).toHaveAttribute("aria-hidden", "true");
    await expect(studioButton).toBeFocused();
    expect(pageErrors).toEqual([]);

    await studioButton.click();
    await panel.getByRole("button", { name: "Expand" }).click();
    await expect(page).toHaveURL(/\/admin\/cms$/);
  });

  test("Studio panel controls preserve work and keep selected content beside the drawer", async ({ page }) => {
    await loginAsEditor(page);
    const seed = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: {
        type: "put_entry",
        collection: "pages",
        id: "home",
        data: {
          hero: {
            headline: TEMPLATE_HEADLINE,
            subtext: "Editable subtext",
            image: "/initial.png",
          },
          our_teaching_philosophy: "Our Teaching Philosophy",
        },
      },
    });
    expect(seed.ok()).toBe(true);
    await page.goto("/");
    await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);
    await page.evaluate(() => {
      for (const [id, side] of [["left-binding", "left"], ["right-binding", "right"]]) {
        const button = document.createElement("button");
        button.id = id;
        button.textContent = `${side} binding`;
        button.setAttribute("data-caret", `pages::home::review.${side}`);
        Object.assign(button.style, {
          position: "fixed",
          top: "80px",
          [side]: "8px",
          zIndex: "99998",
        });
        document.body.append(button);
      }
    });

    const studioButton = page.getByRole("button", { name: "Studio", exact: true });
    const panel = page.getByRole("dialog", { name: "Content Studio" });
    await page.locator("#left-binding").click();
    await studioButton.click();
    await expect(panel).toHaveClass(/side-right/);
    await expect(panel.getByRole("button", { name: "Move Studio panel left" })).toBeVisible();

    await panel.getByRole("button", { name: "Close" }).click();
    await page.locator("#right-binding").click();
    await studioButton.click();
    await expect(panel).not.toHaveClass(/side-right/);

    const studio = page.frameLocator('iframe[title="Content Studio"]');
    const iframe = page.locator('iframe[title="Content Studio"]');
    await expect(iframe).toHaveAttribute("src", "/admin/cms/pages/home");
    const headline = studio.getByRole("textbox", { name: "Headline", exact: true });
    await headline.fill("Unsaved drawer value");
    await panel.getByRole("button", { name: "Close" }).click();
    await studioButton.click();
    await expect(headline).toHaveValue("Unsaved drawer value");
  });

  test("content map targets duplicate bindings individually and handles malformed entry data", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await loginAsEditor(page);
    await page.goto("/");

    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);
    const duplicate = page.locator("#content-map-duplicate");
    await page.locator("main[data-caret-scope]").evaluate((main) => {
      const element = document.createElement("p");
      element.id = "content-map-duplicate";
      element.setAttribute("data-caret", "hero.headline");
      element.textContent = "Duplicate headline binding";
      main.append(element);
    });
    await page.route("**/api/cms/entries**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }));

    await page.locator(".cms-tools-summary").click();
    const highlight = page.getByRole("button", { name: "Show editable areas" });
    await expect(highlight).toHaveAttribute("aria-pressed", "false");
    await highlight.click();
    await expect(page.getByRole("button", { name: "Hide editable areas" }))
      .toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Hide editable areas" }).click();
    await page.locator(".cms-map-btn").click();
    await expect(page.locator(".cms-tools-menu")).not.toHaveAttribute("open", "");
    const panel = page.locator(".cms-content-map");
    const map = page.getByRole("region", { name: "Content map" });
    await expect(map).toHaveAttribute("aria-hidden", "false");
    await expect(map.getByText("pages::home", { exact: true })).toBeVisible();
    const rows = map.getByRole("button", { name: /hero\.headline/ });
    await expect(rows).toHaveCount(2);
    await rows.nth(1).focus();
    await page.keyboard.press("Enter");
    await expect(duplicate).toHaveClass(/cms-map-highlight/);
    await expect(headline).not.toHaveClass(/cms-map-highlight/);

    await map.getByRole("button", { name: "Close content map" }).click();
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("region", { name: "Content map" })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("section controls remain operable with malformed responses and preserve layout context", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/cms/entries**", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }));
    await page.route("**/api/cms/mutate", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: "null" });
    });
    await loginAsEditor(page);
    await page.goto("/");

    const hero = page.locator('section[data-caret-section-id="hero"]');
    const philosophy = page.locator('section[data-caret-section-id="philosophy"]');
    await expect(hero).toHaveClass(/cms-section-editable/);
    await expect(philosophy).toHaveClass(/cms-section-editable/);

    await hero.hover();
    const insert = hero.getByRole("button", { name: "Insert section below" });
    await insert.click();
    const insertDialog = page.getByRole("dialog", { name: "Insert section" });
    await expect(insertDialog).toBeVisible();
    await expect(insertDialog.getByRole("button", { name: "Hero", exact: true })).toBeFocused();
    const [insertBox, toolbarBox] = await Promise.all([
      insertDialog.boundingBox(),
      page.locator(".cms-toolbar").boundingBox(),
    ]);
    expect(insertBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(insertBox!.y + insertBox!.height).toBeLessThanOrEqual(toolbarBox!.y);
    await page.keyboard.press("Escape");
    await expect(insertDialog).toBeHidden();
    await expect(insert).toBeFocused();

    const [moveRequest] = await Promise.all([
      page.waitForRequest((request) =>
        request.url().includes("/api/cms/mutate") && request.method() === "POST"),
      hero.getByRole("button", { name: "Down", exact: true }).click(),
    ]);
    expect(moveRequest.postDataJSON()).toMatchObject({
      type: "update_page_layout",
      collection: "pages",
      id: "home",
      expectedRevision: 0,
    });
    await expect(page.getByText("Section moved down")).toBeVisible();
    await expect(page.locator("main > section").first()).toHaveAttribute(
      "data-caret-section-id",
      "philosophy",
    );

    await hero.hover();
    await expect(hero.locator(".cms-section-gap-label")).toHaveText("Default spacing");
    await hero.getByText("More", { exact: true }).click();
    await expect(hero.getByRole("button", { name: "Duplicate", exact: true })).toBeVisible();
    const [hideRequest] = await Promise.all([
      page.waitForRequest((request) =>
        request.url().includes("/api/cms/mutate") && request.method() === "POST"),
      hero.getByRole("button", { name: "Hide", exact: true }).click(),
    ]);
    expect(hideRequest.postDataJSON()).toMatchObject({
      collection: "pages",
      id: "home",
      expectedRevision: 1,
    });
    await expect(hero).toHaveClass(/cms-section-disabled-preview/);
    await expect(page.getByText("Section hidden")).toBeVisible();

    const storedResponse = await page.request.get("/api/cms/entries?collection=pages&id=home");
    expect(storedResponse.ok()).toBeTruthy();
    const stored = await storedResponse.json();
    expect(stored.entries[0].data.layout.sections).toMatchObject([
      { id: "philosophy", key: "home.features", enabled: true },
      { id: "hero", key: "home.hero", enabled: false },
    ]);
    expect(pageErrors).toEqual([]);
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

  test("keeps a committed save successful when the response JSON is null", async ({ page }) => {
    const newHeadline = "Saved despite a null response body";
    await loginAsEditor(page);
    await page.goto("/");
    await page.route("**/api/cms/mutate", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: "null" });
    });

    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);
    await replaceText(page, headline, newHeadline);
    const mutate = await blurToSave(page, headline);
    expect(mutate.ok()).toBeTruthy();
    await expect(page.getByText("Content saved")).toBeVisible();
    await expect(headline).toHaveText(newHeadline);

    const anonHtml = await fetchAnonymousHtml("/");
    expect(anonHtml).toContain(newHeadline);
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

    // The editor must NOT silently discard the user's edit. It keeps "Second
    // edit" in the field and shows a conflict prompt with an explicit choice.
    await expect(
      page.getByText("This content changed elsewhere while you were editing."),
    ).toBeVisible();
    await expect(headline).toHaveText("Second edit");

    // Choosing "Load latest" pulls in the concurrent write, discarding the local edit.
    await page.getByRole("button", { name: "Load latest" }).click();
    await expect(headline).toHaveText("Changed elsewhere");

    // Storage holds the concurrent write, not the stale one.
    const anonHtml = await fetchAnonymousHtml("/");
    expect(anonHtml).toContain("Changed elsewhere");
    expect(anonHtml).not.toContain("Second edit");
  });

  test("on a 409, choosing 'Keep mine' overwrites with the local edit", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");

    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    // Seed a cached revision (0 → 1) for this entry.
    await replaceText(page, headline, "Local first");
    await blurToSave(page, headline);
    await expect(page.getByText("Content saved")).toBeVisible();

    // Out-of-band concurrent write bumps the revision behind the editor's back.
    const conflict = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: {
        type: "save_field",
        collection: "pages",
        id: "home",
        field: "hero.headline",
        value: "Remote value",
        expectedRevision: 1,
      },
    });
    expect(conflict.ok()).toBeTruthy();

    // Local edit collides (409) — the prompt appears with the edit preserved.
    await replaceText(page, headline, "Mine wins");
    const stale = await blurToSave(page, headline);
    expect(stale.status()).toBe(409);
    await expect(headline).toHaveText("Mine wins");

    // "Keep mine" re-saves against the refreshed revision and overwrites.
    await page.getByRole("button", { name: "Keep mine" }).click();
    await expect(page.getByText("Your version saved")).toBeVisible();

    const anonHtml = await fetchAnonymousHtml("/");
    expect(anonHtml).toContain("Mine wins");
    expect(anonHtml).not.toContain("Remote value");
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

  test("uploads the original image when canvas compression is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "createImageBitmap", {
        configurable: true,
        value: async () => ({ width: 2400, height: 1200, close() {} }),
      });
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: () => null,
      });
    });
    await loginAsEditor(page);
    await page.goto("/");

    const image = page.locator(HERO_IMAGE);
    const fileInput = page.locator(".cms-img-wrapper input[type='file']");
    await expect(fileInput).toBeAttached();

    const [upload, mutate] = await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/api/cms/upload")
          && response.request().method() === "POST",
      ),
      page.waitForResponse(isMutatePost),
      fileInput.setInputFiles(SAMPLE_PNG),
    ]);
    expect(upload.ok(), await upload.text()).toBeTruthy();
    expect(mutate.ok(), await mutate.text()).toBeTruthy();
    await expect(page.getByText("Image updated")).toBeVisible();
    await expect(image).toHaveAttribute("src", /^\/uploads\/.+\.png$/);
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
