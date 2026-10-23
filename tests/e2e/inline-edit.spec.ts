import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { test, expect } from "@playwright/test";
import {
  EDIT_PASSWORD,
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

/** Mirrors contentHash in runtime/stega-policy.ts. */
function contentHash(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

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
    // Automatic bindings carry a content hash: they bind the element holding the
    // whole value (the heading around per-word spans), and never a fragment.
    const statement = "Motion with meaning";
    const hashed = { k: "pages::home::hero.subtext", h: contentHash(statement) };
    const splitWords = `<span>Motion</span> <span>with</span> <span>${stegaTag("meaning", hashed)}</span>`;
    const fragment = stegaTag("meaning", hashed);
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
        `$1<p id="stega-valid">${valid}</p><p id="stega-invalid">${invalid}</p>` +
          `<h2 id="stega-split">${splitWords}</h2><p id="stega-fragment">Only ${fragment}</p>`,
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
    await expect(page.locator("#stega-split")).toHaveAttribute("data-caret", "pages::home::hero.subtext");
    await expect(page.locator("#stega-split span").first()).not.toHaveAttribute("data-caret", /.*/);
    await expect(page.locator("#stega-fragment")).toHaveText("Only meaning");
    await expect(page.locator("#stega-fragment")).not.toHaveAttribute("data-caret", /.*/);
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
    const rows = map.getByRole("button", { name: "Hero › Headline" });
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

  test("deleting a section can be undone", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const hero = page.locator('section[data-caret-section-id="hero"]');
    await expect(hero).toHaveClass(/cms-section-editable/);

    await hero.hover();
    await hero.getByText("More", { exact: true }).click();
    const deleted = page.waitForResponse(isMutatePost);
    await hero.getByRole("button", { name: "Delete", exact: true }).click();
    expect((await deleted).ok()).toBe(true);
    const toast = page.locator(".cms-toast", { hasText: "Section deleted" });
    await expect(toast).toBeVisible();

    const undone = page.waitForResponse(isMutatePost);
    await toast.getByRole("button", { name: "Undo" }).click();
    expect((await undone).ok()).toBe(true);
    await expect(page.getByText("Change undone")).toBeVisible();
    const stored = await (await page.request.get("/api/cms/entries?collection=pages&id=home")).json();
    expect(stored.entries[0].data.layout.sections.map((section: { id: string }) => section.id)).toEqual(["hero", "philosophy"]);
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
    await expect(page.locator(".cms-status-text")).toHaveText("Unsaved changes");

    // Blur fires the save. Assert the write actually hit the mutate endpoint.
    const mutate = await blurToSave(page, headline);
    expect(mutate.ok()).toBeTruthy();

    // The save-confirmation toast appears.
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.locator(".cms-status-text")).toHaveText("Changes are live");

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
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
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
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

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
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

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

  test("a stale tab's first save asks instead of overwriting a newer edit", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    // Another editor saves the same field after this page loaded, before this
    // tab has saved anything.
    const elsewhere = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "save_field", collection: "pages", id: "home", field: "hero.headline", value: "Saved in another tab", expectedRevision: 0 },
    });
    expect(elsewhere.ok()).toBeTruthy();

    await replaceText(page, headline, "Stale tab edit");
    const stale = await blurToSave(page, headline);
    expect(stale.status()).toBe(409);
    await expect(page.getByText("This content changed elsewhere while you were editing.")).toBeVisible();
    await expect(headline).toHaveText("Stale tab edit");
    expect(await fetchAnonymousHtml("/")).toContain("Saved in another tab");
  });

  test("a newer edit to another field of the entry doesn't interrupt the save", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    const elsewhere = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "save_field", collection: "pages", id: "home", field: "our_teaching_philosophy", value: "Heading from another tab", expectedRevision: 0 },
    });
    expect(elsewhere.ok()).toBeTruthy();

    await replaceText(page, headline, "Headline from this tab");
    await headline.evaluate((el) => (el as HTMLElement).blur());
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.getByText("This content changed elsewhere while you were editing.")).toHaveCount(0);

    const html = await fetchAnonymousHtml("/");
    expect(html).toContain("Headline from this tab");
    expect(html).toContain("Heading from another tab");
  });

  test("a failed save keeps the text on the page and Retry saves it", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await page.route("**/api/cms/mutate", (route) => route.fulfill({ status: 500, body: "{}" }));
    await replaceText(page, headline, "Kept after a failure");
    await headline.evaluate((el) => (el as HTMLElement).blur());

    await expect(page.getByText("Couldn't save your change. It's kept on the page.")).toBeVisible();
    await expect(headline).toHaveText("Kept after a failure");
    await expect(headline).toHaveClass(/cms-unsaved/);
    await expect(page.locator(".cms-status-text")).toHaveText("Unsaved changes");

    await page.unroute("**/api/cms/mutate");
    await page.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByText("Your change is saved")).toBeVisible();
    await expect(headline).not.toHaveClass(/cms-unsaved/);
    expect(await fetchAnonymousHtml("/")).toContain("Kept after a failure");
  });

  test("signing out with unsaved text on the page asks first", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await page.route("**/api/cms/mutate", (route) => route.fulfill({ status: 500, body: "{}" }));
    await replaceText(page, headline, "Not saved yet");
    await headline.evaluate((el) => (el as HTMLElement).blur());
    await expect(headline).toHaveClass(/cms-unsaved/);

    await page.getByRole("button", { name: "Sign out" }).click();
    const dialog = page.getByRole("dialog", { name: "Unsaved changes" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(headline).toHaveText("Not saved yet");
    await expect(page.locator(".cms-toolbar")).toBeVisible();
  });

  test("an edit made offline saves itself when the connection returns", async ({ page, context }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await context.setOffline(true);
    await replaceText(page, headline, "Written while offline");
    await headline.evaluate((el) => (el as HTMLElement).blur());
    await expect(page.getByText("You're offline. Your change is kept and saves when you reconnect.")).toBeVisible();
    await expect(headline).toHaveText("Written while offline");

    await context.setOffline(false);
    await expect(page.getByText("Your change is saved")).toBeVisible();
    expect(await fetchAnonymousHtml("/")).toContain("Written while offline");
  });

  test("an expired session asks to sign in again and then saves the kept edit", async ({ page, context }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await context.clearCookies();
    await replaceText(page, headline, "Saved after signing in again");
    await headline.evaluate((el) => (el as HTMLElement).blur());

    const dialog = page.getByRole("dialog", { name: "Sign in again" });
    await expect(dialog).toBeVisible();
    await expect(headline).toHaveText("Saved after signing in again");
    await expect(headline).toHaveClass(/cms-unsaved/);
    await expect(dialog.getByLabel("Password")).toBeFocused();

    await dialog.getByLabel("Password").fill("not-the-password");
    await dialog.getByRole("button", { name: "Sign in" }).click();
    await expect(dialog.getByText("That password isn't right.")).toBeVisible();

    await dialog.getByLabel("Password").fill(EDIT_PASSWORD);
    await dialog.getByRole("button", { name: "Sign in" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Your change is saved")).toBeVisible();
    await expect(headline).not.toHaveClass(/cms-unsaved/);
    expect(await fetchAnonymousHtml("/")).toContain("Saved after signing in again");
  });

  test("a field with inline formatting saves as rich text and reaches visitors", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const subtext = page.locator('p[data-caret="hero.subtext"]');
    await expect(subtext).toHaveClass(/cms-editable/);
    await expect(subtext).toHaveAttribute("data-caret-rich", "");

    await subtext.click();
    await page.keyboard.press("ControlOrMeta+ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.type(" Visitors see this.");
    await blurToSave(page, subtext);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    const html = await fetchAnonymousHtml("/");
    const visitorSubtext = html.match(/<p data-caret="hero\.subtext"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    expect(visitorSubtext).toContain("Visitors see this.");
    expect(visitorSubtext).toMatch(/<code[^>]*>data-caret<\/code>/);
  });

  test("an emptied field stays visible and clickable", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const heading = page.locator('h2[data-caret="pages::home::our_teaching_philosophy"]');
    await expect(heading).toHaveClass(/cms-editable/);
    await heading.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await blurToSave(page, heading);

    await page.reload();
    await expect(heading).toHaveClass(/cms-editable/);
    await expect(heading).toBeEmpty();
    const box = await heading.boundingBox();
    expect(box!.width).toBeGreaterThan(20);
    expect(box!.height).toBeGreaterThan(10);
    expect(await heading.evaluate((el) => getComputedStyle(el, "::before").content)).toBe('"Add text"');
    await heading.click();
    await expect(heading).toBeFocused();
  });

  test("typing saves on its own after a pause, without leaving the field", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await replaceText(page, headline, "Saved while typing");
    const autosave = await page.waitForResponse(isMutatePost);
    expect(autosave.ok()).toBe(true);
    await expect(headline).toBeFocused();
    expect(await fetchAnonymousHtml("/")).toContain("Saved while typing");
  });

  test("Undo puts the previous text back, and Cmd+Z and Cmd+Shift+Z undo and redo", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await replaceText(page, headline, "A headline to undo");
    await blurToSave(page, headline);
    const saved = page.locator(".cms-toast", { hasText: "Saved" });
    await expect(saved).toBeVisible();
    const undo = page.waitForResponse(isMutatePost);
    await saved.getByRole("button", { name: "Undo" }).click();
    expect((await undo).ok()).toBe(true);
    await expect(headline).toHaveText(TEMPLATE_HEADLINE);
    await expect(page.getByText("Change undone")).toBeVisible();
    expect(await fetchAnonymousHtml("/")).not.toContain("A headline to undo");

    const redo = page.waitForResponse(isMutatePost);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    expect((await redo).ok()).toBe(true);
    await expect(headline).toHaveText("A headline to undo");

    const undoAgain = page.waitForResponse(isMutatePost);
    await page.keyboard.press("ControlOrMeta+z");
    expect((await undoAgain).ok()).toBe(true);
    await expect(headline).toHaveText(TEMPLATE_HEADLINE);
  });

  test("an edit that autosaved several times is one undo step", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await replaceText(page, headline, "First draft");
    await page.waitForResponse(isMutatePost);
    await page.keyboard.type(" and more");
    await page.waitForResponse(isMutatePost);
    await headline.evaluate((el) => (el as HTMLElement).blur());
    await expect(page.locator(".cms-toast", { hasText: "Saved" })).toBeVisible();

    const undo = page.waitForResponse(isMutatePost);
    await page.keyboard.press("ControlOrMeta+z");
    expect((await undo).ok()).toBe(true);
    await expect(headline).toHaveText(TEMPLATE_HEADLINE);
    expect(await fetchAnonymousHtml("/")).toContain(TEMPLATE_HEADLINE);
  });

  test("Escape after an autosave takes the whole edit back", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");
    const headline = page.locator(HEADLINE);
    await expect(headline).toHaveClass(/cms-editable/);

    await replaceText(page, headline, "Not wanted after all");
    await page.waitForResponse(isMutatePost);
    const revert = page.waitForResponse(isMutatePost);
    await page.keyboard.press("Escape");
    expect((await revert).ok()).toBe(true);
    await expect(headline).toHaveText(TEMPLATE_HEADLINE);
    expect(await fetchAnonymousHtml("/")).not.toContain("Not wanted after all");
  });

  test("swapping a hero image uploads, persists, and serves the new src", async ({ page }) => {
    await loginAsEditor(page);
    await page.goto("/");

    const image = page.locator(HERO_IMAGE);
    await expect(image).toHaveAttribute("src", "/initial.png");

    // Hovering a bound <img> places the shared Replace control over it.
    await expect(image).toHaveAttribute("data-caret-img-mounted", "true");
    await image.hover({ force: true });
    await expect(page.locator(".cms-img-overlay")).toBeVisible();
    const fileInput = page.locator(".cms-img-input");
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
    await expect(image).toHaveAttribute("data-caret-img-mounted", "true");
    await image.hover({ force: true });
    const fileInput = page.locator(".cms-img-input");
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

    const status = page.locator(".cms-status-text");
    const statusBefore = await status.textContent();
    await replaceText(page, headline, "This should be discarded");
    await expect(status).toHaveText("Unsaved changes");
    await page.keyboard.press("Escape");
    await page.locator("body").click();
    // Undoing the edit restores the status shown before it.
    await expect(status).toHaveText(statusBefore ?? "");

    // Live DOM reverts to the template value…
    await expect(headline).toHaveText(TEMPLATE_HEADLINE);

    // …and nothing was persisted: anonymous visitor still sees the template.
    const anonHtml = await fetchAnonymousHtml("/");
    expect(anonHtml).toContain(TEMPLATE_HEADLINE);
    expect(anonHtml).not.toContain("This should be discarded");
  });
});
