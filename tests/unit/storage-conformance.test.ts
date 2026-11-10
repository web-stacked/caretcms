import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { FilesystemAdapter } from "../../packages/core/src/runtime/storage/filesystem-adapter";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { runStorageConformance, type StorageConformanceFixture } from "../../packages/core/src/testing/storage-conformance";
import { MemoryKV, MemoryDurableNamespace } from "../helpers/storage-fakes";
import type { StorageAdapter } from "../../packages/core/src/types";

const env = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../packages/cloudflare/src/runtime/env.js", () => ({ getCloudflareRuntimeEnv: async () => env.current }));
import { CloudflareKvStorageAdapter } from "../../packages/cloudflare/src/adapters/kv-storage";
import { CloudflareDurableStorageAdapter } from "../../packages/cloudflare/src/adapters/durable-storage";

const providers = ["memory", "filesystem", "markdown", "kv", "durable"] as const;
type Provider = typeof providers[number];
async function fixture(provider: Provider): Promise<StorageConformanceFixture> {
  if (provider === "memory") return { adapter: new InMemoryAdapter() };
  if (provider === "kv") {
    env.current = { CMS_KV: new MemoryKV() };
    const open = () => new CloudflareKvStorageAdapter({ bundledFallback: false });
    return { adapter: open(), reopen: async () => open() };
  }
  if (provider === "durable") {
    env.current = { CMS_CONTENT: new MemoryDurableNamespace() };
    const open = () => new CloudflareDurableStorageAdapter({ bundledFallback: false });
    return { adapter: open(), reopen: async () => open() };
  }
  const root = await mkdtemp(join(tmpdir(), "caret-conformance-"));
  const open = () => provider === "filesystem"
    ? new FilesystemAdapter({ dataRoot: join(root, "data"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") })
    : new MarkdownAdapter({ contentRoot: join(root, "content"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") });
  return { adapter: open(), reopen: async () => open(), dispose: () => rm(root, { recursive: true, force: true }) };
}

describe.each(providers)("%s shared storage contract", provider => {
  it("passes every applicable conformance check", async () => {
    const results = await runStorageConformance(() => fixture(provider));
    expect(results.filter(result => result.status === "failed")).toEqual([]);
    expect(results).toHaveLength(14);
    expect(results.filter(result => result.status === "skipped").length).toBe(provider === "durable" ? 1 : provider === "filesystem" ? 3 : 4);
  });
  if (provider !== "markdown") it("rejects a stale conditional save after collection deletion and recreation", async () => {
    const f = await fixture(provider), a = f.adapter;
    try {
      expect(await executeMutation(a, { type: "put_entry", collection: "aba", id: "one", data: { title: "Original" }, expectedRevision: 0 })).toMatchObject({ ok: true, body: { revision: 1 } });
      await a.deleteCollection("aba");
      await a.createCollection({ id: "aba", label: "ABA", created_at: 1, updated_at: 1, schema: { type: "object", properties: {} } });
      expect((await executeMutation(a, { type: "put_entry", collection: "aba", id: "one", data: { title: "Recreated" }, expectedRevision: await a.getRevision("aba", "one") })).ok).toBe(true);
      const revision = await a.getRevision("aba", "one"), history = await a.getHistory("aba", "one");
      expect(await executeMutation(a, { type: "put_entry", collection: "aba", id: "one", data: { title: "Stale" }, expectedRevision: 1 }))
        .toMatchObject({ ok: false, status: 409, body: { currentRevision: revision } });
      expect((await a.getEntry("aba", "one"))?.data).toEqual({ title: "Recreated" });
      expect(await a.getHistory("aba", "one")).toEqual(history);
    } finally { await f.dispose?.(); }
  });
});

describe("conservative overlay guarantees", () => {
  it.each(["durable", "kv"] as const)("distinguishes expiring sessions from durable editor drafts for %s", async provider => {
    const f = await fixture(provider);
    expect((await f.adapter.makeSessionOverlay!("session")).guarantees?.persistence).toBe("expiring");
    expect((await f.adapter.makeEditorOverlay!("alice")).guarantees?.persistence).toBe("durable");
  });
  it.each(["durable", "kv"] as const)("does not imply atomic base/draft comparison from %s method presence", async provider => {
    const f = await fixture(provider);
    const overlay = new SessionOverlayAdapter(f.adapter, await f.adapter.makeEditorOverlay!("alice"));
    expect(typeof overlay.commitEntries).toBe("function");
    expect(overlay.guarantees?.commits).toBe(provider === "durable" ? "process" : "single-writer");
    expect(overlay.guarantees?.snapshots).toBe(provider === "durable" ? "process" : "eventual");
    expect(overlay.guarantees?.persistence).toBe("durable");
  });
  it("leaves undeclared custom guarantees unspecified", () => {
    const a = { ...new InMemoryAdapter() } as unknown as StorageAdapter;
    delete (a as { guarantees?: unknown }).guarantees;
    expect(new SessionOverlayAdapter(a, new InMemoryAdapter()).guarantees).toBeUndefined();
  });
});
