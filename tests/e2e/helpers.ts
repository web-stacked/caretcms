import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator, Page, Response } from "@playwright/test";

/** Must match `webServer.env.CARET_EDIT_PASSWORD` in playwright.config.ts. */
export const EDIT_PASSWORD = "e2e-secret";

const STARTER_DIR = resolve(process.cwd(), "examples/starter");
const STARTER_ORIGIN = `http://localhost:${process.env.E2E_PORT ?? "4399"}`;

/**
 * Reset the filesystem-backed CMS to a clean slate so every test starts from
 * the template defaults (no stored overrides, no revision history). Without
 * this, a leftover override from a prior run would mask a broken save.
 */
export function resetCmsStorage(): void {
  rmSync(resolve(STARTER_DIR, ".caret"), { recursive: true, force: true });
  rmSync(resolve(STARTER_DIR, ".caretcms"), { recursive: true, force: true });
  rmSync(resolve(STARTER_DIR, "public/uploads"), { recursive: true, force: true });
}

/**
 * Authenticate the page's browser context as an editor by hitting the login
 * API directly. Cookies land in the shared context jar, so subsequent
 * `page.goto` requests are authenticated and the editor bootstrap mounts.
 */
export async function loginAsEditor(page: Page): Promise<void> {
  const res = await page.request.post("/api/cms/auth/login", {
    data: { password: EDIT_PASSWORD },
    headers: { Accept: "application/json" },
  });
  if (!res.ok()) {
    throw new Error(`Editor login failed: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Fetch a page as an anonymous visitor (no editor cookie). Proves that a
 * stored override is served via the rewrite middleware in the SSR HTML,
 * independent of the in-browser editor having mutated the live DOM.
 */
export async function fetchAnonymousHtml(path = "/"): Promise<string> {
  const res = await fetch(new URL(path, STARTER_ORIGIN));
  if (!res.ok) throw new Error(`Anonymous fetch failed: ${res.status}`);
  return res.text();
}

/** Predicate matching the editor's single write endpoint (`save_field`, etc.). */
export const isMutatePost = (r: Response): boolean =>
  r.url().includes("/api/cms/mutate") && r.request().method() === "POST";

/** Replace an editable element's text the way a user does: focus → select all → type. */
export async function replaceText(page: Page, target: Locator, text: string): Promise<void> {
  await target.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

/** Blur the element to trigger the save, returning the resulting mutate response. */
export async function blurToSave(page: Page, target: Locator): Promise<Response> {
  const [res] = await Promise.all([
    page.waitForResponse(isMutatePost),
    target.evaluate((el) => (el as HTMLElement).blur()),
  ]);
  return res;
}
