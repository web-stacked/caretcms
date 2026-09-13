import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { isMutatePost, loginAsEditor, replaceText } from "./helpers";

const CONTENT_SITE = resolve(process.cwd(), "examples/content-site");
const REPO_ROOT = process.cwd();
const POST = resolve(CONTENT_SITE, "src/content/blog/ship-something-real.md");
const ORIGINAL = readFileSync(POST, "utf8");
const HOME = resolve(CONTENT_SITE, "src/content/pages/home.md");
const ORIGINAL_HOME = readFileSync(HOME, "utf8");
const GALLERY = ["01", "02", "03"].map((id) => {
  const path = resolve(CONTENT_SITE, `src/content/gallery/${id}.md`);
  return { path, source: readFileSync(path, "utf8") };
});
const EDITED_TEXT = "The fastest way to test an idea is to put a real page in front of people.";
const REBUILT_PORT = process.env.MARKDOWN_REBUILT_PORT ?? "4404";
const REBUILT_ORIGIN = `http://localhost:${REBUILT_PORT}`;

function resetFixture(): void {
  writeFileSync(POST, ORIGINAL);
  writeFileSync(HOME, ORIGINAL_HOME);
  GALLERY.forEach(({ path, source }) => writeFileSync(path, source));
  rmSync(resolve(CONTENT_SITE, ".caret"), { recursive: true, force: true });
  rmSync(resolve(CONTENT_SITE, ".caretcms"), { recursive: true, force: true });
  rmSync(resolve(CONTENT_SITE, "public/uploads"), { recursive: true, force: true });
}

async function waitForBuiltServer(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Rebuilt content site exited with status ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${REBUILT_ORIGIN}/blog/ship-something-real/`);
      if (response.status < 500) return;
    } catch {
      // The rebuilt server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Rebuilt content site did not start at ${REBUILT_ORIGIN}`);
}

async function renderFromFreshBuild(): Promise<string> {
  const buildRoot = mkdtempSync(resolve(REPO_ROOT, ".tmp-caret-markdown-rebuild-"));
  cpSync(CONTENT_SITE, buildRoot, {
    recursive: true,
    filter: (source) => ![".astro", ".caret", ".caretcms", "dist"].includes(basename(source)),
  });

  let server: ChildProcess | null = null;

  try {
    execFileSync("npm", ["run", "build"], {
      cwd: buildRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        CARET_EDIT_PASSWORD: "e2e-secret",
        CARET_SESSION_SECRET: "e2e-markdown-rebuild-secret-not-for-real-use-0123456789",
      },
    });

    server = spawn(process.execPath, ["dist/server/entry.mjs"], {
      cwd: buildRoot,
      stdio: "ignore",
      env: {
        ...process.env,
        CARET_EDIT_PASSWORD: "e2e-secret",
        CARET_SESSION_SECRET: "e2e-markdown-rebuild-secret-not-for-real-use-0123456789",
        HOST: "127.0.0.1",
        PORT: REBUILT_PORT,
      },
    });
    await waitForBuiltServer(server);
    const response = await fetch(`${REBUILT_ORIGIN}/blog/ship-something-real/`);
    expect(response.ok).toBeTruthy();
    return await response.text();
  } finally {
    if (server?.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((resolveExit) => server.once("exit", () => resolveExit()));
    }
    rmSync(buildRoot, { recursive: true, force: true });
  }
}

test.beforeEach(() => resetFixture());
test.afterEach(() => resetFixture());

test("keeps malformed structural paragraph metadata read-only without crashing the editor", async ({ page }) => {
  await loginAsEditor(page);
  await page.route("**/blog/ship-something-real/", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = (await response.text()).replace(
      'data-caret-md="',
      'data-caret-md-sources="not-json" data-caret-md="',
    );
    await route.fulfill({ response, body: html });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/blog/ship-something-real/");
  await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);
  const malformed = page.locator('[data-caret-md-sources="not-json"]');
  await expect(malformed).toBeVisible();
  await expect(malformed).not.toHaveAttribute("contenteditable", "true");
  expect(pageErrors).toEqual([]);
});

test("edits rendered Markdown, publishes through the toolbar, and renders after rebuild", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");

  const paragraph = page.locator(".post-body [data-caret-md]").first();
  await expect(paragraph).toContainText("The fastest way to kill a project");
  await expect(paragraph).toHaveAttribute("data-caret-md", /blog::ship-something-real::body::/);
  await expect(paragraph).toHaveAttribute("contenteditable", "true");

  await replaceText(page, paragraph, EDITED_TEXT);
  const [save] = await Promise.all([
    page.waitForResponse(isMutatePost),
    paragraph.evaluate((element) => (element as HTMLElement).blur()),
  ]);
  expect(save.ok(), await save.text()).toBeTruthy();
  await expect(paragraph).toHaveText(EDITED_TEXT);
  expect(readFileSync(POST, "utf8")).toBe(ORIGINAL);

  page.once("dialog", (dialog) => dialog.accept());
  const publishPromise = page.waitForResponse((response) =>
    response.url().includes("/api/cms/publish") && response.request().method() === "POST",
  );
  await page.locator(".cms-publish-btn").click();
  const publish = await publishPromise;
  expect(publish.ok()).toBeTruthy();

  const source = readFileSync(POST, "utf8");
  expect(source).toContain(EDITED_TEXT);
  expect(source).not.toContain("The fastest way to kill a project");

  const rebuiltHtml = await renderFromFreshBuild();
  expect(rebuiltHtml).toContain(EDITED_TEXT);
  expect(rebuiltHtml).not.toContain("The fastest way to kill a project");

  const history = await page.request.get(
    "/api/cms/history?collection=blog&id=ship-something-real",
  );
  expect(history.ok(), await history.text()).toBeTruthy();
  const historyBody = await history.json() as {
    history: Array<{ ts: number; action: string; bodySource?: string }>;
  };
  const publishSnapshot = historyBody.history.find((entry) =>
    entry.action === "publish" && typeof entry.bodySource === "string",
  );
  expect(publishSnapshot).toBeDefined();

  const restore = await page.request.post("/api/cms/history", {
    headers: { "x-caret-request": "1" },
    data: {
      collection: "blog",
      id: "ship-something-real",
      ts: publishSnapshot!.ts,
    },
  });
  expect(restore.ok(), await restore.text()).toBeTruthy();
  expect(await restore.json()).toEqual(expect.objectContaining({
    ok: true,
    data: expect.any(Object),
  }));
  expect(readFileSync(POST, "utf8")).toBe(ORIGINAL);
});

test("keeps live-loader metadata out of non-text attributes", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/");

  const leaked = await page.evaluate(() => {
    const tagCharacter = /[\u{E0000}-\u{E007F}]/u;
    const values = [
      document.title,
      document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      ...Array.from(document.querySelectorAll("[href], [src], [alt]"))
        .flatMap((element) => ["href", "src", "alt"].map((name) => element.getAttribute(name) ?? "")),
    ];
    return values.filter((value) => tagCharacter.test(value));
  });

  expect(leaked).toEqual([]);
  await expect(page.locator('a[data-caret="cta_label"]')).toHaveAttribute("href", "/blog");
});

test("rich link editing exits safely when the browser selection disappears", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await loginAsEditor(page);
  await page.goto("/");

  const rich = page.locator('[data-caret="intro"][data-caret-rich]');
  await expect(rich).toHaveClass(/cms-editable/);
  await rich.evaluate((element) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected intro text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(5, text.textContent?.length ?? 0));
    const selection = window.getSelection();
    if (!selection) throw new Error("Expected browser selection");
    selection.removeAllRanges();
    selection.addRange(range);
    (element as HTMLElement).focus();
  });

  await page.keyboard.press("Control+k");
  const input = page.locator(".cms-link-popover-input");
  await expect(input).toBeVisible();
  await input.fill("https://example.com");

  await page.evaluate(() => {
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => null,
    });
  });
  await page.locator(".cms-link-popover-apply").click();

  await expect(page.locator(".cms-link-popover")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("rich toolbar updates an existing link and saves it once", async ({ page }) => {
  let mutationCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/cms/mutate") && request.method() === "POST") {
      mutationCount++;
    }
  });

  await loginAsEditor(page);
  await page.goto("/");

  const rich = page.locator('[data-caret="intro"][data-caret-rich]');
  await expect(rich).toHaveClass(/cms-editable/);
  await rich.evaluate((element) => {
    const anchor = element.querySelector("a");
    if (!anchor) throw new Error("Expected intro link");
    const range = document.createRange();
    range.selectNodeContents(anchor);
    const selection = window.getSelection();
    if (!selection) throw new Error("Expected browser selection");
    selection.removeAllRanges();
    selection.addRange(range);
    (element as HTMLElement).focus();
  });

  const toolbar = page.locator(".cms-rich-toolbar");
  await expect(toolbar).toBeVisible();
  await toolbar.getByTitle("Link (Ctrl+K)").click();
  const input = page.locator(".cms-link-popover-input");
  await expect(input).toHaveValue("/admin/cms");
  await input.fill("/blog");
  expect(mutationCount).toBe(0);
  await page.locator(".cms-link-popover-apply").click();
  expect(await rich.evaluate((element) => {
    const anchor = element.querySelector("a");
    return { href: anchor?.getAttribute("href"), html: element.innerHTML };
  })).toMatchObject({ href: "/blog" });

  const save = page.waitForResponse(isMutatePost);
  await rich.evaluate((element) => (element as HTMLElement).blur());
  expect((await save).ok()).toBeTruthy();
  expect(mutationCount).toBe(1);

  const response = await page.request.get("/api/cms/entries?collection=pages&id=home");
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = await response.json() as { entries: Array<{ data: { intro?: string } }> };
  expect(payload.entries[0]?.data.intro).toContain('href="/blog"');
});

test("rich toolbar creates a Markdown link without an early draft save", async ({ page }) => {
  let mutationCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/cms/mutate") && request.method() === "POST") {
      mutationCount++;
    }
  });

  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");

  const block = page.locator(".post-body [data-caret-md]").first();
  await expect(block).toHaveClass(/cms-editable/);
  await block.scrollIntoViewIfNeeded();
  await block.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text?.textContent) throw new Error("Expected Markdown text");
    const start = text.textContent.indexOf("fastest");
    if (start < 0) throw new Error("Expected linkable word");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + "fastest".length);
    const selection = window.getSelection();
    if (!selection) throw new Error("Expected browser selection");
    selection.removeAllRanges();
    selection.addRange(range);
    (element as HTMLElement).focus();
  });

  const toolbar = page.locator(".cms-rich-toolbar");
  await expect(toolbar).toBeVisible();
  await toolbar.getByTitle("Link (Ctrl+K)").click();
  const input = page.locator(".cms-link-popover-input");
  await expect(input).toHaveValue("");
  await input.fill("/about");
  expect(mutationCount).toBe(0);
  await page.locator(".cms-link-popover-apply").click();
  await expect(block.locator('a[href="/about"]')).toHaveText("fastest");

  const save = page.waitForResponse(isMutatePost);
  await block.evaluate((element) => (element as HTMLElement).blur());
  expect((await save).ok()).toBeTruthy();
  expect(mutationCount).toBe(1);
  await expect(page.getByText("Draft saved — publish to update the file")).toBeVisible();
});

test("exposes only collection operations the example implements", async ({ page }) => {
  await loginAsEditor(page);

  await page.goto("/admin/cms/site");
  await expect(page).toHaveURL(/\/admin\/cms\/site\/global$/);

  for (const collection of ["pages", "blog"]) {
    await page.goto(`/admin/cms/${collection}`);
    await expect(page.locator("#btn-new")).toHaveCount(0);
    await expect(page.locator("#btn-reorder")).toHaveCount(0);
  }

  for (const collection of ["gallery", "team"]) {
    await page.goto(`/admin/cms/${collection}`);
    await expect(page.locator("#btn-new")).toBeVisible();
    await expect(page.locator("#btn-reorder")).toBeVisible();
  }

  const schema = await page.request.get("/api/cms/schema?collection=gallery");
  expect(schema.ok(), await schema.text()).toBeTruthy();
  expect((await schema.json()).template).toEqual(expect.objectContaining({
    src: "/gallery/01.svg",
    alt: "Describe this image",
    caption: "Untitled project",
    year: "2026",
  }));
});

test("renders gallery entries in the order saved by Studio", async ({ page }) => {
  await loginAsEditor(page);

  const response = await page.request.get("/api/cms/entries?collection=gallery&pageSize=100");
  expect(response.ok(), await response.text()).toBeTruthy();
  const { entries } = await response.json() as {
    entries: Array<{ id: string; revision: number; data: { caption: string } }>;
  };
  const reversed = [...entries].reverse();

  const reorder = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "reorder_entries",
      collection: "gallery",
      items: reversed.map((entry, order) => ({
        id: entry.id,
        order,
        expectedRevision: entry.revision,
      })),
    },
  });
  expect(reorder.ok(), await reorder.text()).toBeTruthy();

  await page.goto("/");
  await expect(page.locator(".grid-cap > span:first-child")).toHaveText(
    reversed.map((entry) => entry.data.caption),
  );
});


test("recovers a Markdown publish after history storage fails", async ({ page }) => {
  page.on("dialog", dialog => dialog.accept());
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");
  const paragraph = page.locator(".post-body [data-caret-md]").first();
  await expect(paragraph).toHaveAttribute("contenteditable", "true");
  await replaceText(page, paragraph, "Recovered after a history storage failure.");
  const saving = page.waitForResponse(isMutatePost);
  await paragraph.press("Tab");
  expect((await saving).ok()).toBe(true);
  const historyPath = resolve(CONTENT_SITE, ".caretcms/history/blog/ship-something-real.json");
  mkdirSync(historyPath, { recursive: true });
  try {
    const pending = page.waitForResponse(response => response.url().includes("/api/cms/publish"));
    await page.locator(".cms-publish-btn").click();
    const failed = await (await pending).json();
    expect(failed.failed).toEqual([{ collection: "blog", id: "ship-something-real", reason: "storage_error" }]);
    await expect(page.locator(".cms-status-text")).toHaveText("Publish needs recovery");
    expect(readFileSync(POST, "utf8")).toContain("Recovered after a history storage failure.");
    rmSync(historyPath, { recursive: true });
    const retry = await page.request.post("/api/cms/publish", { headers: { "x-caret-request": "1" }, data: {} });
    expect(await retry.json()).toMatchObject({ published: [{ collection: "blog", id: "ship-something-real", revision: 1, deleted: false }], failed: [], conflicts: [] });
    expect(JSON.parse(readFileSync(historyPath, "utf8"))).toHaveLength(1);
    expect((await (await page.request.get("/api/cms/draft")).json()).count).toBe(0);
  } finally { rmSync(historyPath, { recursive: true, force: true }); }
});

test("unsupported YAML remains visible with an actionable error and retry", async ({ page }) => {
  await loginAsEditor(page);
  const path = resolve(CONTENT_SITE, "src/content/gallery/unsupported-yaml.md");
  const source = "---\nsrc: /gallery/01.svg\nalt: Test\ncaption: &caption Unsupported anchor\nyear: \"2026\"\n---\n";
  writeFileSync(path, source);
  try {
    await page.goto("/admin/cms/gallery");
    await expect(page.locator('a[href$="/unsupported-yaml"]')).toContainText("Cannot read entry");
    await page.locator('a[href$="/unsupported-yaml"]').click();
    await expect(page.locator("#load-error")).toContainText("unsupported frontmatter");
    await expect(page.locator("#not-found")).not.toBeVisible();
    expect(readFileSync(path, "utf8")).toBe(source);
    writeFileSync(path, GALLERY[0].source);
    await page.locator("#load-error-retry").click();
    await expect(page.locator("#fields")).toBeVisible();
    await expect(page.locator("#load-error")).not.toBeVisible();
  } finally { rmSync(path, { force: true }); }
});

for (const style of ["|", ">"] as const) {
test(`Studio edits ${style} frontmatter and preserves untouched YAML and body`, async ({ page }) => {
  await loginAsEditor(page);
  page.on("dialog", dialog => dialog.accept());
  const path = resolve(CONTENT_SITE, "src/content/gallery/multiline-yaml.md");
  const scalar = `caption: ${style}+ # preserve this block\n  Café first line\n  second line\n\n`;
  const body = "\nA **Markdown** body that must stay unchanged.\n";
  const source = `---\nsrc: /gallery/01.svg\nalt: Original\n${scalar}year: '2026' # preserve this too\n---\n${body}`;
  writeFileSync(path, source);
  try {
    await page.goto("/admin/cms/gallery/multiline-yaml");
    const caption = page.locator('textarea[name="caption"]');
    await expect(caption).toHaveValue(style === "|" ? "Café first line\nsecond line\n\n" : "Café first line second line\n\n");
    await page.locator('[name="alt"]').fill("Changed alt");
    let pending = page.waitForResponse(isMutatePost);
    await page.locator("#btn-save").click();
    expect((await pending).ok()).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(scalar);
    await caption.fill("Edited first line\nEdited second line\n\n");
    pending = page.waitForResponse(isMutatePost);
    await page.locator("#btn-save").click();
    expect((await pending).ok()).toBe(true);
    await page.reload();
    await expect(caption).toHaveValue("Edited first line\nEdited second line\n\n");
    const stored = await (await page.request.get("/api/cms/entries?collection=gallery&id=multiline-yaml")).json();
    expect(stored.entries[0].data.caption).toBe("Edited first line\nEdited second line\n\n");
    const saved = readFileSync(path, "utf8");
    expect(saved).toContain("year: '2026' # preserve this too\n");
    expect(saved.endsWith(body)).toBe(true);
  } finally { rmSync(path, { force: true }); }
});
}

test('splits, merges, inserts and deletes paragraphs with undo, then publishes and restores source', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsEditor(page);
  await page.goto('/blog/ship-something-real/');
  const group = page.locator('.post-body [data-caret-md-sources]').first();
  await expect(group).toHaveAttribute('contenteditable', 'true');
  const originalSecond = await group.locator('p').nth(1).textContent();
  const originalQuote = await page.locator('.post-body blockquote').textContent();
  await group.locator('p').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    (element.parentElement as HTMLElement).focus();
  });
  await page.keyboard.type('AlphaBeta');
  const caret = async (index: number, end = false) => {
    await group.locator('p').nth(index).evaluate((element, atEnd) => {
      const range = document.createRange(); range.selectNodeContents(element); range.collapse(!atEnd);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      (element.parentElement as HTMLElement).focus();
    }, end);
  };
  await caret(0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(group.locator('p')).toHaveCount(3);
  await expect(group.locator('p').nth(0)).toHaveText('Alpha');
  await expect(group.locator('p').nth(1)).toHaveText('Beta');

  await caret(1);
  await page.keyboard.press('Backspace');
  await expect(group.locator('p')).toHaveCount(2);
  await expect(group.locator('p').first()).toHaveText('AlphaBeta');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group.locator('p')).toHaveCount(3);
  await caret(0, true);
  await page.keyboard.press('Delete');
  await expect(group.locator('p')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group.locator('p')).toHaveCount(3);

  await caret(1, true);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Inserted paragraph.');
  await expect(group.locator('p')).toHaveCount(4);
  await group.locator('p').nth(2).evaluate(element => {
    const range = document.createRange(); range.selectNode(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press('Backspace');
  await expect(group).not.toContainText('Inserted paragraph.');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group).toContainText('Inserted paragraph.');
  await expect(page.locator('.post-body blockquote')).toHaveText(originalQuote!);

  const saving = page.waitForResponse(isMutatePost);
  await group.evaluate(element => (element as HTMLElement).blur());
  expect((await saving).ok()).toBe(true);
  expect(readFileSync(POST, 'utf8')).toBe(ORIGINAL);
  await page.reload();
  await expect(group.locator('p')).toHaveText(['Alpha', 'Beta', 'Inserted paragraph.', originalSecond!]);
  await page.screenshot({ path: test.info().outputPath('paragraph-preview.png'), fullPage: true });
  // Continue editing the reloaded structural draft; formatting must survive.
  await caret(1, true);
  await page.keyboard.type(' continued');
  const resaving = page.waitForResponse(isMutatePost);
  await group.evaluate(element => (element as HTMLElement).blur());
  expect((await resaving).ok()).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  const publishing = page.waitForResponse(response => response.url().includes('/api/cms/publish') && response.request().method() === 'POST');
  await page.locator('.cms-publish-btn').click();
  expect((await publishing).ok()).toBe(true);
  const source = readFileSync(POST, 'utf8');
  expect(source).toContain('Alpha\n\nBeta continued\n\nInserted paragraph.');
  expect(source).toContain(ORIGINAL.slice(ORIGINAL.indexOf('So we ship')));
  const rebuilt = await renderFromFreshBuild();
  expect(rebuilt).toMatch(/>Alpha<\/p>/);
  expect(rebuilt).toMatch(/>Beta continued<\/p>/);
  expect(rebuilt).toMatch(/>Inserted paragraph\.<\/p>/);
  const history = await (await page.request.get('/api/cms/history?collection=blog&id=ship-something-real')).json();
  const snapshot = history.history.find((entry: { action: string }) => entry.action === 'publish');
  const restore = await page.request.post('/api/cms/history', { headers: { 'x-caret-request': '1' }, data: { collection: 'blog', id: 'ship-something-real', ts: snapshot.ts } });
  expect(restore.ok()).toBe(true);
  expect(readFileSync(POST, 'utf8')).toBe(ORIGINAL);
});

test('pastes Unicode paragraphs, retains failed saves, and protects nested blocks and stale source', async ({ page, context }) => {
  await loginAsEditor(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/blog/ship-something-real/');
  const group = page.locator('.post-body [data-caret-md-sources]').first();
  await expect(group).toHaveAttribute('contenteditable', 'true');
  const originalText = await group.textContent();
  const pasted = 'Café 🧪 中文\n\n# Literal heading\nline two';
  await group.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.evaluate(text => navigator.clipboard.writeText(text), pasted);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(group.locator('p')).toHaveCount(2);
  await expect(group).toContainText('Café 🧪 中文');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group).toHaveText(originalText!);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+v');

  await page.route('**/api/cms/mutate', route => route.abort(), { times: 1 });
  await group.evaluate(element => (element as HTMLElement).blur());
  await expect(page.getByText('Failed to save. Your edits are kept here; focus and leave the block to retry.')).toBeVisible();
  await expect(group).toContainText('Café 🧪 中文');
  await group.click();
  const retrying = page.waitForResponse(isMutatePost);
  await group.evaluate(element => (element as HTMLElement).blur());
  expect((await retrying).ok()).toBe(true);
  expect(readFileSync(POST, 'utf8')).toBe(ORIGINAL);
  await page.reload();
  await expect(group.locator('p')).toHaveCount(2);
  await expect(group).toContainText('Café 🧪 中文');
  const quote = page.locator('.post-body blockquote [data-caret-md]');
  const quoteText = await quote.textContent();
  await quote.click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Enter');
  await expect(quote).toHaveText(quoteText!);
  await expect(quote.locator('p, div, br')).toHaveCount(0);

  const changed = ORIGINAL.replace('The fastest way', 'The slowest way');
  writeFileSync(POST, changed);
  await group.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' changed');
  const saving = page.waitForResponse(isMutatePost);
  await group.evaluate(element => (element as HTMLElement).blur());
  expect((await saving).status()).toBe(409);
  await expect(group).toContainText('changed');
  await expect(page.getByText('This content changed. Copy your edits, then reload before saving.')).toBeVisible();
  const publish = await page.request.post('/api/cms/publish', { headers: { 'x-caret-request': '1' }, data: {} });
  expect((await publish.json()).conflicts).toHaveLength(1);
  expect(readFileSync(POST, 'utf8')).toBe(changed);
});

test('keeps inline code formatting when a paragraph group is edited and reloaded', async ({ page }) => {
  await loginAsEditor(page);
  await page.goto('/blog/start-from-the-words/');
  const group = page.locator('.post-body [data-caret-md-sources]').last();
  await expect(group).toHaveAttribute('contenteditable', 'true');
  const code = group.locator('code');
  await expect(code).toHaveText('.md');
  await code.click();
  await code.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.type(' source');
  const saving = page.waitForResponse(isMutatePost);
  await group.evaluate(element => (element as HTMLElement).blur());
  expect((await saving).ok()).toBe(true);
  await page.reload();
  await expect(code).toHaveText('.md source');
  await expect(group.locator('strong')).toHaveText('title and excerpt');
});
