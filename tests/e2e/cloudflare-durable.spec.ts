import { expect, test } from "@playwright/test";

test("Durable Object commits survive concurrent browser-triggered Worker requests", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Run concurrency check" }).click();
  const result = page.locator("#result");
  await expect(result).not.toHaveText("idle");
  const data = JSON.parse(await result.textContent() ?? "null");

  expect(data.sameEntry.filter((item: { ok: boolean }) => item.ok)).toHaveLength(1);
  expect(data.sameEntry.filter((item: { ok: boolean }) => !item.ok)).toHaveLength(1);
  expect(data.sameEntryRevision).toBe(1);
  expect(data.sameEntryHistory).toHaveLength(1);
  expect(data.distinctEntries.every((item: { ok: boolean }) => item.ok)).toBe(true);
  expect(data.postIds).toEqual(["a", "b"]);
  expect(data.staleBatch).toMatchObject({ ok: false, conflict: { id: "b", currentRevision: 2 } });
  expect(data.postA.data.order).toBe(0);
  expect(data.postB.data.order).toBe(2);
  expect(data.retry).toMatchObject({ ok: false, conflict: { currentRevision: 1 } });
});
