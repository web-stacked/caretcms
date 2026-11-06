import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { EDIT_PASSWORD, openStudio } from "./helpers";

const PORT = process.env.STATIC_E2E_PORT ?? "4403";
const ORIGIN = `http://localhost:${PORT}`;
const REPO_ROOT = process.cwd();
const FIXTURE = resolve(REPO_ROOT, "tests/e2e/fixtures/static-site");
const PUBLISHED_HEADLINE = "Initial published headline";
const EDITED_HEADLINE = "Published into the static build";
const EDITED_HEADLINE_FROM_STUDIO = "Published from the Studio";
const WEBHOOK_PORT = Number(process.env.STATIC_E2E_WEBHOOK_PORT ?? "4404");
let webhookServer: Server;
let nextWebhookStatus = 202;

function stopDevServer(): void {
  try {
    execFileSync("npx", ["astro", "dev", "stop"], {
      cwd: FIXTURE,
      stdio: "ignore",
    });
  } catch {
    // Already stopped, including cleanup after a failed startup.
  }
}

function resetFixture(): void {
  rmSync(resolve(FIXTURE, ".caret"), { recursive: true, force: true });
  rmSync(resolve(FIXTURE, ".caretcms"), { recursive: true, force: true });
  rmSync(resolve(FIXTURE, ".astro"), { recursive: true, force: true });
  rmSync(resolve(FIXTURE, "dist"), { recursive: true, force: true });
}

function seedPublishedEntry(): void {
  const collection = resolve(FIXTURE, ".caret", "data", "pages");
  mkdirSync(collection, { recursive: true });
  writeFileSync(
    resolve(collection, "home.json"),
    `${JSON.stringify({ headline: PUBLISHED_HEADLINE }, null, 2)}\n`,
  );
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ORIGIN);
      if (response.status < 500) return;
    } catch {
      // The managed Astro server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw new Error(`Static authoring fixture did not start at ${ORIGIN}`);
}

function startDevServer(result: "live" | "failed" = "live"): void {
  execFileSync("npx", ["astro", "dev", "--background", "--host", "--port", PORT], {
    cwd: FIXTURE,
    stdio: "inherit",
    env: {
      ...process.env,
      CARET_EDIT_PASSWORD: EDIT_PASSWORD,
      STATIC_E2E_WEBHOOK_URL: `http://127.0.0.1:${WEBHOOK_PORT}/deploy`,
      STATIC_E2E_DEPLOYMENT_RESULT: result,
    },
  });
}

test.beforeAll(async () => {
  webhookServer = createServer((_request, response) => {
    const status = nextWebhookStatus;
    nextWebhookStatus = 202;
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(status >= 200 && status < 300 ? "accepted" : "failed");
  });
  await new Promise<void>((resolveListen, reject) => {
    webhookServer.once("error", reject);
    webhookServer.listen(WEBHOOK_PORT, "127.0.0.1", resolveListen);
  });
  stopDevServer();
  resetFixture();
  seedPublishedEntry();
  execFileSync("npm", ["run", "build:core"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  startDevServer();
  await waitForServer();
});

test.afterAll(() => {
  stopDevServer();
  resetFixture();
  webhookServer?.close();
});

test("a Studio-only editor drafts, sees what isn't published, and publishes from the Studio", async ({ page }) => {
  await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  // Edits only in the Studio, never on the page behind it: the Studio alone
  // works on drafts in static delivery.
  const studio = await openStudio(page, "/admin/cms/pages/home");
  const headline = studio.getByRole("textbox", { name: /^Headline/ });
  await expect(headline).toHaveValue(PUBLISHED_HEADLINE);
  await headline.fill("Drafted in the Studio");
  await studio.locator("#btn-save").click();
  await expect(studio.locator("#status-msg")).toHaveText("Draft saved");
  expect(await (await fetch(ORIGIN)).text()).toContain(PUBLISHED_HEADLINE);

  const changes = studio.locator("#draft-changes");
  await expect(changes.locator("summary")).toHaveText("1 change not published yet");
  await changes.locator("summary").click();
  await expect(changes.locator("del")).toHaveText(PUBLISHED_HEADLINE);
  await expect(changes.locator("ins")).toHaveText("Drafted in the Studio");

  await openStudio(page, "/admin/cms/pages");
  await expect(studio.locator(".entry-card-draft")).toHaveText("Not published");
  // Said once to assistive tech, as the card's description.
  await expect(studio.locator(".entry-card").first()).toHaveAccessibleDescription("Not published");
  expect((await studio.locator(".entry-card").first().ariaSnapshot()).match(/Not published/g)).toHaveLength(1);
  await openStudio(page, "/admin/cms");
  const notPublished = studio.getByRole("region", { name: "Not published yet" });
  await expect(notPublished.locator(".studio-page-entry")).toHaveCount(1);

  // Publishing one entry from its page.
  await openStudio(page, "/admin/cms/pages/home");
  const publish = page.waitForResponse(response => response.url().includes("/api/cms/publish") && response.request().method() === "POST");
  await studio.getByRole("button", { name: "Publish", exact: true }).click();
  expect((await publish).ok()).toBe(true);
  await expect(studio.locator("#status-msg")).toContainText("Published 1 change");
  await expect(changes).toBeHidden();
  await expect(studio.getByRole("button", { name: "Publish", exact: true })).toBeHidden();
  expect(await (await fetch(ORIGIN)).text()).toContain("Drafted in the Studio");

  // Discarding a draft returns the entry to what visitors see.
  await headline.fill("Thrown away");
  await studio.locator("#btn-save").click();
  await expect(studio.locator("#status-msg")).toHaveText("Draft saved");
  await studio.locator("#entry-more > summary").click();
  await studio.getByRole("button", { name: "Discard draft" }).click();
  await studio.getByRole("dialog", { name: "Discard your draft?" }).getByRole("button", { name: "Discard draft" }).click();
  await expect(studio.getByRole("textbox", { name: /^Headline/ })).toHaveValue("Drafted in the Studio");
  await expect(changes).toBeHidden();

  // Publish all from the overview.
  await studio.getByRole("textbox", { name: /^Headline/ }).fill(EDITED_HEADLINE_FROM_STUDIO);
  await studio.locator("#btn-save").click();
  await expect(studio.locator("#status-msg")).toHaveText("Draft saved");
  await openStudio(page, "/admin/cms");
  await studio.getByRole("button", { name: "Publish all" }).click();
  await expect(studio.locator("#studio-publish-status")).toContainText("Published 1 change");
  await expect(studio.locator("#studio-not-published")).toHaveText("Everything is published");
  expect(await (await fetch(ORIGIN)).text()).toContain(EDITED_HEADLINE_FROM_STUDIO);

  // Later tests start from the original published headline.
  const restore = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "pages", id: "home", data: { headline: PUBLISHED_HEADLINE } },
  });
  expect(restore.ok()).toBe(true);
  expect((await page.request.post("/api/cms/publish", { headers: { "x-caret-request": "1" }, data: {} })).ok()).toBe(true);
  expect(await (await fetch(ORIGIN)).text()).toContain(PUBLISHED_HEADLINE);
});

test("keeps a saved draft on reload without exposing it to other visitors", async ({ page, browser }) => {
  const headline = "Only this editor sees the reloaded draft";
  await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  await page.goto("/");
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  await page.locator('h1[data-caret]').fill(headline);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator(".cms-status-text")).toHaveText("Draft saved");
  // The confirmation says it isn't public yet.
  await expect(page.locator(".cms-toast-msg").filter({ hasText: "Draft saved. Publish to show it to visitors." })).toBeVisible();

  const response = await page.reload();
  expect(await response!.text()).toContain(headline);
  expect(response!.headers()["cache-control"]).toBe("private, no-store");
  await expect(page.locator('h1[data-caret]')).toHaveText(headline);

  const generatedPage = await page.request.get("/articles/home");
  expect(generatedPage.ok()).toBe(true);
  const generatedHtml = await generatedPage.text();
  expect(generatedHtml).toContain("Props from getStaticPaths");
  expect(generatedHtml).toContain(headline);
  // An entry passed as a getStaticPaths prop is bound like a getCollection() one.
  await page.goto("/articles/home");
  await expect(page.locator("h2.from-props")).toHaveText(headline);
  await expect(page.locator("h2.from-props")).toHaveAttribute("data-caret", "pages::home::headline");

  const otherEditor = await browser.newContext({ baseURL: ORIGIN });
  try {
    await otherEditor.request.post("/api/cms/auth/login", {
      data: { password: EDIT_PASSWORD },
      headers: { Accept: "application/json" },
    });
    const otherHtml = await (await otherEditor.request.get("/")).text();
    expect(otherHtml).toContain(PUBLISHED_HEADLINE);
    expect(otherHtml).not.toContain(headline);
    const anonymousHtml = await (await fetch(ORIGIN)).text();
    expect(anonymousHtml).toContain(PUBLISHED_HEADLINE);
    expect(anonymousHtml).not.toContain(headline);
  } finally {
    await otherEditor.close();
  }
});

test("keeps drafts for the next sign-in in the same browser", async ({ page }) => {
  await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  await page.goto("/");
  const save = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: { type: "put_entry", collection: "pages", id: "home", data: { headline: "Kept across sign-in" } },
  });
  expect(save.ok()).toBe(true);

  await page.getByRole("button", { name: "Sign out" }).click();
  const dialog = page.getByRole("dialog", { name: "Unpublished changes" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("keep the drafts for your next sign-in");
  const logout = page.waitForResponse(response =>
    response.url().includes("/api/cms/auth/logout") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Keep drafts and sign out" }).click();
  expect((await logout).ok()).toBe(true);

  await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  const drafts = await page.request.get("/api/cms/draft", { headers: { "x-caret-request": "1" } });
  expect((await drafts.json()).count).toBe(1);
});

test("rejects an older editor draft and keeps Publish above the Astro toolbar", async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 850 } }), browser.newContext({ baseURL: ORIGIN })]);
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of pages) {
      await page.request.post("/api/cms/auth/login", { data: { password: EDIT_PASSWORD }, headers: { Accept: "application/json" } });
      await page.goto("/");
    }
    for (let i = 0; i < pages.length; i++) {
      const response = await pages[i].request.post("/api/cms/mutate", { headers: { "x-caret-request": "1" }, data: { type: "put_entry", collection: "pages", id: "home", data: { headline: i === 0 ? "Older draft" : "Newer published draft" } } });
      expect(response.ok()).toBe(true);
    }
    const newer = await pages[1].request.post("/api/cms/publish", { headers: { "x-caret-request": "1" }, data: {} });
    expect((await newer.json()).published).toHaveLength(1);
    await pages[0].reload();
    await expect(pages[0].locator(".cms-toolbar")).toBeVisible();
    await expect(pages[0].locator("astro-dev-toolbar")).toHaveCount(1);
    await expect(pages[0].locator(".cms-toolbar")).toHaveCSS("bottom", "72px");
    await pages[0].locator("h1[data-caret]").click();
    await pages[0].keyboard.press("Tab");
    // A real click must reach Publish after keyboard focus enters the developer dock.
    const result = pages[0].waitForResponse(response => response.url().includes("/api/cms/publish"));
    await pages[0].locator(".cms-publish-btn").click();
    await pages[0].getByRole("dialog", { name: /^Publish \d+ changes?\?$/ }).getByRole("button", { name: "Publish", exact: true }).click();
    expect((await (await result).json()).conflicts).toEqual([{ collection: "pages", id: "home", reason: "stale_entry", title: "Older draft" }]);
    await expect(pages[0].locator(".cms-status-text")).toHaveText("Not published");
    expect(JSON.parse(readFileSync(resolve(FIXTURE, ".caret/data/pages/home.json"), "utf8")).headline).toBe("Newer published draft");
    expect((await (await pages[0].request.get("/api/cms/draft")).json()).count).toBe(1);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    // The following static-build test starts with the original published content.
    rmSync(resolve(FIXTURE, ".caret"), { recursive: true, force: true });
    rmSync(resolve(FIXTURE, ".caretcms"), { recursive: true, force: true });
    seedPublishedEntry();
  }
});

test("discards a draft and retries a failed deploy through toolbar requests", async ({ page }) => {
  try {
    const login = await page.request.post("/api/cms/auth/login", {
      data: { password: EDIT_PASSWORD },
      headers: { Accept: "application/json" },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    await page.goto("/");

    // Drafts saved elsewhere (here: the API); the toolbar recounts when the
    // editor comes back to the tab.
    const saveDraft = async (headline: string) => {
      const response = await page.request.post("/api/cms/mutate", {
        headers: { "x-caret-request": "1" },
        data: { type: "put_entry", collection: "pages", id: "home", data: { headline } },
      });
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      return response;
    };
    expect((await saveDraft("Discard this draft")).ok()).toBe(true);
    const discarded = page.waitForResponse(response =>
      response.url().includes("/api/cms/draft") && response.request().method() === "DELETE");
    await page.locator(".cms-discard-btn").click();
    const discardDialog = page.getByRole("dialog", { name: "Discard 1 unpublished change?" });
    await expect(discardDialog).toContainText("This permanently removes 1 unpublished change.");
    await discardDialog.getByRole("button", { name: "Discard", exact: true }).click();
    expect((await discarded).ok()).toBe(true);
    await page.waitForLoadState("domcontentloaded");
    // The result survives the reload that follows a discard.
    await expect(page.locator(".cms-toast-success .cms-toast-msg")).toHaveText("Discarded 1 unpublished change");
    expect((await (await page.request.get("/api/cms/draft")).json()).count).toBe(0);

    expect((await saveDraft("Retry deployment target")).ok()).toBe(true);
    nextWebhookStatus = 503;
    const failedPublish = page.waitForResponse(response =>
      response.url().includes("/api/cms/publish") && response.request().method() === "POST");
    await page.locator(".cms-publish-btn").click();
    await page.getByRole("dialog", { name: /^Publish \d+ changes?\?$/ }).getByRole("button", { name: "Publish", exact: true }).click();
    expect(await (await failedPublish).json()).toMatchObject({
      rebuild: { triggered: true, ok: false, status: 503 },
      retryAvailable: true,
    });
    await expect(page.locator(".cms-status-text")).toHaveText("Published, site not updated");
    await expect(page.locator(".cms-retry-rebuild-btn")).toBeVisible();
    // Back on the page later, the failed update still outranks "Live", and
    // there are no drafts left to publish.
    await page.reload();
    await expect(page.locator(".cms-status-text")).toHaveText("Published, site not updated");
    await expect(page.locator(".cms-retry-rebuild-btn")).toBeVisible();
    await expect(page.locator(".cms-draft-controls")).toBeHidden();

    const retried = page.waitForResponse(response =>
      response.url().includes("/api/cms/publish") && response.request().method() === "POST");
    await page.locator(".cms-retry-rebuild-btn").click();
    expect(await (await retried).json()).toMatchObject({
      rebuild: { triggered: true, ok: true, status: 202 },
      deploymentTracked: true,
      retryAvailable: false,
    });
    await expect(page.locator(".cms-retry-rebuild-btn")).toBeHidden();
    await expect(page.locator(".cms-status-text")).toHaveText("Updating site…");
  } finally {
    rmSync(resolve(FIXTURE, ".caret"), { recursive: true, force: true });
    rmSync(resolve(FIXTURE, ".caretcms"), { recursive: true, force: true });
    seedPublishedEntry();
    nextWebhookStatus = 202;
  }
});

test("publishes an authored draft into the next static build", async ({ page }) => {
  const login = await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();

  await page.goto("/");
  await expect(page.locator("h1")).toHaveText(PUBLISHED_HEADLINE);

  const save = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "pages",
      id: "home",
      data: { headline: EDITED_HEADLINE },
    },
  });
  expect(save.ok(), await save.text()).toBeTruthy();

  const anonymousBeforePublish = await fetch(ORIGIN);
  expect(await anonymousBeforePublish.text()).toContain(PUBLISHED_HEADLINE);

  const publish = await page.request.post("/api/cms/publish", {
    headers: { "x-caret-request": "1" },
    data: { collection: "pages", id: "home" },
  });
  expect(publish.ok(), await publish.text()).toBeTruthy();
  const publishBody = await publish.json();
  expect(publishBody).toEqual(expect.objectContaining({
    conflicts: [],
    published: [expect.objectContaining({ collection: "pages", id: "home" })],
    deploymentTracked: true,
  }));

  await page.reload();
  await expect(page.locator(".cms-status-text")).toHaveText("Updating site…");
  await expect(page.locator(".cms-status-text")).toHaveText("Live", { timeout: 8_000 });
  await page.locator(".cms-status-pill").click();
  await expect(page.getByRole("dialog", { name: "Save status" })).toContainText(/Build simulated-/);
  await page.keyboard.press("Escape");
  const deployment = await (await page.request.get("/api/cms/deployment")).json();
  expect(deployment).toMatchObject({
    configured: true,
    state: "live",
    buildId: expect.stringMatching(/^simulated-/),
    target: {
      id: expect.any(String),
      published: [expect.objectContaining({ collection: "pages", id: "home" })],
    },
  });

  stopDevServer();
  execFileSync("npx", ["astro", "build"], {
    cwd: FIXTURE,
    stdio: "inherit",
    env: {
      ...process.env,
      CARET_EDIT_PASSWORD: EDIT_PASSWORD,
      CARET_SESSION_SECRET: "e2e-static-session-secret-not-for-real-use-0123456789",
    },
  });

  const html = readFileSync(resolve(FIXTURE, "dist", "index.html"), "utf8");
  expect(html).toContain(EDITED_HEADLINE);
  expect(html).not.toContain(PUBLISHED_HEADLINE);
  expect(html).not.toContain("Static template headline");
  const generatedHtml = readFileSync(resolve(FIXTURE, "dist", "articles", "home", "index.html"), "utf8");
  expect(generatedHtml).toContain("Props from getStaticPaths");
  expect(generatedHtml).toContain(EDITED_HEADLINE);
  expect(generatedHtml).not.toContain("Only this editor sees the reloaded draft");
});

test("shows a provider-confirmed deployment failure", async ({ page }) => {
  // Start from a server in failure mode even if an earlier test left one running.
  stopDevServer();
  startDevServer("failed");
  await waitForServer();
  const login = await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  await page.goto("/");

  const save = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "pages",
      id: "home",
      data: { headline: "Deployment failure fixture" },
    },
  });
  expect(save.ok(), await save.text()).toBeTruthy();
  const publish = await page.request.post("/api/cms/publish", {
    headers: { "x-caret-request": "1" },
    data: { collection: "pages", id: "home" },
  });
  expect((await publish.json()).deploymentTracked).toBe(true);

  await page.reload();
  await expect(page.locator(".cms-status-text")).toHaveText("Updating site…");
  await expect(page.locator(".cms-status-text")).toHaveText("Site update failed", { timeout: 8_000 });
  expect(await (await page.request.get("/api/cms/deployment")).json()).toMatchObject({
    configured: true,
    state: "failed",
    buildId: expect.stringMatching(/^simulated-/),
  });
});
