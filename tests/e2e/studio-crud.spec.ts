import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
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

  await page.locator("#btn-new").click();
  await page.locator("#create-id-input").fill("first-studio-entry");
  await Promise.all([
    page.waitForURL(/\/admin\/cms\/studio-fixture\/first-studio-entry\?new=1$/),
    page.locator("#btn-create-confirm").click(),
  ]);

  await expect(page.getByText("Entry created with safe defaults")).toBeVisible();
  await expect(page.locator("#status-msg")).toHaveText("All changes saved");
  await expect(page.locator("#save-target")).toHaveText("Saving live");
  await expect(page.locator("#btn-preview")).toHaveAttribute("target", "_blank");
  await expect(page.locator(".editor-action-bar")).toHaveCSS("position", "sticky");
  await page.locator('[name="title"]').fill("First studio entry");
  await expect(page.locator("#status-msg")).toHaveText("Unsaved changes");

  await page.getByRole("button", { name: "+ Add detail" }).click();
  await page.locator('[name="details.0.label"]').fill("Medium");
  await page.locator('[name="details.0.value"]').fill("Mixed media");
  await page.getByRole("button", { name: "+ Add detail" }).click();
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

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "+ Choose an image" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixtureImage);

  await expect(page.locator(".caret-single-image-preview img")).toBeVisible();
  await expect(page.locator('[name="images.0.src"]')).not.toHaveValue("");
  await expect(page.locator('[name="images.0.title"]')).toHaveValue("Sample");
  await expect(page.locator('[name="images.0.alt"]')).toHaveValue("Sample");
  await expect(page.locator('input[type="file"]')).toHaveAttribute("aria-label", "Upload or replace image");

  await page.locator('[name="images.0.width"]').fill("0");
  const rejectedSave = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#btn-save").click();
  expect((await rejectedSave).status()).toBe(400);
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
  await expect(page.locator("#status-msg")).toHaveText("All changes saved");

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

  await page.locator("#btn-delete").click();
  const deleteResponse = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  await Promise.all([
    page.waitForURL(/\/admin\/cms\/studio-fixture$/),
    page.locator("#btn-delete-confirm").click(),
  ]);
  expect((await deleteResponse).ok()).toBe(true);

  const deleted = await page.request.get("/api/cms/entries?collection=studio-fixture&id=first-studio-entry");
  expect((await deleted.json()).entries).toHaveLength(0);
});

test("Studio routes singleton collections directly and hides impossible actions", async ({ page }) => {
  const seed = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "site-settings-fixture",
      id: "global",
      data: { title: "Example site" },
    },
  });
  expect(seed.ok()).toBe(true);

  await page.goto("/admin/cms");
  const card = page.getByRole("link", { name: /Site Settings/ });
  await expect(card).toHaveAttribute("href", "/admin/cms/site-settings-fixture/global");
  await card.click();
  await expect(page).toHaveURL(/\/admin\/cms\/site-settings-fixture\/global$/);
  await expect(page.locator("#btn-delete")).toHaveCount(0);

  await page.goto("/admin/cms/site-settings-fixture");
  await expect(page).toHaveURL(/\/admin\/cms\/site-settings-fixture\/global$/);
});

test("collection search has a persistent associated label", async ({ page }) => {
  await page.goto("/admin/cms/studio-fixture");
  await expect(page.getByLabel("Search")).toHaveAttribute("name", "search");
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
