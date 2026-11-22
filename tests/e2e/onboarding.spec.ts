import { test, expect } from "@playwright/test";
import { EDIT_PASSWORD, loginAsEditor, resetCmsStorage } from "./helpers";

test.beforeEach(() => {
  resetCmsStorage();
});

test.describe("onboarding — post-login landing", () => {
  test("login defaults to the live site root, not the empty Studio", async ({
    page,
  }) => {
    // No explicit redirect → the server must fall back to `editorHome` ("/"),
    // landing the user on a real page with the inline editor instead of
    // /admin/cms ("No collections yet").
    const res = await page.request.post("/api/cms/auth/login", {
      data: { password: EDIT_PASSWORD },
      headers: { Accept: "application/json" },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { ok: boolean; redirect: string };
    expect(body.ok).toBe(true);
    expect(body.redirect).toBe("/");
  });

  test("an explicit same-origin redirect still wins", async ({ page }) => {
    const res = await page.request.post("/api/cms/auth/login", {
      data: { password: EDIT_PASSWORD, redirect: "/about" },
      headers: { Accept: "application/json" },
    });
    const body = (await res.json()) as { redirect: string };
    expect(body.redirect).toBe("/about");
  });
});

test.describe("onboarding — welcome reveal", () => {
  /** Sign in through the real form: it sets the welcome flag, then redirects to editorHome ("/"). */
  async function signInThroughForm(page: import("@playwright/test").Page) {
    await page.goto("/admin");
    await page.fill("#password", EDIT_PASSWORD);
    await Promise.all([
      page.waitForURL("/"),
      page.click("#login-form button[type=submit]"),
    ]);
  }

  test("the first sign-in in a browser outlines what can be edited and says how it works", async ({ page }) => {
    await signInThroughForm(page);
    const intro = page.getByText(/^Welcome\. Everything outlined can be changed/);
    await expect(intro).toBeVisible();
    // The outlines stay while the message is open…
    await page.waitForTimeout(3000);
    await expect(page.locator("body")).toHaveClass(/cms-highlight-all/);
    // …and go with it.
    await page.getByRole("button", { name: "Got it" }).click();
    await expect(intro).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/cms-highlight-all/);

    // Tools shows it again on request.
    await page.locator(".cms-tools-summary").click();
    await page.getByRole("button", { name: "How editing works" }).click();
    await expect(intro).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/cms-highlight-all/);
    await page.getByRole("button", { name: "Got it" }).click();
  });

  test("a later sign-in flashes every editable region, then fades", async ({
    page,
  }) => {
    await page.addInitScript(() => { try { localStorage.setItem("caret:intro:v1", "1"); } catch { /* ignored */ } });
    await signInThroughForm(page);
    await expect(page.getByText(/^Welcome\. Everything outlined/)).toHaveCount(0);

    // Editor mounts, then the reveal adds the highlight-all class…
    await expect(page.locator("body")).toHaveClass(/cms-highlight-all/);
    // …and it is ephemeral: it clears itself after the dwell (2.5s).
    await expect(page.locator("body")).not.toHaveClass(/cms-highlight-all/, {
      timeout: 5000,
    });

    // The editor consumes (removes) the flag, so the reveal is one-shot.
    const flag = await page.evaluate(() => sessionStorage.getItem("caret:welcome"));
    expect(flag).toBeNull();
  });

  test("no reveal without the welcome flag (normal navigation)", async ({
    page,
  }) => {
    await loginAsEditor(page);
    await page.goto("/");

    await expect(page.locator("body")).toHaveClass(/cms-edit-mode/);
    await expect(page.locator("body")).not.toHaveClass(/cms-highlight-all/);
  });
});
