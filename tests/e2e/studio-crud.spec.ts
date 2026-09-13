import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { loginAsEditor, resetCmsStorage } from "./helpers";

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
  await page.goto("/admin/cms/studio-fixture");

  await expect(page.locator(".entry-thumb img")).toHaveAttribute("src", "/initial.png");
  await expect(page.getByText("Unpublished")).toBeVisible();
  await expect(page.getByLabel("Collection", { exact: true })).toHaveValue("/admin/cms/studio-fixture");

  const createButton = page.locator("#btn-new");
  await createButton.click();
  const createDialog = page.getByRole("dialog", { name: "New entry" });
  const createClose = page.locator("#btn-create-close");
  const createTitle = page.locator("#create-title-input");
  const createId = page.locator("#create-id-input");
  await expect(createDialog).toBeVisible();
  await expect(createTitle).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(createClose).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#btn-create-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(createClose).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(createTitle).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(createDialog).toBeHidden();
  await expect(createButton).toBeFocused();

  await createButton.click();
  await createTitle.fill("Draft title");
  await expect(createId).toHaveValue("draft-title");
  await createId.fill("first-studio-entry");
  await Promise.all([
    page.waitForURL(/\/admin\/cms\/studio-fixture\/first-studio-entry\?new=1$/),
    page.locator("#btn-create-confirm").click(),
  ]);

  await expect(page.getByText("Entry created with safe defaults")).toBeVisible();
  await expect(page.locator("#fields")).not.toContainText("(optional)");
  await expect(page.getByText("Fields marked * are required.")).toBeVisible();
  await expect(page.locator(".caret-field-section-title")).toHaveText(["Content", "Repeatable content"]);
  await expect(page.getByText("Use bold, italic, or links to add emphasis.")).toBeVisible();
  await expect(page.locator('[name="title"]')).toHaveAttribute("aria-required", "true");
  await expect(page.locator('[name="summary"]')).toHaveAttribute("aria-describedby", "caret-field-summary-help");
  await expect(page.locator("#status-msg")).toHaveText("All changes live");
  await expect(page.locator("#save-target")).toHaveText("Saving live");
  await expect(page.locator("#visibility-status")).toHaveText("Hidden");
  await expect(page.locator("#btn-preview")).toHaveAttribute("target", "_blank");
  await expect(page.locator(".editor-action-bar")).toHaveCSS("position", "sticky");
  await page.locator('[name="title"]').fill("First studio entry");
  await expect(page.locator("#status-msg")).toHaveText("Unsaved changes");
  await page.locator('[name="published"]').check();
  await expect(page.locator("#visibility-status")).toHaveText("Public");

  await page.getByRole("button", { name: "+ Add detail" }).click();
  await expect(page.locator(".caret-object-array-item").first()).toHaveClass(/is-expanded/);
  await page.locator('[name="details.0.label"]').fill("Medium");
  await page.locator('[name="details.0.value"]').fill("Mixed media");
  await page.getByRole("button", { name: "+ Add detail" }).click();
  await expect(page.locator(".caret-object-array-item").first().locator(".caret-object-array-fields")).toBeHidden();
  await page.locator('[name="details.1.label"]').fill("Location");
  await page.locator('[name="details.1.value"]').fill("Montréal");
  const dragData = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(".caret-object-array-drag").nth(0).dispatchEvent("dragstart", { dataTransfer: dragData });
  await page.locator(".caret-object-array-item").nth(1).dispatchEvent("dragover", { dataTransfer: dragData });
  await page.locator(".caret-object-array-item").nth(1).dispatchEvent("drop", { dataTransfer: dragData });
  await expect(page.locator('[name="details.0.label"]')).toHaveValue("Location");
  await page.getByRole("button", { name: "Move down Location" }).click();
  await expect(page.locator('[name="details.0.label"]')).toHaveValue("Medium");

  await page.getByRole("button", { name: "+ Add image" }).click();
  await expect(page.locator('[name="images.0.id"]')).not.toHaveValue("");
  await expect(page.locator('[name="images.0.width"]')).toHaveValue("1600");
  await expect(page.locator('[name="images.0.height"]')).toHaveValue("1200");
  await expect(page.locator('[data-field-path="images.0.alt"]')).toBeVisible();
  await expect(page.locator('[data-field-path="images.0.width"]')).toBeHidden();

  const unlabeledControls = await page.locator("#fields input, #fields textarea, #fields select").evaluateAll((controls) =>
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

  await page.locator('[data-field-path="images"] .caret-object-array-toggle').click();
  await expect(page.locator('[data-field-path="images.0.src"]')).toBeHidden();
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
  await expect(page.locator('[data-field-path="images.0.src"]')).toHaveClass(/caret-field-selected/);
  await expect(page.locator('[data-field-path="images.0.src"]')).toBeVisible();

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "+ Choose an image" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixtureImage);

  await expect(page.locator(".caret-single-image-preview img")).toBeVisible();
  await expect(page.locator('[name="images.0.src"]')).not.toHaveValue("");
  await expect(page.locator('[name="images.0.title"]')).toHaveValue("Sample");
  await expect(page.locator('[name="images.0.alt"]')).toHaveValue("Sample");
  await expect(page.locator('input[type="file"]')).toHaveAttribute("aria-label", "Upload or replace image");
  await expect(page.getByRole("button", { name: "Replace image" })).toHaveCount(1);
  await expect(page.getByLabel("Image URL")).toBeHidden();
  await page.getByText("Use image URL").click();
  await expect(page.getByLabel("Image URL")).toBeVisible();

  await page.getByText("Technical details").click();
  await page.locator('[name="images.0.width"]').fill("0");
  await page.getByText("Technical details").click();
  await expect(page.locator('[name="images.0.width"]')).toBeHidden();
  const rejectedSave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-save").click();
  await page.getByRole("dialog", { name: "Save live changes?" }).getByRole("button", { name: "Save live" }).click();
  expect((await rejectedSave).status()).toBe(400);
  await expect(page.locator('[name="images.0.width"]')).toBeVisible();
  await expect(page.locator('[name="images.0.width"]')).toBeFocused();
  await expect(page.locator('[name="images.0.width"]')).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator('[data-field-path="images.0.width"] .studio-error-text')).toContainText("at least 1");
  await page.locator('[name="images.0.width"]').fill("1600");

  await page.locator(".studio-main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.locator("#btn-save")).toBeInViewport();

  const previewPage = await page.context().newPage();
  await previewPage.goto("/");
  await expect(previewPage.locator(".cms-toolbar")).toBeVisible();
  const previewReload = previewPage.waitForNavigation({ waitUntil: "domcontentloaded" });

  const createSave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-save").click();
  expect((await createSave).ok()).toBe(true);
  await previewReload;
  await expect(previewPage).toHaveURL("/");
  await expect(page.locator("#status-msg")).toHaveText("All changes live");

  const created = await page.request.get("/api/cms/entries?collection=studio-fixture&id=first-studio-entry");
  const createdBody = await created.json();
  expect(createdBody.entries).toHaveLength(1);
  expect(createdBody.entries[0].data.details).toEqual([
    { label: "Medium", value: "Mixed media" },
    { label: "Location", value: "Montréal" },
  ]);
  expect(typeof createdBody.entries[0].data.images[0].width).toBe("number");
  const firstRevision = createdBody.entries[0].revision;

  await page.locator('[name="summary"]').fill("Updated summary");
  const updateSave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-save").click();
  expect((await updateSave).ok()).toBe(true);

  const updated = await page.request.get("/api/cms/entries?collection=studio-fixture&id=first-studio-entry");
  const updatedBody = await updated.json();
  expect(updatedBody.entries[0].data.summary).toBe("Updated summary");
  expect(updatedBody.entries[0].revision).toBeGreaterThan(firstRevision);

  const deleteButton = page.locator("#btn-delete");
  await page.locator("#entry-more > summary").click();
  await deleteButton.click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete entry" });
  const deleteCancel = page.locator("#btn-delete-cancel");
  const deleteConfirm = page.locator("#btn-delete-confirm");
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toContainText("First studio entry");
  await expect(deleteCancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(deleteConfirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(deleteCancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(deleteDialog).toBeHidden();
  await expect(deleteButton).toBeFocused();

  await deleteButton.click();
  const deleteResponse = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await Promise.all([
    page.waitForURL(/\/admin\/cms\/studio-fixture$/),
    deleteConfirm.click(),
  ]);
  expect((await deleteResponse).ok()).toBe(true);

  const deleted = await page.request.get("/api/cms/entries?collection=studio-fixture&id=first-studio-entry");
  expect((await deleted.json()).entries).toHaveLength(0);
});

test("formatted fields keep supported markup while HTML editing stays secondary", async ({ page }) => {
  await page.goto("/admin/cms/studio-fixture/seed-entry");

  const editor = page.locator('[name="summary"]');
  const saveButton = page.locator("#btn-save");
  await expect(page.locator("#status-msg")).toHaveText("All changes live");
  await expect(saveButton).toBeDisabled();
  await page.getByRole("button", { name: "Edit HTML" }).click();
  await page.getByRole("button", { name: "Show formatted" }).click();
  await expect(page.locator("#status-msg")).toHaveText("All changes live");
  await expect(saveButton).toBeDisabled();

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
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(editor.locator("b, strong")).toHaveText("this");

  await page.getByRole("button", { name: "Edit HTML" }).click();
  const source = page.locator(".caret-rich-source");
  await expect(source).toBeVisible();
  await source.fill('<strong>Bold opening</strong> with a <a href="/work">work link</a><script>bad()</script>');
  await page.getByRole("button", { name: "Show formatted" }).click();
  await expect(editor.locator("strong")).toHaveText("Bold opening");
  await expect(editor.locator('a[href="/work"]')).toHaveText("work link");
  await expect(editor.locator("script")).toHaveCount(0);

  const saved = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-save").click();
  await page.getByRole("dialog", { name: "Save live changes?" }).getByRole("button", { name: "Save live" }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.locator('[name="summary"] strong')).toHaveText("Bold opening");
  await expect(page.locator('[name="summary"] a[href="/work"]')).toHaveText("work link");
});

test("embedded Studio Escape closes local overlays before the Studio drawer", async ({ page }) => {
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

  const deleteDialog = studio.getByRole("dialog", { name: "Delete entry" });
  const cancel = studio.locator("#btn-delete-cancel");
  await expect(deleteDialog).toBeVisible();
  await cancel.press("Escape");

  await expect(deleteDialog).toBeHidden();
  await expect(deleteButton).toBeFocused();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "Studio", exact: true }))
    .toHaveAttribute("aria-expanded", "true");

  const historyButton = studio.locator("#btn-history");
  await historyButton.click();
  const historyPanel = studio.getByRole("region", { name: "Version history" });
  const historyClose = studio.locator("#btn-history-close");
  await expect(historyPanel).toBeVisible();
  await expect(historyClose).toBeFocused();
  await historyClose.press("Escape");

  await expect(historyPanel).toBeHidden();
  await expect(studio.locator("#entry-more > summary")).toBeFocused();
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
  await expect(reorderCancel).toBeFocused();
  await reorderCancel.press("Escape");

  await expect(reorderRegion).toBeHidden();
  await expect(reorderButton).toBeFocused();
  await expect(panel).toBeVisible();
});

test("Studio keeps form edits after a revision conflict and saves on retry", async ({ page }) => {
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

  await page.goto(`/admin/cms/studio-fixture/${id}`);
  await page.locator('[name="title"]').fill("Local form edit");
  const external = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "studio-fixture",
      id,
      expectedRevision: initialRevision,
      data: { title: "External edit", summary: "", website: "", published: false, details: [], images: [] },
    },
  });
  expect(external.ok()).toBe(true);

  const conflict = page.waitForResponse(response =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-save").click();
  await page.getByRole("dialog", { name: "Save live changes?" }).getByRole("button", { name: "Save live" }).click();
  expect((await conflict).status()).toBe(409);
  const conflictDialog = page.getByRole("dialog", { name: "Newer changes found" });
  await expect(conflictDialog).toContainText("Title");
  await conflictDialog.getByRole("button", { name: "Keep my edits" }).click();
  await expect(page.locator("#status-msg")).toHaveText("Your edits are kept — Save again to overwrite");
  await expect(page.locator('[name="title"]')).toHaveValue("Local form edit");

  const retry = page.waitForResponse(response =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-save").click();
  expect((await retry).ok()).toBe(true);
  await expect(page.locator("#status-msg")).toHaveText("All changes live");

  const stored = await page.request.get(`/api/cms/entries?collection=studio-fixture&id=${id}`);
  const current = await stored.json();
  expect(current.entries[0].data.title).toBe("Local form edit");
  await page.locator('[name="title"]').fill("Another local edit");
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
  await page.locator("#btn-save").click();
  expect((await loadConflict).status()).toBe(409);
  await page.getByRole("dialog", { name: "Newer changes found" }).getByRole("button", { name: "Load latest" }).click();
  await expect(page.locator('[name="title"]')).toHaveValue("Latest remote edit");
  await expect(page.locator("#status-msg")).toHaveText("Loaded latest changes");
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

  await page.goto("/admin/cms");
  const card = page.getByRole("link", { name: /Site Settings/ });
  await expect(card).toHaveAttribute("href", "/admin/cms/site-settings-fixture/global");
  await card.click();
  await expect(page).toHaveURL(/\/admin\/cms\/site-settings-fixture\/global$/);
  await expect(page.locator("#entry-title")).toHaveText("Site Settings");
  await expect(page.locator("#btn-delete")).toHaveCount(0);

  await page.goto("/admin/cms/site-settings-fixture");
  await expect(page).toHaveURL(/\/admin\/cms\/site-settings-fixture\/global$/);
});

test("collection search has a persistent associated label", async ({ page }) => {
  await page.goto("/admin/cms/studio-fixture");
  await expect(page.getByLabel("Search")).toHaveAttribute("name", "search");
});

test("collection navigation and title-first creation fit a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/cms/studio-fixture");

  await expect(page.getByLabel("Collection", { exact: true })).toBeVisible();
  for (const control of await page.locator(".collection-actions > input, .collection-actions > button").all()) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  }

  await page.locator("#btn-new").click();
  const title = page.locator("#create-title-input");
  await expect(title).toBeFocused();
  await title.fill("A clear title");
  await expect(page.locator("#create-id-input")).toHaveValue("a-clear-title");
  const dialogBounds = await page.locator(".modal-card").boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect((dialogBounds?.x ?? 0) + (dialogBounds?.width ?? 0)).toBeLessThanOrEqual(390);
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
  await page.goto("/admin/cms/studio-fixture/seed-entry");
  await page.locator("#entry-more > summary").click();
  await expectMenuInsideViewport(page.locator(".editor-more-menu"));

  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto("/");
  await page.getByRole("button", { name: "Studio", exact: true }).click();
  const iframe = page.locator('iframe[title="Content Studio"]');
  await iframe.evaluate((element) => {
    (element as HTMLIFrameElement).src = "/admin/cms/studio-fixture/seed-entry";
  });
  const studio = page.frameLocator('iframe[title="Content Studio"]');
  await studio.locator("#entry-more > summary").click();
  await expectMenuInsideViewport(studio.locator(".editor-more-menu"));
});

test("Studio history restores the previous entry and keeps the replaced state undoable", async ({ page }) => {
  await page.goto("/admin/cms/studio-fixture/seed-entry");
  const title = page.locator('[name="title"]');
  await expect(title).toHaveValue("Seed entry");

  await title.fill("Changed after the snapshot");
  const save = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-save").click();
  await page.getByRole("dialog", { name: "Save live changes?" }).getByRole("button", { name: "Save live" }).click();
  expect((await save).ok()).toBeTruthy();

  const historyButton = page.locator("#btn-history");
  await page.locator("#entry-more > summary").click();
  await expect(historyButton).toHaveAttribute("aria-controls", "history-panel");
  await expect(historyButton).toHaveAttribute("aria-expanded", "false");
  await historyButton.click();
  const historyPanel = page.getByRole("region", { name: "Version history" });
  await expect(historyPanel).toBeVisible();
  await expect(historyButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#btn-history-close")).toBeFocused();
  await page.locator("#btn-history-close").press("Escape");
  await expect(historyPanel).toBeHidden();
  await expect(historyButton).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#entry-more > summary")).toBeFocused();

  await page.locator("#entry-more > summary").click();
  await historyButton.click();
  const historyRows = page.locator(".caret-history-row");
  await expect(historyRows).toHaveCount(1);
  await expect(historyRows.first().locator(".caret-history-action")).toHaveText("Saved");
  await expect(historyRows.first().locator(".caret-history-changes")).toContainText("Title");
  await historyRows.first().getByText("Review version").click();
  await expect(historyRows.first().locator(".caret-history-preview")).toContainText("Seed entry");

  const restore = page.waitForResponse((response) =>
    response.url().includes("/api/cms/history") && response.request().method() === "POST",
  );
  await historyRows.first().getByRole("button", { name: "Restore" }).click();
  await page.getByRole("dialog", { name: "Restore this version?" }).getByRole("button", { name: "Restore" }).click();
  expect((await restore).ok()).toBeTruthy();

  await expect(title).toHaveValue("Seed entry");
  await expect(page.locator("#status-msg")).toHaveText("Restored");

  await page.locator("#entry-more > summary").click();
  await historyButton.click();
  await expect(page.locator(".caret-history-row")).toHaveCount(2);
  await expect(page.locator(".caret-history-row").first().locator(".caret-history-action"))
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

  await page.goto("/admin/cms/studio-fixture");
  const reorderButton = page.locator("#btn-reorder");
  await expect(reorderButton).toHaveAttribute("aria-controls", "reorder-container");
  await expect(reorderButton).toHaveAttribute("aria-expanded", "false");
  await reorderButton.click();

  const reorderRegion = page.getByRole("region", { name: "Arrange entries" });
  const moveSeedDown = page.getByRole("button", { name: "Move down Seed entry" });
  await expect(reorderRegion).toBeVisible();
  await expect(reorderButton).toHaveAttribute("aria-expanded", "true");
  await expect(moveSeedDown).toBeFocused();
  await moveSeedDown.click();
  await expect(page.locator(".reorder-label")).toHaveText([
    "Second entry",
    "Seed entry",
    "Third entry",
  ]);
  const dragData = await page.evaluateHandle(() => new DataTransfer());
  await page.locator(".reorder-item").nth(2).dispatchEvent("dragstart", { dataTransfer: dragData });
  await page.locator(".reorder-item").nth(0).dispatchEvent("dragover", { dataTransfer: dragData });
  await page.locator(".reorder-item").nth(0).dispatchEvent("drop", { dataTransfer: dragData });
  await expect(page.locator(".reorder-label")).toHaveText([
    "Third entry",
    "Second entry",
    "Seed entry",
  ]);

  await page.keyboard.press("Escape");
  await expect(reorderRegion).toBeHidden();
  await expect(reorderButton).toHaveAttribute("aria-expanded", "false");
  await expect(reorderButton).toBeFocused();

  await reorderButton.click();
  await page.getByRole("button", { name: "Move down Seed entry" }).click();
  const saveResponse = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-reorder-save").click();
  expect((await saveResponse).ok()).toBe(true);
  await expect(reorderButton).toBeFocused();

  const stored = await (await page.request.get(
    "/api/cms/entries?collection=studio-fixture&pageSize=24",
  )).json() as { entries: Array<{ id: string; data: { order?: number } }> };
  expect(Object.fromEntries(stored.entries.map((entry) => [entry.id, entry.data.order])))
    .toMatchObject({ "second-entry": 0, "seed-entry": 1, "third-entry": 2 });

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
  await page.goto("/admin/cms/reorder-only-fixture");
  await expect(page.locator("#btn-new")).toHaveCount(0);
  await page.locator("#btn-reorder").click();
  await expect(page.getByRole("region", { name: "Arrange entries" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Move down Locked A" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#btn-reorder")).toBeFocused();
});

test("registered collections remain available before their first entry exists", async ({ page }) => {
  resetCmsStorage();

  await page.goto("/admin/cms");
  const fixtureCard = page.getByRole("link", { name: /Studio Fixture/ });
  await expect(fixtureCard).toContainText("0 entries");
  await fixtureCard.click();
  await expect(page).toHaveURL(/\/admin\/cms\/studio-fixture$/);
  await expect(page.locator("#entry-count")).toHaveText("0 entries");
  await expect(page.locator("#btn-new")).toBeVisible();

  await page.goto("/admin/cms");
  const singletonCard = page.getByRole("link", { name: /Site Settings/ });
  await expect(singletonCard).toHaveAttribute(
    "href",
    "/admin/cms/site-settings-fixture/global",
  );
  await singletonCard.click();
  await expect(page).toHaveURL(/\/admin\/cms\/site-settings-fixture\/global$/);
  await expect(page.getByRole("textbox", { name: "Site title" })).toHaveValue("Example site");
  await expect(page.locator("#btn-delete")).toHaveCount(0);
});

test("collection pagination reaches every entry and title search crosses pages", async ({ page }) => {
  for (let i = 1; i <= 30; i++) {
    const response = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "put_entry", collection: "studio-fixture", id: `post-${String(i).padStart(2, "0")}`, data: { title: i === 30 ? "Distant lighthouse" : `Post ${i}`, summary: "", website: "", published: false, details: [], images: [] } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.goto("/admin/cms");
  await expect(page.getByRole("link", { name: /Studio Fixture/ }))
    .toContainText("31 entries");

  await page.goto("/admin/cms/studio-fixture");
  await expect(page.locator("#entries-grid a")).toHaveCount(24);
  await expect(page.locator("#page-range")).toContainText("31");
  await expect(page.locator("#btn-reorder")).toBeHidden();

  await page.locator("#btn-new").click();
  await page.locator("#create-title-input").fill("Duplicate post");
  await page.locator("#create-id-input").fill("post-30");
  await expect(page.locator("#btn-create-confirm")).toBeEnabled();
  const duplicateResponse = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await page.locator("#btn-create-confirm").click();
  expect((await duplicateResponse).status()).toBe(409);
  await expect(page.locator("#create-error"))
    .toHaveText("An entry with this ID already exists.");
  await expect(page.locator("#create-id-input")).toBeFocused();
  await expect(page.locator("#btn-create-confirm")).toBeDisabled();
  await page.locator("#create-id-input").press("Escape");

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#entries-grid a")).toHaveCount(7);
  await page.getByRole("searchbox").fill("lighthouse");
  await expect(page.locator("#entries-grid a")).toHaveCount(1);
  await expect(page.locator("#entries-grid")).toContainText("Distant lighthouse");
  await page.getByRole("searchbox").fill("nothing-matches-this");
  await expect(page.locator("#entries-grid a")).toHaveCount(0);
  await expect(page.getByText("No matching entries.", { exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill("");
  await expect(page.locator("#entries-grid a")).toHaveCount(24);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#page-next").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#entries-grid a")).toHaveCount(7);
  const secondPage = await (await page.request.get("/api/cms/entries?collection=studio-fixture&page=2")).json();
  for (const entry of secondPage.entries) {
    const response = await page.request.post("/api/cms/mutate", { headers: { "x-caret-request": "1" }, data: { type: "delete_entry", collection: "studio-fixture", id: entry.id } });
    expect(response.ok()).toBe(true);
  }
  await page.locator("#page-prev").click();
  await expect(page.locator("#entries-grid a")).toHaveCount(24);
  await expect(page.locator("#entry-count")).toHaveText("24 entries");
  await expect(page.locator("#pagination")).toBeHidden();
});
