import { test, expect } from "@playwright/test";
import {
  blurToSave,
  fetchAnonymousHtml,
  loginAsEditor,
  replaceText,
  resetCmsStorage,
} from "./helpers";

/**
 * Proves the FULL chain for a binding produced by `caretize` (not a hand-
 * authored one): the <h2> below was tagged by running `caretize` on the
 * starter, which emitted a full-triple `data-caret="pages::home::
 * our_teaching_philosophy"`. This test confirms the editor activates that
 * binding, saves an edit through it, and the rewrite middleware serves the new
 * value to anonymous visitors.
 */
const SEL = 'h2[data-caret="pages::home::our_teaching_philosophy"]';
const TEMPLATE = "Our Teaching Philosophy";

test.beforeEach(() => {
  resetCmsStorage();
});

test("a caretize-tagged element is editable and its edit persists", async ({ page }) => {
  const NEW = "Edited through a caretize-generated binding";

  await loginAsEditor(page);
  await page.goto("/");

  const h2 = page.locator(SEL);
  // The editor mounted and activated the caretize-produced binding.
  await expect(h2).toHaveClass(/cms-editable/);
  await expect(h2).toHaveText(TEMPLATE);

  await replaceText(page, h2, NEW);
  await expect(h2).toHaveText(NEW);

  // Blur triggers save through the full-triple binding → mutate endpoint.
  const mutate = await blurToSave(page, h2);
  expect(mutate.ok()).toBeTruthy();
  await expect(page.getByText("Content saved")).toBeVisible();

  // The override is persisted and rendered by the rewrite middleware for an
  // anonymous visitor — the real end-to-end proof.
  const anon = await fetchAnonymousHtml("/");
  expect(anon).toContain(NEW);
  expect(anon).not.toContain(TEMPLATE);
});
