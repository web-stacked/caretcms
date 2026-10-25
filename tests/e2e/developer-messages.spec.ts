import { test, expect, type Page } from "@playwright/test";
import { loginAsEditor, resetCmsStorage } from "./helpers";

/** Pending Git history is the developer's to resolve: the CaretCMS dev toolbar
 *  shows it and retries it; editors aren't asked to. */

async function openDevPanel(page: Page) {
  await page.getByRole("button", { name: "CaretCMS", exact: true }).click();
  await expect(page.getByText("CaretCMS bindings")).toBeVisible();
}

test("editors see no Git history controls while records are pending", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  await page.route("**/api/cms/draft", route => route.fulfill({ json: { count: 0, retryJournal: true, journalPending: 1 } }));
  await page.goto("/");
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  await expect(page.locator(".cms-toolbar")).not.toContainText("Git");
  await expect(page.getByRole("button", { name: "Retry Git history" })).toHaveCount(0);
});

test("the dev toolbar shows pending Git history and retries only the journal", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  let pending = 1;
  await page.route("**/api/cms/draft", route => route.fulfill({ json: { count: 0, retryJournal: true, journalPending: pending } }));
  const requests: unknown[] = [];
  let blocked = true;
  await page.route("**/api/cms/publish", route => {
    requests.push(route.request().postDataJSON());
    pending = blocked ? 1 : 0;
    return route.fulfill({ json: { ok: true, published: [], journal: { pending: blocked ? 1 : 0, blocked: blocked ? 1 : 0 } } });
  });
  await page.goto("/");
  const title = page.getByRole("heading", { level: 1 }).first();
  const original = await title.textContent();
  const url = page.url();

  await openDevPanel(page);
  await expect(page.getByText("Git history pending", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Retry Git history" }).click();
  await expect(page.getByText("Some records need review", { exact: false })).toBeVisible();
  blocked = false;
  await page.getByRole("button", { name: "Retry Git history" }).click();
  await expect(page.getByText("Git history recorded.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Git history" })).toHaveCount(0);
  expect(requests).toEqual([{ retryJournal: true }, { retryJournal: true }]);
  expect(page.url()).toBe(url);
  expect(await title.textContent()).toBe(original);
});

test("the dev toolbar offers no Git retry when the server denies permission", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  await page.route("**/api/cms/draft", route => route.fulfill({ json: { count: 0, retryJournal: false, journalPending: 1 } }));
  await page.goto("/");
  await openDevPanel(page);
  await expect(page.getByText("Git history pending", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Git history" })).toHaveCount(0);
});

test("pending Git records stay with this browser across sign-out", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  const before = (await (await page.request.get("/api/cms/auth/session")).json()).identity.id;
  await page.route("**/api/cms/draft", route => route.fulfill({ json: { count: 0, retryJournal: true, journalPending: 1 } }));
  await page.goto("/");
  await expect(page.locator(".cms-toolbar")).toBeVisible();

  const logout = page.waitForResponse(response =>
    response.url().includes("/api/cms/auth/logout") && response.request().method() === "POST");
  await page.locator(".cms-exit-btn").click();
  expect((await logout).ok()).toBe(true);

  // Signing in again in the same browser reopens the same editor's records.
  await loginAsEditor(page);
  const after = (await (await page.request.get("/api/cms/auth/session")).json()).identity.id;
  expect(after).toBe(before);
});

test("a page with nothing editable points editors to the Studio, not to a command", async ({ page }) => {
  await loginAsEditor(page);
  await page.goto("/publication");
  const hint = page.locator(".caret-signin-hint");
  await expect(hint).toContainText("nothing on this page can be edited here");
  await expect(hint.getByRole("link", { name: "Open the Studio" })).toBeVisible();
  await expect(hint).not.toContainText("npx");
});
