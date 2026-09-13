import { describe, expect, it } from "vitest";
import { GET } from "../../packages/core/src/runtime/routes/entries";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { ContentReadError } from "../../packages/core/src/runtime/content-errors";

function get(adapter: InMemoryAdapter, query: string) {
  return runWithRequestContext({ adapter, uploadHandler: {} as never, sessionId: "demo", demoMode: true, overlayActive: true },
    () => GET({ request: new Request(`http://localhost/api/cms/entries?collection=posts&${query}`), cookies: { get: () => undefined } } as never));
}

describe("collection reads", () => {
  it("pages all entries and searches the displayed title beyond the first page", async () => {
    const adapter = new InMemoryAdapter();
    for (let i = 1; i <= 30; i++) await adapter.writeEntry("posts", String(i).padStart(2, "0"), { title: i === 30 ? "Distant lighthouse" : `Post ${i}` });
    const first = await (await get(adapter, "")).json();
    const second = await (await get(adapter, "page=2")).json();
    expect(first.entries).toHaveLength(24);
    expect(second.entries).toHaveLength(6);
    expect(second.pagination).toMatchObject({ total: 30, page: 2, hasPrev: true, hasNext: false });
    expect(new Set([...first.entries, ...second.entries].map(e => e.id)).size).toBe(30);
    const search = await (await get(adapter, "q=LIGHTHOUSE&page=9")).json();
    expect(search.entries.map(e => e.id)).toEqual(["30"]);
    expect(search.pagination).toMatchObject({ total: 1, page: 1 });
    expect((await (await get(adapter, "q=absent")).json()).pagination.total).toBe(0);
  });

  it.each(["unsupported_content", "invalid_content", "storage_error"] as const)("distinguishes %s from missing content and isolates unreadable cards", async code => {
    class BrokenEntry extends InMemoryAdapter {
      override async getEntry(collection: string, id: string) {
        if (id === "broken") throw new ContentReadError(code);
        return super.getEntry(collection, id);
      }
    }
    const adapter = new BrokenEntry();
    await adapter.writeEntry("posts", "good", { title: "Readable" });
    await adapter.writeEntry("posts", "broken", { title: "Unreadable" });
    const single = await get(adapter, "id=broken");
    expect(single.status).toBe(code === "storage_error" ? 503 : 422);
    expect(await single.json()).toMatchObject({ code });
    expect((await (await get(adapter, "id=missing")).json()).entries).toEqual([]);
    const list = await (await get(adapter, "")).json();
    expect(list.entries).toHaveLength(2);
    expect(list.entries.find(e => e.id === "broken")).toMatchObject({ readError: { code } });
    expect(list.entries.find(e => e.id === "good").data.title).toBe("Readable");
  });
});

it("creation cannot replace an unseen revision-zero entry", async () => {
  const { executeMutation } = await import("../../packages/core/src/runtime/mutations/engine");
  const adapter = new InMemoryAdapter();
  await adapter.writeEntry("posts", "existing", { title: "Seed" });
  const input = { type: "put_entry", collection: "posts", id: "existing", data: { title: "Replacement" }, createOnly: true };
  expect(await executeMutation(adapter, input)).toMatchObject({ ok: false, status: 409 });
  expect((await adapter.getEntry("posts", "existing"))?.data.title).toBe("Seed");
  expect((await executeMutation(adapter, { ...input, id: "new" })).ok).toBe(true);
});
