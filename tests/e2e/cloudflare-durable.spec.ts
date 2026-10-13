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

test("Durable Object collection recreation preserves versions and rejects removed seed baselines", async ({ request }) => {
  const response = await request.get(`/collection-recreate?run=${crypto.randomUUID()}`);
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.removed).toEqual({ entry: null, revision: 2 });
  expect(result.recreated).toMatchObject({ ok: true, revisions: [{ revision: 3 }] });
  expect(result.stale).toMatchObject({ ok: false, conflict: { currentRevision: 3, exists: true } });
  expect(result.seedResult).toMatchObject({ ok: false, conflict: { currentRevision: 0, exists: false } });
  expect(result.current).toEqual({ entry: { id: "one", data: { title: "Recreated" } }, revision: 3 });
});

test("coordinated drafts reject a changed base then retry privately in the same Durable Object", async ({ request }) => {
  const response = await request.get(`/coordinated-draft?run=${crypto.randomUUID()}`);
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.raced).toMatchObject({ ok: false, conflict: { currentRevision: 0, currentBaseRevision: 2 } });
  expect(result.retry).toMatchObject({ ok: true, revisions: [{ revision: 1 }] });
  expect(result.published).toEqual({ entry: { id: "one", data: { title: "Other writer" } }, revision: 2 });
  expect(result.private).toEqual({ entry: { id: "one", data: { title: "Private draft" } }, revision: 1 });
  expect(result.otherEditor).toBeNull();
});
