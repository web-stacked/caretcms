import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { EDIT_PASSWORD } from "./helpers";

const PORT = process.env.STATIC_E2E_PORT ?? "4403";
const ORIGIN = `http://localhost:${PORT}`;
const REPO_ROOT = process.cwd();
const FIXTURE = resolve(REPO_ROOT, "tests/e2e/fixtures/static-site");
const PUBLISHED_HEADLINE = "Initial published headline";
const EDITED_HEADLINE = "Published into the static build";
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

test("automatically enables preview mode before mounting the static editor", async ({ page }) => {
  await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  await page.goto("/");

  await expect(page.locator(".cms-toolbar")).toBeVisible();
  await expect.poll(async () => (await page.context().cookies(ORIGIN))
    .find(cookie => cookie.name === "caret_preview")?.value).toBe("1");
  await expect(page.locator(".cms-toolbar")).toHaveAttribute("data-delivery", "static");
});

test("rejects an older editor draft and keeps Publish above the Astro toolbar", async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 850 } }), browser.newContext({ baseURL: ORIGIN })]);
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of pages) {
      page.on("dialog", dialog => dialog.accept());
      await page.request.post("/api/cms/auth/login", { data: { password: EDIT_PASSWORD }, headers: { Accept: "application/json" } });
      await page.context().addCookies([{ name: "caret_preview", value: "1", url: ORIGIN }]);
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
    expect((await (await result).json()).conflicts).toEqual([{ collection: "pages", id: "home", reason: "stale_entry" }]);
    await expect(pages[0].locator(".cms-status-text")).toHaveText("Draft conflict");
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
  page.on("dialog", dialog => dialog.accept());
  try {
    const login = await page.request.post("/api/cms/auth/login", {
      data: { password: EDIT_PASSWORD },
      headers: { Accept: "application/json" },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    await page.context().addCookies([{ name: "caret_preview", value: "1", url: ORIGIN }]);
    await page.goto("/");

    const saveDraft = (headline: string) => page.request.post("/api/cms/mutate", {
      headers: { "x-caret-request": "1" },
      data: { type: "put_entry", collection: "pages", id: "home", data: { headline } },
    });
    expect((await saveDraft("Discard this draft")).ok()).toBe(true);
    const discarded = page.waitForResponse(response =>
      response.url().includes("/api/cms/draft") && response.request().method() === "DELETE");
    await page.locator(".cms-discard-btn").click();
    expect((await discarded).ok()).toBe(true);
    await page.waitForLoadState("domcontentloaded");
    expect((await (await page.request.get("/api/cms/draft")).json()).count).toBe(0);

    expect((await saveDraft("Retry deployment target")).ok()).toBe(true);
    nextWebhookStatus = 503;
    const failedPublish = page.waitForResponse(response =>
      response.url().includes("/api/cms/publish") && response.request().method() === "POST");
    await page.locator(".cms-publish-btn").click();
    expect(await (await failedPublish).json()).toMatchObject({
      rebuild: { triggered: true, ok: false, status: 503 },
      retryAvailable: true,
    });
    await expect(page.locator(".cms-status-text")).toHaveText("Published, deploy failed");
    await expect(page.locator(".cms-retry-rebuild-btn")).toBeVisible();

    const retried = page.waitForResponse(response =>
      response.url().includes("/api/cms/publish") && response.request().method() === "POST");
    await page.locator(".cms-retry-rebuild-btn").click();
    expect(await (await retried).json()).toMatchObject({
      rebuild: { triggered: true, ok: true, status: 202 },
      deploymentTracked: true,
      retryAvailable: false,
    });
    await expect(page.locator(".cms-retry-rebuild-btn")).toBeHidden();
    await expect(page.locator(".cms-status-text")).toHaveText("Deploying…");
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

  await page.context().addCookies([
    { name: "caret_preview", value: "1", url: ORIGIN },
  ]);
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
  await expect(page.locator(".cms-status-text")).toHaveText("Deploying…");
  await expect(page.locator(".cms-status-text")).toHaveText("Live", { timeout: 8_000 });
  await expect(page.locator(".cms-status-group")).toHaveAttribute("title", /Build simulated-/);
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
});

test("shows a provider-confirmed deployment failure", async ({ page }) => {
  startDevServer("failed");
  await waitForServer();
  const login = await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  await page.context().addCookies([{ name: "caret_preview", value: "1", url: ORIGIN }]);
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
  await expect(page.locator(".cms-status-text")).toHaveText("Deploying…");
  await expect(page.locator(".cms-status-text")).toHaveText("Deploy failed", { timeout: 8_000 });
  expect(await (await page.request.get("/api/cms/deployment")).json()).toMatchObject({
    configured: true,
    state: "failed",
    buildId: expect.stringMatching(/^simulated-/),
  });
});
