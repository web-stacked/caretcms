import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { isMutatePost, loginAsEditor, replaceText } from "./helpers";

const CONTENT_SITE = resolve(process.cwd(), "examples/content-site");
const POST = resolve(CONTENT_SITE, "src/content/blog/ship-something-real.md");
const ORIGINAL = readFileSync(POST, "utf8");
const EDITED_TEXT = "The fastest way to test an idea is to put a real page in front of people.";

function resetFixture(): void {
  writeFileSync(POST, ORIGINAL);
  rmSync(resolve(CONTENT_SITE, ".caret"), { recursive: true, force: true });
  rmSync(resolve(CONTENT_SITE, ".caretcms"), { recursive: true, force: true });
  rmSync(resolve(CONTENT_SITE, "public/uploads"), { recursive: true, force: true });
}

test.beforeEach(() => resetFixture());
test.afterEach(() => resetFixture());

test("edits rendered Markdown as a draft, then publishes it to the source file", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");

  const paragraph = page.locator(".post-body p").first();
  await expect(paragraph).toContainText("The fastest way to kill a project");
  await expect(paragraph).toHaveAttribute("data-caret-md", /blog::ship-something-real::body::/);

  await replaceText(page, paragraph, EDITED_TEXT);
  const [save] = await Promise.all([
    page.waitForResponse(isMutatePost),
    paragraph.evaluate((element) => (element as HTMLElement).blur()),
  ]);
  expect(save.ok(), await save.text()).toBeTruthy();
  await expect(paragraph).toHaveText(EDITED_TEXT);
  expect(readFileSync(POST, "utf8")).toBe(ORIGINAL);

  const publish = await page.request.post("/api/cms/publish", {
    headers: { "x-caret-request": "1" },
    data: { collection: "blog", id: "ship-something-real" },
  });
  expect(publish.ok(), await publish.text()).toBeTruthy();
  const outcome = await publish.json();
  expect(outcome.conflicts).toEqual([]);
  expect(outcome.published).toEqual([
    expect.objectContaining({ collection: "blog", id: "ship-something-real" }),
  ]);

  const source = readFileSync(POST, "utf8");
  expect(source).toContain(EDITED_TEXT);
  expect(source).not.toContain("The fastest way to kill a project");
});
