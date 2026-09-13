import { describe, expect, it } from "vitest";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { registerCollectionStudioConfig } from "../../packages/core/src/runtime/schema-registry";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

describe("collection capability enforcement", () => {
  it("enforces singleton ids, deletion, creation, and ordering at the mutation boundary", async () => {
    const adapter = new InMemoryAdapter();
    adapter.preload("singleton-settings", [{ id: "global", data: { title: "Settings" } }]);
    registerCollectionStudioConfig("singleton-settings", {
      singletonId: "global",
      creatable: false,
      orderable: false,
      deletable: false,
    });

    const update = await executeMutation(adapter, {
      type: "put_entry",
      collection: "singleton-settings",
      id: "global",
      data: { title: "Updated" },
    });
    expect(update.ok).toBe(true);

    const wrongId = await executeMutation(adapter, {
      type: "put_entry",
      collection: "singleton-settings",
      id: "duplicate",
      data: { title: "Duplicate" },
    });
    expect(wrongId).toMatchObject({ ok: false, status: 403 });

    const deletion = await executeMutation(adapter, {
      type: "delete_entry",
      collection: "singleton-settings",
      id: "global",
    });
    expect(deletion).toMatchObject({ ok: false, status: 403 });

    const reorder = await executeMutation(adapter, {
      type: "reorder_entries",
      collection: "singleton-settings",
      items: [{ id: "global", order: 0 }],
    });
    expect(reorder).toMatchObject({ ok: false, status: 403 });

    const deleteCollection = await executeMutation(adapter, {
      type: "delete_collection",
      id: "singleton-settings",
    });
    expect(deleteCollection).toMatchObject({ ok: false, status: 403 });
  });

  it("allows a missing singleton to be initialized at its fixed id", async () => {
    const adapter = new InMemoryAdapter();
    registerCollectionStudioConfig("singleton-bootstrap", {
      singletonId: "profile",
      creatable: false,
      deletable: false,
    });

    const result = await executeMutation(adapter, {
      type: "put_entry",
      collection: "singleton-bootstrap",
      id: "profile",
      data: { title: "Profile" },
    });
    expect(result.ok).toBe(true);
  });

  it("requires an explicit boolean status for managed publication", async () => {
    const adapter = new InMemoryAdapter();
    registerCollectionStudioConfig("managed-publication", {
      publication: { field: "published" },
    });

    const missing = await executeMutation(adapter, {
      type: "put_entry",
      collection: "managed-publication",
      id: "first",
      data: { title: "First" },
    });
    expect(missing).toMatchObject({ ok: false, status: 400 });

    const draft = await executeMutation(adapter, {
      type: "put_entry",
      collection: "managed-publication",
      id: "first",
      data: { title: "First", published: false },
    });
    expect(draft.ok).toBe(true);
  });
});
