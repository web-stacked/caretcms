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
