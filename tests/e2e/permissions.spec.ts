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
    await expect(page.locator(".cms-toolbar-badge-text")).toHaveText("Draft");
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
    await expect(studio.locator("#btn-save")).toHaveText("Save draft");
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
    await reviewerPage.getByRole("dialog", { name: "Publish drafts?" }).getByRole("button", { name: "Publish", exact: true }).click();
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
