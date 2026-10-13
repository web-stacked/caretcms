import { test, expect } from "@playwright/test";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { sanitizeHtml } from "../../packages/core/src/runtime/sanitize-html";

test("stored text remains inert in script templates and real text bindings", async ({ page }) => {
  const adapter = new InMemoryAdapter();
  const value = "';globalThis.reviewMarker=1;//";
  await adapter.writeEntry("pages", "home", { title: value });
  const html = `<script>globalThis.reviewMarker=0;const template='<p data-caret="pages::home::title">Original</p>';</script><p data-caret="pages::home::title">Original</p>`;
  await page.setContent(await rewriteCaretAttributes(html, adapter));
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { reviewMarker: number }).reviewMarker)).toBe(0);
  await expect(page.locator("p")).toHaveText(value);
});

test("foreign-content CDATA cannot expose script source as a binding", async ({ page }) => {
  const adapter = new InMemoryAdapter();
  await adapter.writeEntry("pages", "home", { title: "';globalThis.reviewMarker=1;//" });
  const html = `<script>globalThis.reviewMarker=0;</script><svg><script><![CDATA[const template='</script></svg><p data-caret="pages::home::title">Original</p>';]]></script></svg><p data-caret="pages::home::title">Original</p>`;
  await page.setContent(await rewriteCaretAttributes(html, adapter));
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { reviewMarker: number }).reviewMarker)).toBe(0);
  await expect(page.locator("p")).toHaveCount(1);
});

test("repeated sanitization preserves browser text and link query parameters", async ({ page }) => {
  const html = '<a href="/search?a=1&amp;b=2">A &amp; B &copy; &#x1F600;</a>';
  await page.setContent(sanitizeHtml(sanitizeHtml(html)));
  await expect(page.locator("a")).toHaveText("A & B © 😀");
  await expect(page.locator("a")).toHaveAttribute("href", "/search?a=1&b=2");
  await page.setContent(sanitizeHtml('<a href="jav&#x61;script:globalThis.reviewMarker=1">Unsafe</a>&lt;script&gt;x&lt;/script&gt;'));
  await expect(page.locator("a")).not.toHaveAttribute("href");
  await expect(page.locator("script")).toHaveCount(0);
});

test("Studio rejects a stale first draft and refreshes its base version for an explicit retry", async ({ page, browser, baseURL }) => {
  const { loginAsEditor, resetCmsStorage } = await import("./helpers");
  resetCmsStorage();
  await loginAsEditor(page);
  const write = async (target: typeof page, title: string) => target.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "studio-fixture", id: "version-conflict", data: { title, website: "", published: false } },
  });
  expect((await write(page, "Original")).ok()).toBe(true);
  await page.context().addCookies([{ name: "caret_preview", value: "1", url: baseURL! }]);
  await page.goto("/admin/cms/studio-fixture/version-conflict");
  await expect(page.locator('[name="title"]')).toHaveValue("Original");
  await page.locator('[name="website"]').fill("https://example.invalid/mine");

  const remote = await browser.newContext({ baseURL });
  try {
    const remotePage = await remote.newPage();
    await loginAsEditor(remotePage);
    expect((await write(remotePage, "Other editor")).ok()).toBe(true);
    const saved = page.waitForResponse(response => response.url().includes("/api/cms/mutate") && response.request().method() === "POST");
    await page.locator("#btn-save").click();
    const conflict = await saved;
    expect(conflict.status()).toBe(409);
    expect(conflict.request().postDataJSON()).toMatchObject({ expectedRevision: 0, expectedBaseRevision: 1 });
    expect(await conflict.json()).toMatchObject({ currentRevision: 0, currentBaseRevision: 2 });
    const published = await remotePage.request.get("/api/cms/entries?collection=studio-fixture&id=version-conflict");
    expect((await published.json()).entries[0].data).toMatchObject({ title: "Other editor", website: "" });

    await expect(page.locator("#conflict-dialog")).toBeVisible();
    await page.locator("#btn-conflict-keep").click();
    const retry = page.waitForResponse(response => response.url().includes("/api/cms/mutate") && response.request().method() === "POST");
    await page.locator("#btn-save").click();
    const result = await retry;
    expect(result.status()).toBe(200);
    expect(result.request().postDataJSON()).toMatchObject({ expectedRevision: 0, expectedBaseRevision: 2 });
    const draft = await page.request.get("/api/cms/entries?collection=studio-fixture&id=version-conflict");
    // Keep my edits applies only this form's change (website) on top of the
    // newer base, so the other editor's title is not reverted.
    expect((await draft.json()).entries[0].data).toMatchObject({ title: "Other editor", website: "https://example.invalid/mine" });
  } finally {
    await remote.close();
  }
});
