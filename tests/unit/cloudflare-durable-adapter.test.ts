import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableStorageLike, DurableStorageTxn } from "../../packages/cloudflare/src/durable-storage-protocol";
import { handleDurableStorageRequest } from "../../packages/cloudflare/src/durable-storage-protocol";

class MemoryDurableStorage implements DurableStorageLike {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  transaction<T>(task: (txn: DurableStorageTxn) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => task(this));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

class MemoryDurableNamespace {
  readonly stores = new Map<string, MemoryDurableStorage>();
  idFromName(name: string): string { return name; }
  get(id: unknown) {
    const name = String(id);
    let storage = this.stores.get(name);
    if (!storage) {
      storage = new MemoryDurableStorage();
      this.stores.set(name, storage);
    }
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return handleDurableStorageRequest(storage!, request);
      },
    };
  }
}

const { namespaceRef } = vi.hoisted(() => ({
  namespaceRef: { current: null as MemoryDurableNamespace | null },
}));

vi.mock("../../packages/cloudflare/src/runtime/env.js", () => ({
  getCloudflareRuntimeEnv: async () => namespaceRef.current
    ? { CMS_CONTENT: namespaceRef.current }
    : null,
}));

import { CloudflareDurableStorageAdapter } from "../../packages/cloudflare/src/adapters/durable-storage";

function adapter(instanceName = "test"): CloudflareDurableStorageAdapter {
  return new CloudflareDurableStorageAdapter({ instanceName, bundledFallback: false });
}

describe("CloudflareDurableStorageAdapter", () => {
  beforeEach(() => {
    namespaceRef.current = new MemoryDurableNamespace();
  });

  it("keeps entry, revision, history, and index in one commit", async () => {
    const storage = adapter();
    const result = await storage.commitEntries([{
      collection: "pages", id: "home", expectedRevision: 0, expectedExists: false,
      data: { title: "Hello" }, history: { ts: 1, action: "put", data: null },
    }]);

    expect(result).toEqual({ ok: true, revisions: [{ collection: "pages", id: "home", revision: 1 }] });
    expect(await storage.getEntry("pages", "home")).toEqual({ id: "home", data: { title: "Hello" } });
    expect(await storage.getRevision("pages", "home")).toBe(1);
    expect(await storage.getHistory("pages", "home")).toEqual([{ ts: 1, action: "put", data: null }]);
    expect(await storage.listEntryIds("pages")).toEqual(["home"]);
    expect(await storage.discoverCollections()).toEqual(["pages"]);
  });

  it("lets exactly one independent client win the same revision", async () => {
    const first = adapter();
    const second = adapter();
    const changes = (title: string) => [{
      collection: "pages", id: "home", expectedRevision: 0, expectedExists: false,
      data: { title }, history: { ts: title === "A" ? 1 : 2, action: "put", data: null },
    }] as const;

    const results = await Promise.all([
      first.commitEntries(changes("A")),
      second.commitEntries(changes("B")),
    ]);

    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    expect(await first.getRevision("pages", "home")).toBe(1);
    expect(await first.getHistory("pages", "home")).toHaveLength(1);
    expect(["A", "B"]).toContain((await first.getEntry("pages", "home"))?.data.title);
  });

  it("preserves both collection-index additions from concurrent clients", async () => {
    const first = adapter();
    const second = adapter();
    const [a, b] = await Promise.all([
      first.commitEntries([{ collection: "posts", id: "a", expectedRevision: 0, expectedExists: false, data: { order: 0 } }]),
      second.commitEntries([{ collection: "posts", id: "b", expectedRevision: 0, expectedExists: false, data: { order: 1 } }]),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await first.listEntryIds("posts")).toEqual(["a", "b"]);
  });

  it("rejects a stale batch without partially reordering it", async () => {
    const first = adapter();
    const second = adapter();
    await first.commitEntries([
      { collection: "posts", id: "a", expectedRevision: 0, expectedExists: false, data: { order: 0 } },
      { collection: "posts", id: "b", expectedRevision: 0, expectedExists: false, data: { order: 1 } },
    ]);
    await second.commitEntries([
      { collection: "posts", id: "b", expectedRevision: 1, expectedExists: true, data: { order: 2 } },
    ]);

    const stale = await first.commitEntries([
      { collection: "posts", id: "a", expectedRevision: 1, expectedExists: true, data: { order: 2 } },
      { collection: "posts", id: "b", expectedRevision: 1, expectedExists: true, data: { order: 0 } },
    ]);

    expect(stale).toMatchObject({ ok: false, conflict: { id: "b", currentRevision: 2 } });
    expect((await first.getEntry("posts", "a"))?.data.order).toBe(0);
    expect((await first.getEntry("posts", "b"))?.data.order).toBe(2);
  });

  it("isolates editor objects and refreshes a session object's expiry alarm", async () => {
    const base = adapter();
    const alice = await base.makeEditorOverlay!("alice");
    const bob = await base.makeEditorOverlay!("bob");
    await alice.writeEntry("pages", "home", { title: "Alice" });
    expect(await bob.getEntry("pages", "home")).toBeNull();

    const session = await base.makeSessionOverlay!("session-1");
    await session.writeEntry("pages", "home", { title: "Temporary" });
    expect(namespaceRef.current!.stores.get("test:session:session-1")!.alarm).toBeGreaterThan(Date.now());
  });

  it("persists and clears the latest deployment target", async () => {
    const storage = adapter();
    const target = {
      id: "deploy-do", requestedAt: 10, commit: "abc",
      published: [{ collection: "pages", id: "home", revision: 2, deleted: false }],
    };
    await storage.setDeploymentTarget(target);
    expect(await storage.getDeploymentTarget()).toEqual(target);
    await storage.setDeploymentTarget(null);
    expect(await storage.getDeploymentTarget()).toBeNull();
  });

  it("keeps a deleted collection closed against a stale bundled seed commit", async () => {
    const storage = adapter();
    await storage.createCollection({ id: "pages", label: "Pages", created_at: 1, updated_at: 1,
      schema: { type: "object", properties: {} } });
    await storage.deleteCollection("pages");

    const namespace = namespaceRef.current!;
    const durable = namespace.get("test");
    const response = await durable.fetch("https://caretcms.internal/storage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "commit_entries", changes: [{
        collection: "pages", id: "home", expectedRevision: 0, expectedExists: true,
        data: { title: "stale" }, seedData: { title: "bundled" },
      }] }),
    });
    expect(await response.json()).toMatchObject({ ok: false, conflict: { exists: false } });
    expect(await storage.discoverCollections()).toEqual([]);
    expect(await storage.listEntryIds("pages")).toEqual([]);
  });
});
