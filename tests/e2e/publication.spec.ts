import { expect, test, type Page } from "@playwright/test";
import { fetchAnonymousHtml, loginAsEditor, resetCmsStorage } from "./helpers";

test.beforeEach(async ({ page }) => {
  resetCmsStorage();
  await loginAsEditor(page);
});

async function writeEntry(page: Page, published: boolean) {
  const response = await page.request.post("/api/cms/mutate", {
    headers: { "x-caret-request": "1" },
    data: {
      type: "put_entry",
      collection: "studio-fixture",
      id: "reversible-entry",
      data: { title: "Reversible entry", published },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test("unpublishing hides an entry publicly without deleting it and allows republishing", async ({ page }) => {
  await writeEntry(page, true);
  expect(await fetchAnonymousHtml("/publication")).toContain("Reversible entry");

  await page.goto("/admin/cms/studio-fixture/reversible-entry");
  const publication = page.getByRole("switch", { name: "Published" });
  await expect(publication).toHaveAttribute("aria-checked", "true");
  await expect(publication.locator("xpath=..").locator(".caret-field-help"))
    .toContainText("remove the entry from the public site without deleting it");

  await publication.click();
  await expect(publication).toHaveAttribute("aria-checked", "false");
  const unpublish = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#btn-save").click();
  expect((await unpublish).ok()).toBe(true);
  expect(await fetchAnonymousHtml("/publication")).not.toContain("Reversible entry");

  await page.goto("/publication");
  await expect(page.locator('[data-entry-id="reversible-entry"]')).toHaveText("Reversible entry");

  const stored = await page.request.get("/api/cms/entries?collection=studio-fixture&id=reversible-entry");
  expect(stored.ok()).toBe(true);
  expect(await stored.json()).toMatchObject({
    entries: [{ id: "reversible-entry", data: { published: false } }],
  });

  await page.goto("/admin/cms/studio-fixture/reversible-entry");
  const republishToggle = page.getByRole("switch", { name: "Published" });
  await republishToggle.click();
  const republish = page.waitForResponse((response) =>
    response.url().includes("/api/cms/mutate") && response.request().method() === "POST",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#btn-save").click();
  expect((await republish).ok()).toBe(true);
  expect(await fetchAnonymousHtml("/publication")).toContain("Reversible entry");
});
