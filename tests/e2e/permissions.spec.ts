import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { blurToSave, replaceText } from "./helpers";

const STARTER = resolve(process.cwd(), "examples/starter");
const CARET = resolve(STARTER, ".caret");
const DATA = resolve(CARET, "data");
const META = resolve(STARTER, ".caretcms");
const UPLOADS = resolve(STARTER, "public/uploads");
const HEADLINE = 'h1[data-caret="hero.headline"]';
const ORIGINAL = "Launch an Astro site with live inline editing.";

function resetStorage(): void {
  for (const path of [CARET, META, UPLOADS]) rmSync(path, { recursive: true, force: true });
}

async function identityContext(browser: Browser, role: string): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: "http://localhost:4405",
    extraHTTPHeaders: { "x-caret-test-role": role },
  });
}

test.beforeEach(() => resetStorage());
test.afterEach(() => resetStorage());

test("writer edits a private draft while destructive and publishing actions stay denied", async ({ browser }) => {
  const writer = await identityContext(browser, "writer");
  const anonymous = await browser.newContext({ baseURL: "http://localhost:4405" });
  try {
    const page = await writer.newPage();
    await page.goto("/");
    await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);

    const headline = page.locator(HEADLINE);
    await replaceText(page, headline, "Writer private draft");
    expect((await blurToSave(page, headline)).ok()).toBe(true);
    await expect(page.locator(".cms-status-pill")).toHaveAttribute("data-mode", "draft");
    await expect(page.locator(".cms-publish-btn")).toBeHidden();

    await page.getByRole("button", { name: "Sign out" }).click();
    const signOutDialog = page.getByRole("dialog", { name: "Unpublished changes" });
    await expect(signOutDialog).toBeVisible();
    await expect(signOutDialog).toContainText("keep the drafts for your next sign-in");
    await expect(page.getByRole("button", { name: "Publish and sign out" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Keep drafts and sign out" })).toBeVisible();
    const logout = page.waitForResponse(response =>
      response.url().includes("/api/cms/auth/logout") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Keep drafts and sign out" }).click();
    expect((await logout).ok()).toBe(true);
    await page.waitForLoadState("domcontentloaded");
    expect((await (await page.request.get("/api/cms/draft")).json()).count).toBe(1);

    const visitor = await anonymous.newPage();
    await visitor.goto("/");
    await expect(visitor.locator(HEADLINE)).toHaveText(ORIGINAL);

    const publish = await page.request.post("/api/cms/publish", {
      headers: { "x-caret-request": "1" }, data: {},
    });
    expect(publish.status()).toBe(403);
    expect(await publish.json()).toEqual({ error: "Permission denied" });

    const deletion = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "delete_entry", collection: "pages", id: "home" },
    });
    expect(deletion.status()).toBe(403);
    const createCollection = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "create_collection", id: "secret", label: "Secret", schema: { type: "object", properties: {} } },
    });
    expect(createCollection.status()).toBe(403);

    const upload = await page.request.post("/api/cms/upload", {
      headers: { "x-caret-request": "1" },
      multipart: { file: { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("not-an-image") } },
    });
    expect(upload.status()).toBe(403);

    const studio = await writer.newPage();
    await studio.goto("/admin/cms/pages/home");
    await expect(studio.locator("#btn-save")).toBeHidden();
    await expect(studio.locator("#btn-delete")).toHaveCount(0);
    await expect(studio.locator("#btn-history")).toBeHidden();
  } finally {
    await writer.close();
    await anonymous.close();
  }
});

test("reviewer draft is isolated and can be published with attributed history", async ({ browser }) => {
  test.setTimeout(60_000);
  const writer = await identityContext(browser, "writer");
  const reviewer = await identityContext(browser, "reviewer");
  const anonymous = await browser.newContext({ baseURL: "http://localhost:4405" });
  try {
    const writerPage = await writer.newPage();
    await writerPage.goto("/");
    const writerHeadline = writerPage.locator(HEADLINE);
    await expect(writerHeadline).toHaveClass(/cms-editable/);
    await replaceText(writerPage, writerHeadline, "Writer-only draft");
    expect((await blurToSave(writerPage, writerHeadline)).ok()).toBe(true);

    const reviewerPage = await reviewer.newPage();
    await reviewerPage.goto("/");
    const reviewerHeadline = reviewerPage.locator(HEADLINE);
    await expect(reviewerHeadline).toHaveClass(/cms-editable/);
    await expect(reviewerHeadline).toHaveText(ORIGINAL);
    await replaceText(reviewerPage, reviewerHeadline, "Reviewed publication");
    expect((await blurToSave(reviewerPage, reviewerHeadline)).ok()).toBe(true);
    await expect(reviewerPage.locator(".cms-publish-btn")).toBeVisible();
    const publishingPromise = reviewerPage.waitForResponse(response =>
      response.url().includes("/api/cms/publish") && response.request().method() === "POST");
    await reviewerPage.locator(".cms-publish-btn").click();
    await reviewerPage.getByRole("dialog", { name: /^Publish \d+ changes?\?$/ }).getByRole("button", { name: "Publish", exact: true }).click();
    const publishing = await publishingPromise;
    expect(publishing.ok()).toBe(true);
    await reviewerPage.waitForLoadState("domcontentloaded");

    const visitor = await anonymous.newPage();
    await visitor.goto("/");
    await expect(visitor.locator(HEADLINE)).toHaveText("Reviewed publication");
    await writerPage.reload();
    await expect(writerPage.locator(HEADLINE)).toHaveText("Writer-only draft");

    const history = await reviewerPage.request.get("/api/cms/history?collection=pages&id=home");
    const entries = (await history.json()).history as Array<{ action: string; editor?: { id: string } }>;
    expect(entries.find(entry => entry.action === "publish")?.editor?.id).toBe("reviewer_01");
    expect(readFileSync(resolve(DATA, "pages/home.json"), "utf8")).toContain("Reviewed publication");
  } finally {
    await writer.close();
    await reviewer.close();
    await anonymous.close();
  }
});

test("Studio tells a draft's visibility apart from what visitors see", async ({ browser }) => {
  const admin = await identityContext(browser, "admin");
  const anonymous = await browser.newContext({ baseURL: "http://localhost:4405" });
  try {
    const page = await admin.newPage();
    const created = await page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "put_entry", collection: "studio-fixture", id: "pol-entry", data: {
        title: "Policy entry", summary: "", website: "", published: true, details: [], images: [],
      } },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const published = await page.request.post("/api/cms/publish", { headers: { "x-caret-request": "1" }, data: {} });
    expect(published.ok(), await published.text()).toBe(true);

    await page.goto("/admin/cms/studio-fixture/pol-entry");
    const status = page.locator("#status-msg");
    const visibility = page.locator("#visibility-status");
    await expect(status).toHaveText("Matches live");
    await expect(visibility).toHaveText("Public");

    await page.getByRole("switch", { name: "Published" }).click();
    await page.locator("#btn-save").click();
    await expect(status).toHaveText("Draft saved");
    await expect(visibility).toHaveText("Hidden after publish");
    await expect(page.locator('[data-field-path="published"] .caret-field-help')).toContainText("publish");

    const visitor = await anonymous.newPage();
    await visitor.goto("/publication");
    await expect(visitor.getByText("Policy entry")).toBeVisible();
  } finally {
    await admin.close();
    await anonymous.close();
  }
});

test("Studio rejects a stale first draft and refreshes its base version for an explicit retry", async ({ browser }) => {
  const mine = await identityContext(browser, "admin");
  const remote = await identityContext(browser, "reviewer");
  // In a draft mode, content reaches what visitors see only by publishing.
  const publishTitle = async (context: BrowserContext, title: string) => {
    const write = await context.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "put_entry", collection: "studio-fixture", id: "version-conflict", data: { title, website: "", published: false } },
    });
    expect(write.ok(), await write.text()).toBe(true);
    const publish = await context.request.post("/api/cms/publish", {
      headers: { "x-caret-request": "1" },
      data: { collection: "studio-fixture", id: "version-conflict" },
    });
    expect(publish.ok(), await publish.text()).toBe(true);
  };
  try {
    // The other editor publishes both versions, so this one's draft is its first.
    await publishTitle(remote, "Original");
    const page = await mine.newPage();
    await page.goto("/admin/cms/studio-fixture/version-conflict");
    await expect(page.locator('[name="title"]')).toHaveValue("Original");
    await page.locator('[name="website"]').fill("https://example.invalid/mine");

    await publishTitle(remote, "Other editor");
    const saved = page.waitForResponse(response => response.url().includes("/api/cms/mutate") && response.request().method() === "POST");
    await page.locator("#btn-save").click();
    const conflict = await saved;
    expect(conflict.status()).toBe(409);
    const firstBase = (conflict.request().postDataJSON() as { expectedBaseRevision: number }).expectedBaseRevision;
    expect(conflict.request().postDataJSON()).toMatchObject({ expectedRevision: 0 });
    expect(await conflict.json()).toMatchObject({ currentRevision: 0, currentBaseRevision: firstBase + 1 });

    await expect(page.locator("#conflict-dialog")).toBeVisible();
    await page.locator("#btn-conflict-keep").click();
    const retry = page.waitForResponse(response => response.url().includes("/api/cms/mutate") && response.request().method() === "POST");
    await page.locator("#btn-save").click();
    const result = await retry;
    expect(result.status()).toBe(200);
    expect(result.request().postDataJSON()).toMatchObject({ expectedRevision: 0, expectedBaseRevision: firstBase + 1 });
    const draft = await page.request.get("/api/cms/entries?collection=studio-fixture&id=version-conflict");
    // Keep my edits applies only this form's change (website) on top of the
    // newer base, so the other editor's title is not reverted.
    expect((await draft.json()).entries[0].data).toMatchObject({ title: "Other editor", website: "https://example.invalid/mine" });
  } finally {
    await mine.close();
    await remote.close();
  }
});

test("fields a writer may not edit are read-only and say why", async ({ browser }) => {
  const writer = await identityContext(browser, "writer");
  const admin = await identityContext(browser, "admin");
  try {
    // An about page visitors can see (in policy mode content arrives by publishing).
    const seed = await admin.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "put_entry", collection: "pages", id: "about", data: { hero: { headline: "About CaretCMS", subtext: "Second route" } } },
    });
    expect(seed.ok(), await seed.text()).toBe(true);
    expect((await admin.request.post("/api/cms/publish", { headers: { "x-caret-request": "1" }, data: {} })).ok()).toBe(true);

    const page = await writer.newPage();
    await page.goto("/about");
    const headline = page.locator('h1[data-caret="hero.headline"]');
    await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);
    // pages::about is outside the writer's permission: nothing to type into.
    await expect(headline).toHaveAttribute("data-caret-locked", "permission");
    await expect(headline).not.toHaveAttribute("contenteditable", /true|plaintext-only/);
    await expect(headline).toHaveAttribute("title", "You don't have permission to edit this.");
    await headline.click();
    await expect(page.getByText("You don't have permission to edit this.")).toBeVisible();
    // Not shown as selected, which would look like it can be edited.
    await expect(headline).not.toHaveClass(/cms-linked-selection/);

    // The home page stays editable for the same writer.
    await page.goto("/");
    await expect(page.locator(HEADLINE)).toHaveAttribute("contenteditable", /true|plaintext-only/);
    await expect(page.locator(HEADLINE)).not.toHaveAttribute("data-caret-locked");

    // In the Studio the same entry is for reading: a note, and nothing to type into.
    await page.goto("/admin/cms/pages/about");
    await expect(page.locator("#editor")).toBeVisible();
    await expect(page.getByRole("note")).toHaveText("You can view this entry, but you don't have permission to edit it.");
    const fields = page.locator("#fields input, #fields textarea");
    await expect(fields.first()).toBeVisible();
    for (const field of await fields.all()) await expect(field).toBeDisabled();

    // May edit, but not create: no Create button that could only fail.
    await page.goto("/admin/cms/pages");
    await expect(page.locator("#btn-new")).toHaveCount(0);
    await expect(page.locator("#btn-empty-create")).toHaveCount(0);
  } finally {
    await writer.close();
    await admin.close();
  }
});
