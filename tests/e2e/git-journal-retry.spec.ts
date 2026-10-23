import { test, expect } from "@playwright/test";
import { loginAsEditor, resetCmsStorage } from "./helpers";

test("Git history retry sends only a retry request and keeps the page content unchanged", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  await page.route("**/api/cms/draft", route => route.fulfill({ json: { count: 0, retryJournal: true, journalPending: 1 } }));
  const requests: unknown[] = [];
  let blocked = true;
  await page.route("**/api/cms/publish", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, published: [], journal: { pending: blocked ? 1 : 0, blocked: blocked ? 1 : 0 } } });
  });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Retry Git history", exact: true });
  await expect(button).toBeVisible();
  const title = page.getByRole("heading", { level: 1 }).first();
  const original = await title.textContent();
  const url = page.url();
  await button.click();
  await expect(page.locator(".cms-status-text")).toHaveText("Git history pending");
  await expect(button).toBeVisible();
  blocked = false;
  await button.click();
  await expect(page.locator(".cms-status-text")).toHaveText("Git history recorded");
  await expect(button).toBeHidden();
  expect(requests).toEqual([{ retryJournal: true }, { retryJournal: true }]);
  expect(page.url()).toBe(url);
  expect(await title.textContent()).toBe(original);
});

test("pending Git records stay with this browser, so signing out doesn't warn", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  const before = (await (await page.request.get("/api/cms/auth/session")).json()).identity.id;
  await page.route("**/api/cms/draft", route => route.fulfill({ json: { count: 0, retryJournal: true, journalPending: 1 } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Retry Git history", exact: true }).waitFor();

  const logout = page.waitForResponse(response =>
    response.url().includes("/api/cms/auth/logout") && response.request().method() === "POST");
  await page.locator(".cms-exit-btn").click();
  expect((await logout).ok()).toBe(true);
  await expect(page.getByRole("dialog", { name: "Git history is pending", exact: true })).toHaveCount(0);

  // Signing in again in the same browser reopens the same editor's records.
  await loginAsEditor(page);
  const after = (await (await page.request.get("/api/cms/auth/session")).json()).identity.id;
  expect(after).toBe(before);
});

test("Git retry stays hidden when the server denies permission", async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
  await page.route("**/api/cms/draft", route => route.fulfill({ json: { count: 0, retryJournal: false, journalPending: 1 } }));
  await page.goto("/");
  await expect(page.locator(".cms-toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Git history", exact: true })).toBeHidden();
});
