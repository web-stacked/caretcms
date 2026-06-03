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
  test("first load after login flashes every editable region, then fades", async ({
    page,
  }) => {
    // Drive the real login form: it sets the welcome flag, then redirects to
    // editorHome ("/"), where the editor performs its one-time reveal on boot.
    await page.goto("/admin");
    await page.fill("#password", EDIT_PASSWORD);
    await Promise.all([
      page.waitForURL("/"),
      page.click("#login-form button[type=submit]"),
    ]);

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
