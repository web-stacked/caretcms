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
    if (server && server.exitCode === null && server.signalCode === null) {
      // Listen before signalling so a fast exit isn't missed, and don't wait
      // forever on a server that ignores SIGTERM.
      const running = server;
      const exited = new Promise<void>((resolveExit) => running.once("exit", () => resolveExit()));
      running.kill("SIGTERM");
      const forceKill = setTimeout(() => running.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(forceKill);
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
  // Nothing to publish yet, so there's nothing to click.
  await expect(page.locator(".cms-draft-controls")).toBeHidden();

  await replaceText(page, paragraph, EDITED_TEXT);
  const [save] = await Promise.all([
    page.waitForResponse(isMutatePost),
    paragraph.evaluate((element) => (element as HTMLElement).blur()),
  ]);
  expect(save.ok(), await save.text()).toBeTruthy();
  await expect(paragraph).toHaveText(EDITED_TEXT);
  expect(readFileSync(POST, "utf8")).toBe(ORIGINAL);
  await expect(page.locator(".cms-publish-btn")).toHaveText("Publish 1");

  const publishPromise = page.waitForResponse((response) =>
    response.url().includes("/api/cms/publish") && response.request().method() === "POST",
  );
  await page.locator(".cms-publish-btn").click();
  const dialog = page.getByRole("dialog", { name: /^Publish \d+ changes?\?$/ });
  await expect(dialog).toContainText("This publishes 1 unpublished change.");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  const publish = await publishPromise;
  expect(publish.ok()).toBeTruthy();

  // The page reloads and still says what happened: Markdown renders at build
  // time, so a production server shows it after the rebuild.
  await expect(page.locator(".cms-toast-success .cms-toast-msg")).toHaveText(
    "Published 1 change. Visitors see it the next time the site updates.",
  );
  await expect(page.locator(".cms-draft-controls")).toBeHidden();

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

test("a post date is the same day on the page and in the Studio's date picker", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");
  // Stored as "2026-03-11"; shown as that day in every time zone.
  await expect(page.getByText("March 11, 2026")).toBeVisible();

  await page.goto("/admin/cms/blog/ship-something-real");
  const date = page.getByRole("textbox", { name: "Date" }).or(page.locator('[data-field-path="date"] input'));
  await expect(date).toHaveAttribute("type", "date");
  await expect(date).toHaveValue("2026-03-11");

  const save = page.waitForResponse(isMutatePost);
  await date.fill("2026-04-02");
  await date.dispatchEvent("change");
  await save;
  await expect.poll(() => readFileSync(POST, "utf8")).toContain("2026-04-02");
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
  await expect(page.getByText("Draft saved. Publish to show it to visitors.")).toBeVisible();
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
    await page.getByRole("dialog", { name: /^Publish \d+ changes?\?$/ }).getByRole("button", { name: "Publish", exact: true }).click();
    const failed = await (await pending).json();
    expect(failed.failed).toEqual([{ collection: "blog", id: "ship-something-real", reason: "storage_error", title: "Ship something real" }]);
    await expect(page.locator(".cms-status-text")).toHaveText("Publish didn’t finish");
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
  // Wait before the last edit: autosave can fire 1.2 s later, before the blur.
  const saving = page.waitForResponse(isMutatePost);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group).toContainText('Inserted paragraph.');
  await expect(page.locator('.post-body blockquote')).toHaveText(originalQuote!);

  await group.evaluate(element => (element as HTMLElement).blur());
  expect((await saving).ok()).toBe(true);
  expect(readFileSync(POST, 'utf8')).toBe(ORIGINAL);
  await page.reload();
  await expect(group.locator('p')).toHaveText(['Alpha', 'Beta', 'Inserted paragraph.', originalSecond!]);
  await page.screenshot({ path: test.info().outputPath('paragraph-preview.png'), fullPage: true });
  // Continue editing the reloaded structural draft; formatting must survive.
  await caret(1, true);
  const resaving = page.waitForResponse(isMutatePost);
  await page.keyboard.type(' continued');
  await group.evaluate(element => (element as HTMLElement).blur());
  expect((await resaving).ok()).toBe(true);
  const publishing = page.waitForResponse(response => response.url().includes('/api/cms/publish') && response.request().method() === 'POST');
  await page.locator('.cms-publish-btn').click();
  await page.getByRole('dialog', { name: /^Publish \d+ changes?\?$/ }).getByRole('button', { name: 'Publish', exact: true }).click();
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

  // A page older than its source file: the server refuses its save. The block
  // carries a stale source hash directly, because editing the file on disk
  // makes the dev server refresh the page at a time of its choosing.
  await group.evaluate(element => {
    const src = element.getAttribute('data-caret-md-src') ?? '';
    const stale = src.replace(/:[^:]+$/, ':00000000');
    element.setAttribute('data-caret-md-src', stale);
    const sources = element.getAttribute('data-caret-md-sources');
    if (sources) element.setAttribute('data-caret-md-sources', sources.split(src).join(stale));
  });
  await group.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' changed');
  const saving = page.waitForResponse(isMutatePost);
  await group.evaluate(element => (element as HTMLElement).blur());
  expect((await saving).status()).toBe(409);
  await expect(group).toContainText('changed');
  await expect(page.getByText('This content changed. Copy your edits, then reload before saving.')).toBeVisible();

  // The source changes under a saved draft: publishing keeps the file and the draft.
  const changed = ORIGINAL.replace('The fastest way', 'The slowest way');
  writeFileSync(POST, changed);
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

test("signing out with an unpublished body draft asks first in server mode", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");
  const paragraph = page.locator(".post-body [data-caret-md]").first();
  await expect(paragraph).toHaveAttribute("contenteditable", "true");
  await replaceText(page, paragraph, EDITED_TEXT);
  const [save] = await Promise.all([
    page.waitForResponse(isMutatePost),
    paragraph.evaluate((element) => (element as HTMLElement).blur()),
  ]);
  expect(save.ok(), await save.text()).toBeTruthy();

  await page.getByRole("button", { name: "Sign out" }).click();
  const dialog = page.getByRole("dialog", { name: "Unpublished changes" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1 unpublished change");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  const state = await page.request.get("/api/cms/draft", { headers: { "x-caret-request": "1" } });
  expect((await state.json()).count).toBe(1);
});

test("Studio sign-out keeps body drafts for the next sign-in in the same browser", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");
  const paragraph = page.locator(".post-body [data-caret-md]").first();
  await expect(paragraph).toHaveAttribute("contenteditable", "true");
  await replaceText(page, paragraph, EDITED_TEXT);
  await Promise.all([
    page.waitForResponse(isMutatePost),
    paragraph.evaluate((element) => (element as HTMLElement).blur()),
  ]);

  await page.goto("/admin/cms");
  const logout = page.waitForResponse((response) =>
    response.url().includes("/api/cms/auth/logout") && response.request().method() === "POST");
  await page.locator("#studio-logout-btn").click();
  expect((await logout).ok()).toBe(true);
  await expect(page.getByRole("dialog", { name: "Unpublished changes" })).toHaveCount(0);

  await loginAsEditor(page);
  const state = await page.request.get("/api/cms/draft", { headers: { "x-caret-request": "1" } });
  expect((await state.json()).count).toBe(1);
});

test("pasting a sentence into a paragraph saves", async ({ page, context }) => {
  await loginAsEditor(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/blog/start-from-the-words/");
  const group = page.locator(".post-body [data-caret-md]").first();
  await expect(group).toHaveAttribute("contenteditable", "true");
  await page.evaluate(() => navigator.clipboard.writeText("A pasted sentence."));
  await group.click();
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(group).toContainText("A pasted sentence.");

  const saving = page.waitForResponse(isMutatePost);
  await group.evaluate((element) => (element as HTMLElement).blur());
  const response = await saving;
  expect(response.ok(), `${response.status()} ${await response.text()} ${response.request().postData()}`).toBe(true);
  await expect(page.getByText("This formatting cannot be saved in a markdown block")).toHaveCount(0);
});

test("pasting from a word processor keeps bold, italic and links and drops the rest", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/start-from-the-words/");
  const group = page.locator(".post-body [data-caret-md]").first();
  await expect(group).toHaveAttribute("contenteditable", "true");
  await group.click();
  await page.keyboard.press("ControlOrMeta+a");
  await group.evaluate((element) => {
    const html = '<html><head><style>p.MsoNormal { color: red; }</style></head><body>'
      + '<p class="MsoNormal" style="margin:0"><b>Bold</b> and <i>italic</i> with <a href="https://example.com/doc">a link</a>, '
      + '<u>underlined</u> and <span style="font-size:14pt">sized</span> text<o:p></o:p></p>'
      + '<p class="MsoNormal">Second paragraph</p></body></html>';
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", "Bold and italic with a link, underlined and sized text\n\nSecond paragraph");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });

  await expect(group.locator("p")).toHaveCount(2);
  await expect(group.locator("strong, b")).toHaveText("Bold");
  await expect(group.locator("em, i")).toHaveText("italic");
  await expect(group.locator('a[href="https://example.com/doc"]')).toHaveText("a link");
  await expect(group.locator("u")).toHaveCount(0);
  await expect(group).not.toContainText("color: red");

  const saving = page.waitForResponse(isMutatePost);
  await group.evaluate((element) => (element as HTMLElement).blur());
  const response = await saving;
  expect(response.ok(), await response.text()).toBe(true);
});

test("Escape cancels an edit in a body paragraph", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");
  const paragraph = page.locator(".post-body [data-caret-md]").first();
  await expect(paragraph).toHaveAttribute("contenteditable", "true");
  const original = await paragraph.innerHTML();
  let mutations = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/cms/mutate") && request.method() === "POST") mutations += 1;
  });

  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" not wanted");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Edit cancelled")).toBeVisible();
  expect(await paragraph.innerHTML()).toBe(original);
  expect(mutations).toBe(0);
});

test("emptying a required field on the page keeps its text and says why", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");
  const author = page.locator('[data-caret="author"]').first();
  await expect(author).toHaveClass(/cms-editable/);
  const original = (await author.textContent())!.trim();

  await author.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  const saving = page.waitForResponse(isMutatePost);
  await author.evaluate((element) => (element as HTMLElement).blur());
  expect((await saving).status()).toBe(400);

  await expect(page.getByText("This field can't be empty. The previous text is back.")).toBeVisible();
  await expect(author).toHaveText(original);
  await expect(author).not.toHaveClass(/cms-unsaved/);
  expect(readFileSync(POST, "utf8")).toContain(`author: ${original}`);
});

test("a new team member isn't stored or shown until its required fields are filled", async ({ page }) => {
  const created = resolve(CONTENT_SITE, "src/content/team/noor-haddad.md");
  try {
    await loginAsEditor(page);
    await page.goto("/admin/cms/team");
    await page.locator("#btn-new").click();
    await page.locator("#create-title-input").fill("Noor Haddad");
    await Promise.all([
      page.waitForURL(/\/admin\/cms\/team\/noor-haddad\?new=1&title=Noor%20Haddad$/),
      page.locator("#btn-create-confirm").click(),
    ]);

    await expect(page.locator('[name="name"]')).toHaveValue("Noor Haddad");
    await expect(page.locator('[name="role"]')).toHaveValue("");
    expect(await (await page.request.get("/about")).text()).not.toContain("Noor Haddad");

    const refused = page.waitForResponse(isMutatePost);
    await page.locator("#btn-save").click();
    expect((await refused).status()).toBe(400);
    await expect(page.locator('[name="role"]')).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator('[data-field-path="role"] .studio-error-text')).toContainText("This field can't be empty");
    expect(await (await page.request.get("/about")).text()).not.toContain("Noor Haddad");
  } finally {
    rmSync(created, { force: true });
  }
});

test("in dev, body edits save live like fields, with Undo", async ({ page }) => {
  test.setTimeout(180_000);
  const DEV_PORT = process.env.MARKDOWN_DEV_PORT ?? "4405";
  const DEV = `http://localhost:${DEV_PORT}`;
  const site = mkdtempSync(resolve(REPO_ROOT, ".tmp-caret-markdown-dev-"));
  cpSync(CONTENT_SITE, site, {
    recursive: true,
    filter: (source) => ![".astro", ".caret", ".caretcms", "dist"].includes(basename(source)),
  });
  const post = resolve(site, "src/content/blog/ship-something-real.md");
  const stop = () => {
    try { execFileSync("npx", ["astro", "dev", "stop"], { cwd: site, stdio: "ignore" }); } catch { /* not running */ }
  };
  try {
    execFileSync("npx", ["astro", "dev", "--background", "--port", DEV_PORT], {
      cwd: site,
      stdio: "inherit",
      env: { ...process.env, CARET_EDIT_PASSWORD: "e2e-secret" },
    });
    const login = await page.request.post(`${DEV}/api/cms/auth/login`, {
      data: { password: "e2e-secret" }, headers: { Accept: "application/json" },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    await page.goto(`${DEV}/blog/ship-something-real/`);
    const blocks = page.locator('.post-body [data-caret-md][contenteditable="true"]');
    await expect(blocks.first()).toBeVisible();
    await page.evaluate(() => { (window as unknown as { stayed: boolean }).stayed = true; });

    /** Put the caret at the end of a block's last paragraph. */
    const caretAtEnd = (index: number) => blocks.nth(index).evaluate((el) => {
      (el as HTMLElement).focus();
      const target = el.querySelector("p:last-of-type") ?? el;
      const selection = getSelection()!;
      selection.selectAllChildren(target);
      selection.collapseToEnd();
    });
    /** The live save of a request carrying `text`. */
    const liveSave = (text: string) => page.waitForResponse(async (response) =>
      isMutatePost(response) && (response.request().postData() ?? "").includes(text) &&
      (await response.json()).live === true);

    // Autosave goes live while the editor is still typing: no draft, no reload.
    await caretAtEnd(0);
    let saved = liveSave("Live now.");
    await page.keyboard.type(" Live now.");
    await saved;
    await expect(blocks.first()).toBeFocused();
    expect(readFileSync(post, "utf8")).toContain("hypotheticals. Live now.");
    await expect(page.locator(".cms-draft-controls")).toBeHidden();

    // A later block saves too: its stamps were refreshed after the file moved.
    const last = (await blocks.count()) - 1;
    await caretAtEnd(last);
    saved = liveSave("Second live edit.");
    // After a live save the editor re-reads block stamps from a fresh render.
    const refreshed = page.waitForResponse((response) =>
      response.url() === `${DEV}/blog/ship-something-real/` && response.request().resourceType() === "fetch");
    await page.keyboard.type(" Second live edit.");
    await blocks.nth(last).evaluate((el) => (el as HTMLElement).blur());
    await saved;
    await refreshed;
    expect(readFileSync(post, "utf8")).toContain("to production. Second live edit.");

    const toast = page.locator(".cms-toast-success").filter({ hasText: "Saved" });
    await expect(toast.locator(".cms-toast-msg")).toHaveText("Saved");
    saved = liveSave("to production.");
    await toast.getByRole("button", { name: "Undo" }).click();
    await saved;
    await expect(page.locator(".cms-toast-success .cms-toast-msg").last()).toHaveText("Change undone");
    expect(readFileSync(post, "utf8")).not.toContain("Second live edit.");
    expect(readFileSync(post, "utf8")).toContain("hypotheticals. Live now.");
    expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
  } finally {
    stop();
    rmSync(site, { recursive: true, force: true });
  }
});

test("a body draft taken back with Undo leaves nothing to publish", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/ship-something-real/");
  const paragraph = page.locator(".post-body [data-caret-md]").first();
  await expect(paragraph).toHaveAttribute("contenteditable", "true");

  await replaceText(page, paragraph, EDITED_TEXT);
  const [save] = await Promise.all([
    page.waitForResponse(isMutatePost),
    paragraph.evaluate((element) => (element as HTMLElement).blur()),
  ]);
  expect(save.ok(), await save.text()).toBeTruthy();
  // A production server renders Markdown at build time: the body stays a draft.
  const toast = page.locator(".cms-toast-success").filter({ hasText: "Draft saved" });
  await expect(toast.locator(".cms-toast-msg")).toHaveText("Draft saved. Publish to show it to visitors.");
  await expect(page.locator(".cms-publish-btn")).toHaveText("Publish 1");

  const [undo] = await Promise.all([
    page.waitForResponse(isMutatePost),
    toast.getByRole("button", { name: "Undo" }).click(),
  ]);
  expect(undo.ok(), await undo.text()).toBeTruthy();
  await expect(paragraph).toContainText("The fastest way to kill a project");
  await expect(page.locator(".cms-draft-controls")).toBeHidden();
  expect((await (await page.request.get("/api/cms/draft")).json()).count).toBe(0);
  expect(readFileSync(POST, "utf8")).toBe(ORIGINAL);
});

test("the formatting bar starts at the selection and stays off the heading above", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/");
  const intro = page.locator("[data-caret-rich]").first();
  await expect(intro).toHaveAttribute("contenteditable", "true");
  await intro.click({ position: { x: 5, y: 10 } });
  await page.keyboard.down("Shift");
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  const bar = page.locator(".cms-rich-toolbar");
  await expect(bar).toBeVisible();
  const [barBox, introBox, headingBox] = await Promise.all([bar.boundingBox(), intro.boundingBox(), page.locator("main h1").boundingBox()]);
  expect(barBox!.x).toBeGreaterThanOrEqual(introBox!.x);
  expect(barBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height);
});

test("dropping an image onto the page replaces it and asks for its description", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/");
  const cover = page.locator('img[data-caret="cover"]');
  await expect(cover).toHaveAttribute("data-caret-img-mounted", "true");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const transfer = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "desk.png", { type: "image/png" }));
    return data;
  }, [...png]);
  await cover.dispatchEvent("dragover", { dataTransfer: transfer });
  const saved = page.waitForResponse(isMutatePost);
  await cover.dispatchEvent("drop", { dataTransfer: transfer });
  expect((await saved).ok()).toBe(true);

  const dialog = page.getByRole("dialog", { name: "Describe this image" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("Two desks by a window");
  const altSaved = page.waitForResponse(isMutatePost);
  await dialog.getByRole("button", { name: "Save description" }).click();
  expect((await altSaved).request().postDataJSON()).toMatchObject({ field: "cover_alt", value: "Two desks by a window" });
  await expect(cover).toHaveAttribute("alt", "Two desks by a window");
  await expect(page.locator('[data-caret="cover_alt"]')).toHaveText("Two desks by a window");
});

test("Enter in a heading or list item finishes the edit without an error", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/blog/start-from-the-words/");
  const heading = page.locator("h2[data-caret-md]").first();
  await expect(heading).toHaveAttribute("contenteditable", "true");
  const before = await heading.textContent();
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(heading).not.toBeFocused();
  await expect(heading).toHaveText(before!);
  await expect(page.locator(".cms-toast-error")).toHaveCount(0);
});
