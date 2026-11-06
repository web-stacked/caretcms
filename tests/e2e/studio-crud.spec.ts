import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { devices, expect, test, type Locator } from "@playwright/test";
import {
  EDIT_PASSWORD,
  STUDIO_PANEL,
  expectStudioURL,
  loginAsEditor,
  openStudio,
  reloadStudio,
  resetCmsStorage,
  studioFrame,
} from "./helpers";

const fixtureImage = resolve(process.cwd(), "tests/e2e/fixtures/sample.png");

test.beforeEach(async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  const seed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "studio-fixture",
      id: "seed-entry",
      data: {
        title: "Seed entry",
        summary: "",
        website: "",
        published: false,
        details: [],
        images: [{
          id: "seed-image",
          src: "/initial.png",
          title: "Initial image",
          alt: "Initial image",
          width: 1600,
          height: 1200,
        }],
      },
    },
  });
  expect(seed.ok()).toBe(true);
});

test("Studio CRUD uses schema-aware rows, image previews, and clear save state", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture");

  await expect(studio.locator(".entry-thumb img")).toHaveAttribute("src", "/initial.png");
  await expect(studio.locator(".entry-card-status")).toHaveText("Hidden");
  await expect(studio.locator(".entry-card").first()).toHaveAccessibleDescription(/Hidden$/);
  await expect(studio.getByRole("navigation", { name: "Collections" }).getByRole("link", { name: "Studio Fixture" }))
    .toHaveAttribute("aria-current", "page");

  const createButton = studio.locator("#btn-new");
  await createButton.click();
  const createDialog = studio.getByRole("dialog", { name: "New entry" });
  const createClose = studio.locator("#btn-create-close");
  const createTitle = studio.locator("#create-title-input");
  const createId = studio.locator("#create-id-input");
  await expect(createDialog).toBeVisible();
  await expect(createTitle).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(createClose).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(studio.locator("#btn-create-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(createClose).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(createTitle).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toBeHidden();
  await expect(createButton).toBeFocused();

  await createButton.click();
  await createTitle.fill("Draft title");
  // The address follows the name and is only edited on request.
  await expect(studio.locator("#create-address-preview")).toHaveText("Web address: draft-title");
  await expect(createId).toBeHidden();
  await studio.locator("#create-address summary").click();
  await createId.fill("first-studio-entry");
  await Promise.all([
    expectStudioURL(page, /\/admin\/cms\/studio-fixture\/first-studio-entry\?new=1&title=Draft%20title$/),
    studio.locator("#btn-create-confirm").click(),
  ]);

  // No instructions open; the status and the Create button say what's next.
  await expect(studio.locator("#editor-guide")).not.toHaveAttribute("open", "");
  await expect(studio.locator('[name="title"]')).toHaveValue("Draft title");
  const notStored = await page.request.get("/api/cms/entries?collection=studio-fixture&id=first-studio-entry");
  expect((await notStored.json()).entries).toHaveLength(0);
  await expect(studio.locator("#fields")).not.toContainText("(optional)");
  await expect(studio.getByText("Fields marked * are required.")).toBeVisible();
  await expect(studio.locator(".caret-field-section-title")).toHaveText(["Content", "Repeatable content"]);
  await expect(studio.getByText("Use bold, italic, or links to add emphasis.")).toBeVisible();
  await expect(studio.locator('[name="title"]')).toHaveAttribute("aria-required", "true");
  await expect(studio.locator('[name="summary"]')).toHaveAttribute("aria-describedby", "caret-field-summary-help");
  await expect(studio.locator("#status-msg")).toHaveText("Not created yet");
  await expect(studio.locator("#btn-save")).toHaveText("Create");
  // Named as typed, and nothing to look back on or delete until it exists.
  await expect(studio.locator("h1")).toHaveText("Draft title");
  await expect(studio.locator("#btn-history")).toBeHidden();
  await expect(studio.locator("#entry-more")).toBeHidden();
  await expect(studio.locator("#save-target")).toHaveText("Saving live");
  await expect(studio.locator("#visibility-status")).toHaveText("Hidden");
  // Over the site, the preview opens the page behind the Studio, not a new tab.
  await expect(studio.locator("#btn-preview")).not.toHaveAttribute("target");
  await expect(studio.locator(".editor-action-bar")).toHaveCSS("position", "sticky");
  await studio.locator('[name="title"]').fill("First studio entry");
  await expect(studio.locator("#status-msg")).toHaveText("Not created yet");
  await expect(studio.locator(".studio-breadcrumb-current").last()).toHaveText("First studio entry");
  await studio.locator('[name="published"]').check();
  await expect(studio.locator("#visibility-status")).toHaveText("Public");

  await studio.getByRole("button", { name: "+ Add detail" }).click();
  await expect(studio.locator(".caret-object-array-item").first()).toHaveClass(/is-expanded/);
  await studio.locator('[name="details.0.label"]').fill("Medium");
  await studio.locator('[name="details.0.value"]').fill("Mixed media");
  await studio.getByRole("button", { name: "+ Add detail" }).click();
  await expect(studio.locator(".caret-object-array-item").first().locator(".caret-object-array-fields")).toBeHidden();
  await studio.locator('[name="details.1.label"]').fill("Location");
  await studio.locator('[name="details.1.value"]').fill("Montréal");
  const dragData = await (await studioFrame(page)).evaluateHandle(() => new DataTransfer());
  await studio.locator(".caret-object-array-drag").nth(0).dispatchEvent("dragstart", { dataTransfer: dragData });
  await studio.locator(".caret-object-array-item").nth(1).dispatchEvent("dragover", { dataTransfer: dragData });
  await studio.locator(".caret-object-array-item").nth(1).dispatchEvent("drop", { dataTransfer: dragData });
  await expect(studio.locator('[name="details.0.label"]')).toHaveValue("Location");
  await studio.getByRole("button", { name: "Move down Location" }).click();
  await expect(studio.locator('[name="details.0.label"]')).toHaveValue("Medium");

  await studio.getByRole("button", { name: "+ Add image" }).click();
  await expect(studio.locator('[name="images.0.id"]')).not.toHaveValue("");
  await expect(studio.locator('[name="images.0.width"]')).toHaveValue("1600");
  await expect(studio.locator('[name="images.0.height"]')).toHaveValue("1200");
  await expect(studio.locator('[data-field-path="images.0.alt"]')).toBeVisible();
  await expect(studio.locator('[data-field-path="images.0.width"]')).toBeHidden();

  const unlabeledControls = await studio.locator("#fields input, #fields textarea, #fields select").evaluateAll((controls) =>
    controls.filter((control) => {
      const element = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      return element.labels?.length === 0
        && !element.getAttribute("aria-label")
        && !element.getAttribute("aria-labelledby");
    }).map((control) => ({
      name: control.getAttribute("name"),
      type: control.getAttribute("type"),
    })),
  );
  expect(unlabeledControls).toEqual([]);

  await studio.locator('[data-field-path="images"] .caret-object-array-toggle').click();
  await expect(studio.locator('[data-field-path="images.0.src"]')).toBeHidden();
  await page.evaluate(() => {
    const channel = new BroadcastChannel("caretcms:content");
    channel.postMessage({
      type: "cms:field-selected",
      collection: "studio-fixture",
      id: "first-studio-entry",
      field: "images.0.src",
      source: "inline",
    });
    setTimeout(() => channel.close(), 0);
  });
  await expect(studio.locator('[data-field-path="images.0.src"]')).toHaveClass(/caret-field-selected/);
  await expect(studio.locator('[data-field-path="images.0.src"]')).toBeVisible();

  const chooserPromise = page.waitForEvent("filechooser");
  await studio.getByRole("button", { name: "+ Choose an image" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixtureImage);

  await expect(studio.locator(".caret-single-image-preview img")).toBeVisible();
  // The new upload shows as an image, not a broken one, even while the dev
  // server is still discovering the file.
  await expect.poll(() => studio.locator(".caret-single-image-preview img")
    .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(studio.locator('[name="images.0.src"]')).not.toHaveValue("");
  await expect(studio.locator('[name="images.0.title"]')).toHaveValue("Sample");
  // Alt text is a description, not the file name: left empty and focused.
  await expect(studio.locator('[name="images.0.alt"]')).toHaveValue("");
  await expect(studio.locator('[name="images.0.alt"]')).toBeFocused();
  await expect(studio.locator('input[type="file"]')).toHaveAttribute("aria-label", "Upload or replace image");
  await expect(studio.getByRole("button", { name: "Replace image" })).toHaveCount(1);
  await expect(studio.getByLabel("Image URL")).toBeHidden();
  await studio.getByText("Use image URL").click();
  await expect(studio.getByLabel("Image URL")).toBeVisible();

  await studio.getByText("Technical details").click();
  await studio.locator('[name="images.0.width"]').fill("0");
  await studio.getByText("Technical details").click();
  await expect(studio.locator('[name="images.0.width"]')).toBeHidden();
  const rejectedSave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  // Creating a hidden entry changes nothing visitors see, so there's no live-save prompt.
  await studio.locator("#btn-save").click();
  expect((await rejectedSave).status()).toBe(400);
  await expect(studio.locator('[name="images.0.width"]')).toBeVisible();
  await expect(studio.locator('[name="images.0.width"]')).toBeFocused();
  await expect(studio.locator('[name="images.0.width"]')).toHaveAttribute("aria-invalid", "true");
  await expect(studio.locator('[data-field-path="images.0.width"] .studio-error-text')).toContainText("at least 1");
  await studio.locator('[name="images.0.width"]').fill("1600");

  await studio.locator(".studio-main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(studio.locator("#btn-save")).toBeInViewport();

  await expect(page).toHaveURL("/");
  const createSave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-save").click();
  expect((await createSave).ok()).toBe(true);
  await expect(studio.locator("#status-msg")).toHaveText("All changes live");
  // The site page behind the Studio offers to refresh for the new entry
  // instead of reloading under the Studio; refreshing brings the Studio back
  // open on the entry.
  await expect(page.getByText("Saved. Refresh to see the layout change.")).toBeVisible();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: "Refresh" }).click(),
  ]);
  await expect(page).toHaveURL("/");
  await expect(page.locator(`${STUDIO_PANEL}.open.expanded`)).toBeVisible();
  await expect(studio.locator("#status-msg")).toHaveText("All changes live");

  const created = await page.request.get("/api/cms/entries?collection=studio-fixture&id=first-studio-entry");
  const createdBody = await created.json();
  expect(createdBody.entries).toHaveLength(1);
  expect(createdBody.entries[0].data.details).toEqual([
    { label: "Medium", value: "Mixed media" },
    { label: "Location", value: "Montréal" },
  ]);
  expect(typeof createdBody.entries[0].data.images[0].width).toBe("number");
  const firstRevision = createdBody.entries[0].revision;

  await expectStudioURL(page, /\/admin\/cms\/studio-fixture\/first-studio-entry$/);
  await expect(studio.locator("#entry-more")).toBeVisible();
  // Nothing to save: changes save on their own, so there's no Save button.
  await expect(studio.locator("#btn-save")).toBeHidden();
  await studio.locator('[name="summary"]').fill("Updated summary");
  await expect(studio.locator("#btn-save")).toHaveText("Save now");
  const updateSave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-save").click();
  expect((await updateSave).ok()).toBe(true);

  const updated = await page.request.get("/api/cms/entries?collection=studio-fixture&id=first-studio-entry");
  const updatedBody = await updated.json();
  expect(updatedBody.entries[0].data.summary).toBe("Updated summary");
  expect(updatedBody.entries[0].revision).toBeGreaterThan(firstRevision);

  // Delete hands the entry to the list, which sends the deletion after its
  // Undo window.
  await studio.locator("#entry-more > summary").click();
  const deleteResponse = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  { timeout: 15_000 });
  await Promise.all([
    expectStudioURL(page, /\/admin\/cms\/studio-fixture$/),
    studio.locator("#btn-delete").click(),
  ]);
  await expect(studio.locator("#delete-notice")).toContainText("Deleted “First studio entry”.");
  expect((await deleteResponse).ok()).toBe(true);

  const deleted = await page.request.get("/api/cms/entries?collection=studio-fixture&id=first-studio-entry");
  expect((await deleted.json()).entries).toHaveLength(0);
});

test("formatted fields keep supported markup while HTML editing stays secondary", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");

  const editor = studio.locator('[name="summary"]');
  const saveButton = studio.locator("#btn-save");
  await expect(studio.locator("#status-msg")).toHaveText("All changes live");
  await expect(saveButton).toBeHidden();
  await studio.getByRole("button", { name: "Edit HTML" }).click();
  await studio.getByRole("button", { name: "Show formatted" }).click();
  await expect(studio.locator("#status-msg")).toHaveText("All changes live");
  await expect(saveButton).toBeHidden();

  await editor.fill("Make this clear");
  await editor.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error("Missing rich field text");
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 9);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await studio.getByRole("button", { name: "Bold" }).click();
  await expect(editor.locator("b, strong")).toHaveText("this");

  await studio.getByRole("button", { name: "Edit HTML" }).click();
  const source = studio.locator(".caret-rich-source");
  await expect(source).toBeVisible();
  await source.fill('<strong>Bold opening</strong> with a <a href="/work">work link</a><script>bad()</script>');
  await studio.getByRole("button", { name: "Show formatted" }).click();
  await expect(editor.locator("strong")).toHaveText("Bold opening");
  await expect(editor.locator('a[href="/work"]')).toHaveText("work link");
  await expect(editor.locator("script")).toHaveCount(0);

  const saved = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-save").click();
  expect((await saved).ok()).toBe(true);
  await reloadStudio(page);
  await expect(studio.locator('[name="summary"] strong')).toHaveText("Bold opening");
  await expect(studio.locator('[name="summary"] a[href="/work"]')).toHaveText("work link");
});

test("embedded Studio Escape closes local overlays before the Studio drawer", async ({ page }) => {
  // Arrange needs at least two entries.
  const second = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id: "second-entry", data: { title: "Second entry", summary: "", website: "", published: false, details: [], images: [] } },
  });
  expect(second.ok(), await second.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Studio", exact: true }).click();

  const panel = page.getByRole("dialog", { name: "Content Studio" });
  const iframe = page.locator('iframe[title="Content Studio"]');
  await iframe.evaluate((element) => {
    (element as HTMLIFrameElement).src = "/admin/cms/studio-fixture/seed-entry";
  });

  const studio = page.frameLocator('iframe[title="Content Studio"]');
  const deleteButton = studio.locator("#btn-delete");
  await studio.locator("#entry-more > summary").click();
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();

  // Deleting inside the drawer moves it to the list, where Undo keeps the entry.
  await expect(studio.locator("#delete-notice")).toContainText("Deleted");
  await studio.getByRole("button", { name: "Undo" }).click();
  await expect(studio.locator("#delete-notice")).toContainText("is back");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "Studio", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await iframe.evaluate((element) => {
    (element as HTMLIFrameElement).src = "/admin/cms/studio-fixture/seed-entry";
  });
  await expect(studio.locator("#editor")).toBeVisible();

  const historyButton = studio.locator("#btn-history");
  await historyButton.click();
  const historyPanel = studio.getByRole("region", { name: "Version history" });
  const historyClose = studio.locator("#btn-history-close");
  await expect(historyPanel).toBeVisible();
  await expect(historyClose).toBeFocused();
  await historyClose.press("Escape");

  await expect(historyPanel).toBeHidden();
  await expect(historyButton).toBeFocused();
  await expect(panel).toBeVisible();

  await iframe.evaluate((element) => {
    (element as HTMLIFrameElement).src = "/admin/cms/studio-fixture";
  });
  const createButton = studio.locator("#btn-new");
  await expect(createButton).toBeVisible();
  await createButton.click();
  const createDialog = studio.getByRole("dialog", { name: "New entry" });
  const createTitle = studio.locator("#create-title-input");
  await expect(createDialog).toBeVisible();
  await expect(createTitle).toBeFocused();
  await createTitle.press("Escape");

  await expect(createDialog).toBeHidden();
  await expect(createButton).toBeFocused();
  await expect(panel).toBeVisible();

  const reorderButton = studio.locator("#btn-reorder");
  await reorderButton.click();
  const reorderRegion = studio.getByRole("region", { name: "Arrange entries" });
  const reorderCancel = studio.locator("#btn-reorder-cancel");
  await expect(reorderRegion).toBeVisible();
  // Focus starts on the first move control; Escape leaves Arrange from there.
  const firstMove = studio.locator(".reorder-move:not([disabled])").first();
  await expect(firstMove).toBeFocused();
  await expect(reorderCancel).toBeVisible();
  await firstMove.press("Escape");

  await expect(reorderRegion).toBeHidden();
  await expect(reorderButton).toBeFocused();
  await expect(panel).toBeVisible();
});

test("Studio applies form edits on top of a conflicting save without reverting its other fields", async ({ page }) => {
  const id = "revision-conflict-entry";
  const initial = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "studio-fixture",
      id,
      data: { title: "Initial", summary: "", website: "", published: false, details: [], images: [] },
    },
  });
  expect(initial.ok()).toBe(true);
  const initialRevision = (await initial.json()).revision;

  const studio = await openStudio(page, `/admin/cms/studio-fixture/${id}`);
  await studio.locator('[name="title"]').fill("Local form edit");
  const external = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "studio-fixture",
      id,
      expectedRevision: initialRevision,
      data: { title: "External edit", summary: "", website: "https://elsewhere.example", published: false, details: [], images: [] },
    },
  });
  expect(external.ok()).toBe(true);

  const conflict = page.waitForResponse(response =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-save").click();
  expect((await conflict).status()).toBe(409);
  const conflictDialog = studio.getByRole("dialog", { name: "Someone else saved this entry" });
  // Both versions of a field both people changed, side by side.
  const titleRow = conflictDialog.locator("li", { hasText: "Title" });
  await expect(titleRow).toContainText("Saved by someone else:External edit");
  await expect(titleRow).toContainText("Yours:Local form edit");
  // A field only they changed shows their value and that it's kept.
  const websiteRow = conflictDialog.locator("li", { hasText: "Website" });
  await expect(websiteRow).toContainText("https://elsewhere.example");
  await expect(websiteRow).toContainText("kept either way");
  await expect(studio.locator("#status-msg")).toHaveText("Someone else saved this entry. Choose which version to keep.");
  // Cancel decides nothing: saving again asks again instead of overwriting theirs.
  await conflictDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(conflictDialog).toBeHidden();
  const askedAgain = page.waitForResponse(response =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-save").click();
  expect((await askedAgain).status()).toBe(409);
  await expect(conflictDialog).toBeVisible();
  const untouched = await page.request.get(`/api/cms/entries?collection=studio-fixture&id=${id}`);
  expect((await untouched.json()).entries[0].data).toMatchObject({ title: "External edit", website: "https://elsewhere.example" });
  await conflictDialog.getByRole("button", { name: "Keep my edits" }).click();
  await expect(studio.locator("#status-msg")).toHaveText("Your edits are on the latest version — Save to apply them");
  await expect(studio.locator('[name="title"]')).toHaveValue("Local form edit");
  await expect(studio.locator('[name="website"]')).toHaveValue("https://elsewhere.example");

  const retry = page.waitForResponse(response =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-save").click();
  expect((await retry).ok()).toBe(true);
  await expect(studio.locator("#status-msg")).toHaveText("All changes live");

  const stored = await page.request.get(`/api/cms/entries?collection=studio-fixture&id=${id}`);
  const current = await stored.json();
  expect(current.entries[0].data).toMatchObject({ title: "Local form edit", website: "https://elsewhere.example" });
  await studio.locator('[name="title"]').fill("Another local edit");
  const latestWrite = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "studio-fixture",
      id,
      expectedRevision: current.entries[0].revision,
      data: { title: "Latest remote edit", summary: "", website: "", published: false, details: [], images: [] },
    },
  });
  expect(latestWrite.ok()).toBe(true);
  const loadConflict = page.waitForResponse(response =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST");
  await studio.locator("#btn-save").click();
  expect((await loadConflict).status()).toBe(409);
  await studio.getByRole("dialog", { name: "Someone else saved this entry" }).getByRole("button", { name: "Load latest" }).click();
  await expect(studio.locator('[name="title"]')).toHaveValue("Latest remote edit");
  await expect(studio.locator("#status-msg")).toHaveText("Loaded latest changes");
  const cleanup = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "delete_entry", collection: "studio-fixture", id },
  });
  expect(cleanup.ok()).toBe(true);
});

test("Studio routes singleton collections directly and hides impossible actions", async ({ page }) => {
  const seed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "site-settings-fixture",
      id: "global",
      data: { title: "" },
    },
  });
  expect(seed.ok()).toBe(true);

  const studio = await openStudio(page, "/admin/cms");
  const card = studio.getByRole("main").getByRole("link", { name: /Site Settings/ });
  await expect(card).toHaveAttribute("href", "/admin/cms/site-settings-fixture/global");
  await card.click();
  await expectStudioURL(page, /\/admin\/cms\/site-settings-fixture\/global$/);
  await expect(studio.locator("#entry-title")).toHaveText("Site Settings");
  await expect(studio.locator("#btn-delete")).toHaveCount(0);
  // Nothing to preview or delete: no More actions menu with nothing in it.
  await expect(studio.locator("#entry-more")).toHaveCount(0);

  await openStudio(page, "/admin/cms/site-settings-fixture");
  await expectStudioURL(page, /\/admin\/cms\/site-settings-fixture\/global$/);
});

test("collection search has a persistent associated label", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture");
  await expect(studio.getByLabel("Search", { exact: true })).toHaveAttribute("name", "search");
});

test("on a phone the Studio fills the screen and title-first creation fits it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const studio = await openStudio(page, "/admin/cms/studio-fixture");
  // The drawer is the whole screen, so the Studio inside it is phone-width.
  const panel = await page.locator(STUDIO_PANEL).boundingBox();
  expect(panel).toMatchObject({ x: 0, width: 390 });

  for (const control of await studio.locator(".collection-actions > input:visible, .collection-actions > button:visible").all()) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  }

  await studio.locator("#btn-new").click();
  const title = studio.locator("#create-title-input");
  await expect(title).toBeFocused();
  await title.fill("A clear title");
  await expect(studio.locator("#create-id-input")).toHaveValue("a-clear-title");
  const dialogBounds = await studio.locator(".modal-card").boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect((dialogBounds?.x ?? 0) + (dialogBounds?.width ?? 0)).toBeLessThanOrEqual(390);
});

test("an expanded Studio too narrow for its sidebar puts collections behind Menu", async ({ page }) => {
  // Two thirds of a 1000px window: wide enough for the Studio's own header,
  // too narrow for its sidebar.
  await page.setViewportSize({ width: 1000, height: 800 });
  const studio = await openStudio(page, "/admin/cms/studio-fixture");

  const menu = studio.getByRole("button", { name: "Menu" });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(studio.getByRole("navigation", { name: "Collections" }).getByRole("link", { name: "Studio Fixture" })).toBeInViewport();
  // Escape closes the menu, not the Studio around it.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await expect(page.locator(`${STUDIO_PANEL}.open`)).toBeVisible();
});

test("entry More actions stays within narrow Studio viewports", async ({ page }) => {
  const expectMenuInsideViewport = async (menu: Locator) => {
    const bounds = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
  };

  await page.setViewportSize({ width: 390, height: 844 });
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  await studio.locator("#entry-more > summary").click();
  await expectMenuInsideViewport(studio.locator(".editor-more-menu"));
  await studio.locator("#entry-more > summary").click();
  await expect(studio.locator("#entry-more")).not.toHaveAttribute("open", "");

  // The 380px drawer beside a desktop page.
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByRole("button", { name: "Shrink the Studio to a drawer" }).click();
  await expect(page.locator(STUDIO_PANEL)).not.toHaveClass(/expanded/);
  await expect.poll(async () => (await page.locator(STUDIO_PANEL).boundingBox())?.width).toBe(380);
  await expectStudioURL(page, "/admin/cms/studio-fixture/seed-entry");
  await studio.locator("#entry-more > summary").click();
  await expectMenuInsideViewport(studio.locator(".editor-more-menu"));
});

test("Studio history restores the previous entry and keeps the replaced state undoable", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  const title = studio.locator('[name="title"]');
  await expect(title).toHaveValue("Seed entry");

  await title.fill("Changed after the snapshot");
  const save = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-save").click();
  expect((await save).ok()).toBeTruthy();

  // History sits beside More actions, not inside it.
  const historyButton = studio.locator("#btn-history");
  await expect(historyButton).toBeVisible();
  await expect(historyButton).toHaveAttribute("aria-controls", "history-panel");
  await expect(historyButton).toHaveAttribute("aria-expanded", "false");
  await historyButton.click();
  const historyPanel = studio.getByRole("region", { name: "Version history" });
  await expect(historyPanel).toBeVisible();
  await expect(historyButton).toHaveAttribute("aria-expanded", "true");
  await expect(studio.locator("#btn-history-close")).toBeFocused();
  await studio.locator("#btn-history-close").press("Escape");
  await expect(historyPanel).toBeHidden();
  await expect(historyButton).toHaveAttribute("aria-expanded", "false");
  await expect(historyButton).toBeFocused();

  await historyButton.click();
  const historyRows = studio.locator(".caret-history-row");
  await expect(historyRows).toHaveCount(1);
  await expect(historyRows.first().locator(".caret-history-action")).toHaveText("Saved");
  await expect(historyRows.first().locator(".caret-history-time")).toHaveText(/now|seconds? ago/);
  // The row says what that save changed: the one field, before and after.
  const changes = historyRows.first().locator(".caret-history-diff li");
  await expect(changes).toHaveCount(1);
  await expect(changes.first().locator(".caret-history-field")).toHaveText("Title");
  await expect(changes.first().locator("del")).toHaveText("Seed entry");
  await expect(changes.first().locator("ins")).toHaveText("Changed after the snapshot");

  const restore = page.waitForResponse((response) =>
    response.url().includes("/api/cms/history") && response.request().method() === "POST",
  );
  await historyRows.first().getByRole("button", { name: "Restore" }).click();
  await studio.getByRole("dialog", { name: "Go back to before this change?" }).getByRole("button", { name: "Restore" }).click();
  expect((await restore).ok()).toBeTruthy();

  await expect(title).toHaveValue("Seed entry");
  await expect(studio.locator("#status-msg")).toHaveText("Restored");

  await historyButton.click();
  await expect(studio.locator(".caret-history-row")).toHaveCount(2);
  await expect(studio.locator(".caret-history-row").first().locator(".caret-history-action"))
    .toHaveText("Restored");

  const history = await page.request.get(
    "/api/cms/history?collection=studio-fixture&id=seed-entry",
  );
  const historyBody = await history.json() as {
    history: Array<{ action: string; data: { title?: string } }>;
  };
  expect(historyBody.history[0]).toMatchObject({
    action: "restore",
    data: { title: "Changed after the snapshot" },
  });
});

test("collection reordering is keyboard operable and restores mode focus", async ({ page }) => {
  for (const [id, title, order] of [
    ["second-entry", "Second entry", 1],
    ["third-entry", "Third entry", 2],
  ] as const) {
    const response = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: {
        type: "put_entry",
        collection: "studio-fixture",
        id,
        data: { title, order, summary: "", website: "", published: false, details: [], images: [] },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }

  const studio = await openStudio(page, "/admin/cms/studio-fixture");
  const reorderButton = studio.locator("#btn-reorder");
  await expect(reorderButton).toHaveAttribute("aria-controls", "reorder-container");
  await expect(reorderButton).toHaveAttribute("aria-expanded", "false");
  await reorderButton.click();

  const reorderRegion = studio.getByRole("region", { name: "Arrange entries" });
  // Seed entry has no order yet, so it sorts last, as on the site.
  const moveSecondDown = studio.getByRole("button", { name: "Move down Second entry" });
  await expect(reorderRegion).toBeVisible();
  await expect(reorderButton).toHaveAttribute("aria-expanded", "true");
  await expect(moveSecondDown).toBeFocused();
  await moveSecondDown.click();
  await expect(studio.locator(".reorder-label")).toHaveText([
    "Third entry",
    "Second entry",
    "Seed entry",
  ]);
  const dragData = await (await studioFrame(page)).evaluateHandle(() => new DataTransfer());
  await studio.locator(".reorder-item").nth(2).dispatchEvent("dragstart", { dataTransfer: dragData });
  await studio.locator(".reorder-item").nth(0).dispatchEvent("dragover", { dataTransfer: dragData });
  await studio.locator(".reorder-item").nth(0).dispatchEvent("drop", { dataTransfer: dragData });
  await expect(studio.locator(".reorder-label")).toHaveText([
    "Seed entry",
    "Third entry",
    "Second entry",
  ]);

  await page.keyboard.press("Escape");
  await expect(reorderRegion).toBeHidden();
  await expect(reorderButton).toHaveAttribute("aria-expanded", "false");
  await expect(reorderButton).toBeFocused();

  await reorderButton.click();
  await studio.getByRole("button", { name: "Move down Second entry" }).click();
  const saveResponse = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-reorder-save").click();
  expect((await saveResponse).ok()).toBe(true);
  await expect(reorderButton).toBeFocused();

  const stored = await (await page.request.get(
    "/api/cms/entries?collection=studio-fixture&pageSize=24",
  )).json() as { entries: Array<{ id: string; data: { order?: number } }> };
  expect(Object.fromEntries(stored.entries.map((entry) => [entry.id, entry.data.order])))
    .toMatchObject({ "third-entry": 0, "second-entry": 1, "seed-entry": 2 });
  // The grid shows the saved arrangement, as the site does.
  await expect(studio.locator(".entry-card-title")).toHaveText(["Third entry", "Second entry", "Seed entry"]);

  const reorderOnlyRoot = resolve(
    process.cwd(),
    "examples/starter/.caret/data/reorder-only-fixture",
  );
  mkdirSync(reorderOnlyRoot, { recursive: true });
  for (const [id, title, order] of [
    ["locked-a", "Locked A", 0],
    ["locked-b", "Locked B", 1],
  ] as const) {
    writeFileSync(resolve(reorderOnlyRoot, `${id}.json`), JSON.stringify({ title, order }));
  }
  await openStudio(page, "/admin/cms/reorder-only-fixture");
  await expect(studio.locator("#btn-new")).toHaveCount(0);
  await studio.locator("#btn-reorder").click();
  await expect(studio.getByRole("region", { name: "Arrange entries" })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Move down Locked A" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(studio.locator("#btn-reorder")).toBeFocused();
});

test("registered collections remain available before their first entry exists", async ({ page }) => {
  resetCmsStorage();

  const studio = await openStudio(page, "/admin/cms");
  const fixtureCard = studio.getByRole("main").getByRole("link", { name: /Studio Fixture/ });
  await expect(fixtureCard).toContainText("0 entries");
  await fixtureCard.click();
  await expectStudioURL(page, /\/admin\/cms\/studio-fixture$/);
  await expect(studio.locator("#entry-count")).toHaveText("0 entries");
  await expect(studio.locator("#btn-new")).toBeVisible();

  await openStudio(page, "/admin/cms");
  const singletonCard = studio.getByRole("main").getByRole("link", { name: /Site Settings/ });
  await expect(singletonCard).toHaveAttribute(
    "href",
    "/admin/cms/site-settings-fixture/global",
  );
  await singletonCard.click();
  await expectStudioURL(page, /\/admin\/cms\/site-settings-fixture\/global$/);
  await expect(studio.getByRole("textbox", { name: "Site title" })).toHaveValue("Example site");
  await expect(studio.locator("#btn-delete")).toHaveCount(0);
});

test("collection pagination reaches every entry and title search crosses pages", async ({ page }) => {
  for (let i = 1; i <= 30; i++) {
    const response = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "put_entry", collection: "studio-fixture", id: `post-${String(i).padStart(2, "0")}`, data: { title: i === 30 ? "Distant lighthouse" : `Post ${i}`, summary: "", website: "", published: false, details: [], images: [] } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const studio = await openStudio(page, "/admin/cms");
  await expect(studio.getByRole("main").getByRole("link", { name: /Studio Fixture/ }))
    .toContainText("31 entries");

  await openStudio(page, "/admin/cms/studio-fixture");
  await expect(studio.locator("#entries-grid a")).toHaveCount(24);
  await expect(studio.locator("#page-range")).toContainText("31");
  await expect(studio.locator("#btn-reorder")).toBeHidden();

  await studio.locator("#btn-new").click();
  await studio.locator("#create-title-input").fill("Duplicate post");
  await studio.locator("#create-address summary").click();
  await studio.locator("#create-id-input").fill("post-30");
  await expect(studio.locator("#btn-create-confirm")).toBeEnabled();
  const duplicateLookup = page.waitForResponse((response) =>
    response.url().includes("/api/cms/entries?collection=studio-fixture&id=post-30"),
  );
  await studio.locator("#btn-create-confirm").click();
  expect((await duplicateLookup).ok()).toBe(true);
  await expect(studio.locator("#create-error"))
    .toHaveText("Another entry already uses this web address. Choose a different one.");
  await expect(studio.locator("#create-id-input")).toBeFocused();
  await expect(studio.locator("#btn-create-confirm")).toBeDisabled();
  await studio.locator("#create-id-input").press("Escape");

  await studio.getByRole("button", { name: "Next", exact: true }).click();
  await expect(studio.locator("#entries-grid a")).toHaveCount(7);
  await studio.getByRole("searchbox").fill("lighthouse");
  await expect(studio.locator("#entries-grid a")).toHaveCount(1);
  await expect(studio.locator("#entries-grid")).toContainText("Distant lighthouse");
  await studio.getByRole("searchbox").fill("nothing-matches-this");
  await expect(studio.locator("#entries-grid a")).toHaveCount(0);
  await expect(studio.getByText("No matching entries.", { exact: true })).toBeVisible();
  await studio.getByRole("searchbox").fill("");
  await expect(studio.locator("#entries-grid a")).toHaveCount(24);
  await page.setViewportSize({ width: 390, height: 844 });
  await studio.locator("#page-next").focus();
  await page.keyboard.press("Enter");
  await expect(studio.locator("#entries-grid a")).toHaveCount(7);
  const secondPage = await (await page.request.get("/api/cms/entries?collection=studio-fixture&page=2")).json();
  for (const entry of secondPage.entries) {
    const response = await page.request.post("/api/cms/mutate", { headers: { "x-caret-request": "1" }, data: { type: "delete_entry", collection: "studio-fixture", id: entry.id } });
    expect(response.ok()).toBe(true);
  }
  await studio.locator("#page-prev").click();
  await expect(studio.locator("#entries-grid a")).toHaveCount(24);
  await expect(studio.locator("#entry-count")).toHaveText("24 entries");
  await expect(studio.locator("#pagination")).toBeHidden();
});

test("Studio refuses to empty a required field and points at it", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  const title = studio.locator('[name="title"]');
  await expect(title).toHaveValue("Seed entry");
  await title.fill("");

  const rejectedSave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-save").click();
  expect((await rejectedSave).status()).toBe(400);
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(studio.locator('[data-field-path="title"] .studio-error-text')).toContainText("This field can't be empty");

  const stored = await page.request.get("/api/cms/entries?collection=studio-fixture&id=seed-entry");
  expect((await stored.json()).entries[0].data.title).toBe("Seed entry");
});

test("Studio saves on its own after a pause, and Undo puts the previous value back", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  const title = studio.locator('[name="title"]');
  await expect(title).toHaveValue("Seed entry");

  const autosave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await title.fill("Saved without a click");
  expect((await autosave).ok()).toBe(true);
  await expect(studio.getByRole("dialog")).toHaveCount(0);
  await expect(title).toBeFocused();
  await expect(studio.locator("#status-msg")).toHaveText("All changes live");

  const undo = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await studio.locator("#btn-undo").click();
  expect((await undo).ok()).toBe(true);
  await expect(studio.locator('[name="title"]')).toHaveValue("Seed entry");
  await expect(studio.locator("#status-msg")).toHaveText("Change undone");
  const stored = await page.request.get("/api/cms/entries?collection=studio-fixture&id=seed-entry");
  expect((await stored.json()).entries[0].data.title).toBe("Seed entry");
});

test("an autosave that fails validation points at the field without moving the cursor", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  const title = studio.locator('[name="title"]');
  await expect(title).toHaveValue("Seed entry");

  const refused = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await title.fill("");
  expect((await refused).status()).toBe(400);
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(studio.locator("#status-msg")).toHaveText("Not saved — fix the highlighted fields");
});

test("deleting waits for its Undo window, and Undo keeps the entry", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  await expect(studio.locator("#editor")).toBeVisible();
  let deletes = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/cms/mutate") && request.method() === "POST" && request.postData()?.includes("delete_entry")) deletes += 1;
  });

  await studio.locator("#entry-more > summary").click();
  await Promise.all([
    expectStudioURL(page, /\/admin\/cms\/studio-fixture$/),
    studio.locator("#btn-delete").click(),
  ]);
  const notice = studio.locator("#delete-notice");
  await expect(notice).toContainText("Deleted “Seed entry”.");
  await expect(studio.locator("#entries-grid a", { hasText: "Seed entry" })).toHaveCount(0);

  await notice.getByRole("button", { name: "Undo" }).click();
  await expect(notice).toContainText("“Seed entry” is back.");
  await expect(studio.locator("#entries-grid a", { hasText: "Seed entry" })).toHaveCount(1);
  await page.waitForTimeout(11_000);
  expect(deletes).toBe(0);
  const stored = await page.request.get("/api/cms/entries?collection=studio-fixture&id=seed-entry");
  expect((await stored.json()).entries).toHaveLength(1);
});

test("leaving the list during the Undo window still deletes the entry", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  await expect(studio.locator("#editor")).toBeVisible();
  await studio.locator("#entry-more > summary").click();
  await Promise.all([
    expectStudioURL(page, /\/admin\/cms\/studio-fixture$/),
    studio.locator("#btn-delete").click(),
  ]);
  await expect(studio.locator("#delete-notice")).toContainText("Deleted");
  const sent = page.waitForRequest((request) => request.url().includes("/api/cms/mutate") && request.postData()?.includes("delete_entry") === true);
  await openStudio(page, "/admin/cms");
  await sent;
  await expect.poll(async () => (await (await page.request.get("/api/cms/entries?collection=studio-fixture&id=seed-entry")).json()).entries.length).toBe(0);
});

test("help text that only repeats a field's label isn't shown", async ({ page }) => {
  await page.route("**/api/cms/schema**", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { schema: { properties: Record<string, { title?: string; description?: string }> } };
    body.schema.properties.title.description = "title";
    body.schema.properties.website.description = "Where to find them online";
    await route.fulfill({ response, json: body });
  });
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  await expect(studio.locator("#editor")).toBeVisible();
  await expect(studio.locator('[data-field-path="title"] .caret-field-help')).toHaveCount(0);
  await expect(studio.locator('[data-field-path="website"] .caret-field-help')).toHaveText("Where to find them online");
});

test("an image upload the server refuses says why", async ({ page }) => {
  await page.route("**/api/cms/upload", (route) => route.fulfill({
    status: 400,
    json: { error: "This image is larger than 10 MB. Use a smaller image." },
  }));
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  await expect(studio.locator("#editor")).toBeVisible();
  await studio.locator('[data-field-path="images"] input[type=file]').setInputFiles({
    name: "huge.png", mimeType: "image/png", buffer: Buffer.from("not decoded in this test"),
  });
  await expect(studio.locator('[data-field-path="images"] .caret-image-help.is-error'))
    .toHaveText("This image is larger than 10 MB. Use a smaller image.");
});

async function storedTitle(page: import("@playwright/test").Page): Promise<unknown> {
  const response = await page.request.get("/api/cms/entries?collection=studio-fixture&id=seed-entry");
  const body = await response.json();
  return body.entries?.[0]?.data?.title;
}

test("an expired session in the Studio asks to sign in again and saves the kept edit", async ({ page, context }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  await expect(studio.locator("#editor")).toBeVisible();

  await context.clearCookies();
  await studio.locator('[name="title"]').fill("Saved after signing in");
  const dialog = studio.getByRole("dialog", { name: "Sign in again" });
  await expect(dialog).toBeVisible();
  await expectStudioURL(page, /\/admin\/cms\/studio-fixture\/seed-entry$/);
  await expect(studio.locator("#status-msg")).toHaveText("Not saved — sign in to save your changes");
  await expect(studio.locator('[name="title"]')).toHaveValue("Saved after signing in");

  await dialog.getByLabel("Password").fill(EDIT_PASSWORD);
  await dialog.getByRole("button", { name: "Sign in" }).click();
  await expect(dialog).toBeHidden();
  await expect(studio.locator("#status-msg")).toHaveText("All changes live");
  expect(await storedTitle(page)).toBe("Saved after signing in");
});

test("a Studio edit made offline saves itself when the connection returns", async ({ page, context }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  await expect(studio.locator("#editor")).toBeVisible();

  await context.setOffline(true);
  await studio.locator('[name="title"]').fill("Written offline in the Studio");
  await expect(studio.locator("#status-msg")).toHaveText("You're offline. Your changes are kept and save when you reconnect");

  await context.setOffline(false);
  await expect(studio.locator("#status-msg")).toHaveText("All changes live");
  expect(await storedTitle(page)).toBe("Written offline in the Studio");
});

test("a new entry named like an existing one gets the next free address", async ({ page }) => {
  const studio = await openStudio(page, "/admin/cms/studio-fixture");
  await studio.locator("#btn-new").click();
  await studio.locator("#create-title-input").fill("Seed entry");
  await expect(studio.locator("#create-address-preview")).toHaveText("Web address: seed-entry-2");
  await expect(studio.locator("#create-error")).toBeHidden();
  await Promise.all([
    expectStudioURL(page, /\/admin\/cms\/studio-fixture\/seed-entry-2\?new=1/),
    studio.locator("#create-title-input").press("Enter"),
  ]);
});

test("text fields wrap long text, and link fields take site paths", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
  await expect(studio.locator("#editor")).toBeVisible();

  const title = studio.locator('[name="title"]');
  const oneLine = (await title.boundingBox())!.height;
  await title.fill("A deliberately long title that cannot fit on a single line in a narrow drawer");
  await expect.poll(async () => (await title.boundingBox())!.height).toBeGreaterThan(oneLine);
  // Still a one-line value: Enter doesn't add a line break.
  await title.press("End");
  await title.press("Enter");
  expect(await title.inputValue()).not.toMatch(/\n/);

  const website = studio.locator('[name="website"]');
  for (const value of ["/work", "#contact", "mailto:hi@example.com", "https://example.com/a"]) {
    await website.fill(value);
    expect(await website.evaluate((input: HTMLInputElement) => input.validity.valid), value).toBe(true);
  }
  await website.fill("example dot com");
  expect(await website.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
});

test("the sign-in page focuses the password field", async ({ browser }) => {
  const visitor = await browser.newPage();
  await visitor.goto("/admin");
  await expect(visitor.locator("#password")).toBeFocused();
  await visitor.close();
});

test("a search counts matches, and an unsaved arrangement asks before leaving", async ({ page }) => {
  for (const [id, title] of [["second-entry", "Second entry"], ["third-entry", "Third entry"]] as const) {
    const response = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "put_entry", collection: "studio-fixture", id, data: { title, summary: "", website: "", published: false, details: [], images: [] } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const studio = await openStudio(page, "/admin/cms/studio-fixture");
  await studio.getByRole("searchbox").fill("zeppelin");
  await expect(studio.locator("#entry-count")).toHaveText("No matches");
  await studio.getByRole("searchbox").fill("Second");
  await expect(studio.locator("#entry-count")).toHaveText("1 match");
  await studio.getByRole("searchbox").fill("");

  await studio.locator("#btn-reorder").click();
  await studio.locator(".reorder-item").nth(1).locator('[data-move="-1"]').click();
  const prompted = page.waitForEvent("dialog");
  void studio.getByRole("navigation", { name: "Collections" }).getByRole("link", { name: "Overview" }).click();
  const dialog = await prompted;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await expect(studio.locator("#reorder-container")).toBeVisible();
});

test("on a phone: no zoom on fields, 44px targets, and every overlay can be closed", async ({ browser }) => {
  const phone = await browser.newContext({ ...devices["iPhone 13"], baseURL: test.info().project.use.baseURL });
  try {
    const page = await phone.newPage();
    await loginAsEditor(page);
    const studio = await openStudio(page, "/admin/cms/studio-fixture/seed-entry");
    await expect(studio.locator("#editor")).toBeVisible();
    // 16px fields: iOS zooms in on anything smaller.
    for (const field of await studio.locator("#fields input:visible, #fields textarea:visible").all()) {
      expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
    }
    // More actions closes on Esc and returns focus to its button.
    await studio.locator("#entry-more > summary").click();
    await page.keyboard.press("Escape");
    await expect(studio.locator("#entry-more")).not.toHaveAttribute("open", "");
    await expect(studio.locator("#entry-more > summary")).toBeFocused();

    // The search palette has a Close button on touch.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(studio.locator("#studio-palette")).toBeVisible();
    await studio.getByRole("button", { name: "Close" }).last().click();
    await expect(studio.locator("#studio-palette")).toBeHidden();

    // Cards are named by their titles.
    await openStudio(page, "/admin/cms/studio-fixture");
    await expect(studio.locator(".entry-card").first()).toHaveAccessibleName("Seed entry");

    // The Studio closes to the site it opened over, with the editor toolbar.
    const close = page.locator(".cms-panel-close");
    const closeBox = (await close.boundingBox())!;
    expect(Math.min(closeBox.width, closeBox.height)).toBeGreaterThanOrEqual(44);
    await close.click();
    await expect(page).toHaveURL("/");
    await expect(page.locator(".cms-toolbar")).toBeVisible();
    for (const control of await page.locator(".cms-toolbar button:visible, .cms-toolbar summary:visible").all()) {
      const box = (await control.boundingBox())!;
      expect(Math.min(box.width, box.height), await control.textContent() ?? "").toBeGreaterThanOrEqual(44);
    }
    await page.locator(".cms-studio-btn").click();
    await expect(page.locator(".cms-panel-close")).toBeVisible();
    await expect(page.locator(".cms-panel-expand")).toBeHidden();
  } finally {
    await phone.close();
  }
});
