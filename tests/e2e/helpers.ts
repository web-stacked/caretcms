import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Frame, type FrameLocator, type Locator, type Page, type Response } from "@playwright/test";

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

/** The Studio lives in the editor's on-page drawer; this is its frame. */
export const STUDIO_PANEL = "#cms-studio-panel";
const STUDIO_IFRAME = `${STUDIO_PANEL} iframe`;

/**
 * Open a Studio route the way an editor does from a bookmark or the address
 * bar: the server sends the browser to the site page the route belongs to,
 * where the Studio opens over it, expanded. Waits for the drawer and its frame
 * and returns the frame, so a test reads `studio.locator(...)` where it used to
 * read `page.locator(...)`. The returned locator re-resolves the frame, so it
 * keeps working when the page behind it reloads after a create or delete.
 */
export async function openStudio(page: Page, route = "/admin/cms"): Promise<FrameLocator> {
  await hideAstroDevToolbar(page);
  await page.goto(route);
  await expect(page.locator(`${STUDIO_PANEL}.open.expanded`)).toBeVisible();
  await waitForStudioLoad(page);
  return page.frameLocator(STUDIO_IFRAME);
}

const quietPages = new WeakSet<Page>();

/**
 * `astro dev` pins its own toolbar to the bottom centre of every page, above
 * the expanded Studio, where it takes clicks meant for the Studio's frame
 * (Playwright's hit check doesn't see across the frame boundary). It isn't
 * part of CaretCMS and doesn't exist in builds, so Studio tests hide it.
 */
async function hideAstroDevToolbar(page: Page): Promise<void> {
  if (quietPages.has(page)) return;
  quietPages.add(page);
  // An inline style on the element itself: no <style> a page's CSP would refuse.
  await page.addInitScript(() => {
    const hide = () => document.querySelectorAll<HTMLElement>("astro-dev-toolbar")
      .forEach((toolbar) => toolbar.style.setProperty("display", "none", "important"));
    new MutationObserver(hide).observe(document, { childList: true, subtree: true });
  });
}

/** The Studio drawer's frame, for frame-scoped work (`evaluate`, URLs, reloads). */
export async function studioFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const frame = await (await page.locator(STUDIO_IFRAME).elementHandle({ timeout: 1_000 }))?.contentFrame();
      if (frame && !frame.isDetached() && frame.url().startsWith("http")) return frame;
    } catch { /* the page behind is reloading */ }
    if (Date.now() > deadline) throw new Error("The Studio drawer has no frame");
    await page.waitForTimeout(100);
  }
}

/** Wait for the drawer's frame to finish loading its current route. */
export async function waitForStudioLoad(page: Page): Promise<void> {
  // The loading cover fades out (opacity) once the frame reports load.
  await expect(page.locator(`${STUDIO_PANEL} .cms-studio-panel-loading`)).toHaveAttribute("hidden", /.*/);
  await (await studioFrame(page)).waitForLoadState("load");
}

/** Path and query the Studio frame shows, or "" while it's being replaced. */
export async function studioPath(page: Page): Promise<string> {
  try {
    const url = new URL((await studioFrame(page)).url());
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

/**
 * The Studio frame's address: a string is its exact path (and query), a regex
 * is tested against the full URL — as `expect(page).toHaveURL` was for the
 * Studio as a page.
 */
export async function expectStudioURL(page: Page, expected: string | RegExp): Promise<void> {
  if (typeof expected === "string") {
    await expect.poll(() => studioPath(page)).toBe(expected);
    return;
  }
  await expect.poll(async () => {
    try { return (await studioFrame(page)).url(); } catch { return ""; }
  }).toMatch(expected);
}

/** Reload the Studio inside the drawer (the page behind it stays). */
export async function reloadStudio(page: Page): Promise<void> {
  const frame = await studioFrame(page);
  await frame.goto(frame.url());
  await waitForStudioLoad(page);
}
