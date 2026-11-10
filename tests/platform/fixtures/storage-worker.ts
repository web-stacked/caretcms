import { SessionOverlayAdapter } from "../../../packages/core/dist/runtime/storage/session-overlay-adapter.js";
import type { StorageAdapter } from "@caretcms/core";
import { CloudflareDurableStorageAdapter } from "../../../packages/cloudflare/dist/adapters/durable-storage.js";
import { CloudflareKvStorageAdapter } from "../../../packages/cloudflare/dist/adapters/kv-storage.js";
import { CaretCmsContent } from "@caretcms/cloudflare/durable-object";
import { runStorageConformance } from "@caretcms/core/testing/storage";
import { handleDurableStorageRequest } from "../../../packages/cloudflare/dist/durable-storage-protocol.js";

// Test-only controls. This Worker is never used by an example or deployed.
export class TestCaretCmsContent extends CaretCmsContent {
  private readonly instanceToken = crypto.randomUUID();
  private fault: string | null = null;
  private failureWrites = 0;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/inspect") {
      return Response.json({ instanceToken: this.instanceToken, failureWrites: this.failureWrites,
        alarm: await this.ctx.storage.getAlarm(), keys: [...(await this.ctx.storage.list()).keys()] });
    }
    if (path === "/arm") {
      this.fault = await request.text();
      return Response.json({ ok: true });
    }
    const command = await request.clone().json() as { type: string };
    if (["commit_entries", "commit_draft_entries"].includes(command.type) && this.fault) {
      const fault = this.fault;
      this.fault = null;
      if (fault === "rollback") {
        const storage = this.ctx.storage;
        return handleDurableStorageRequest({
          get: storage.get.bind(storage), put: storage.put.bind(storage),
          delete: storage.delete.bind(storage), deleteAll: storage.deleteAll.bind(storage),
          transaction: task => storage.transaction(async txn => {
            let writes = 0;
            return task({ get: txn.get.bind(txn), delete: txn.delete.bind(txn),
              put: async (key, value) => {
                await txn.put(key, value);
                this.failureWrites = ++writes;
                // First entry's data/version/history and the next entry's data
                // have been written before the enclosing transaction fails.
                if (writes === 8) throw new Error("Injected transaction failure after persisted writes");
              } });
          }),
        }, request);
      }
      if (fault === "lost-ack") {
        const response = await super.fetch(request);
        if (!response.ok) return response;
        await response.arrayBuffer();
        return Response.json({ error: "Injected lost acknowledgement" }, { status: 503 });
      }
    }
    return super.fetch(request);
  }
}

function adapter(provider: string, instance: string, ttl?: number, coordinated = false) {
  return provider === "kv"
    ? new CloudflareKvStorageAdapter({ keyPrefix: `${instance}:`, bundledFallback: false, expirationTtl: ttl })
    : new CloudflareDurableStorageAdapter({ instanceName: instance, bundledFallback: false, editorDrafts: coordinated ? "coordinated" : "separate" }, ttl);
}

const methods = new Set(["writeEntry", "getEntry", "getEntrySnapshot", "getEntrySnapshots", "deleteEntry", "getRevision", "bumpRevision",
  "getHistory", "appendHistory", "commitEntries", "discoverCollections", "listEntryIds", "createCollection",
  "deleteCollection", "getCollectionMetadata", "getRebuildReceipt", "setRebuildReceipt"]);

export default {
  async fetch(request: Request, env: { CMS_CONTENT: DurableObjectNamespace; CMS_KV: KVNamespace }): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json() as { provider: string; instance: string; method?: string; args?: unknown[];
      ttl?: number; editor?: string; session?: string; fault?: string; coordinated?: boolean; view?: boolean; raceRecovery?: boolean; raceChanges?: Parameters<CloudflareDurableStorageAdapter["commitEntries"]>[0] };
    if (url.pathname === "/conformance") {
      return Response.json(await runStorageConformance(async name => {
        const instance = `${body.instance}:${name}`;
        return { adapter: adapter(body.provider, instance, undefined, body.coordinated), reopen: async () => adapter(body.provider, instance, undefined, body.coordinated) };
      }));
    }
    if (url.pathname === "/inspect" || url.pathname === "/arm") {
      const stub = env.CMS_CONTENT.get(env.CMS_CONTENT.idFromName(body.instance));
      return stub.fetch(`https://storage.test${url.pathname}`, { method: "POST", body: body.fault ?? "" });
    }
    if (url.pathname === "/kv-keys") {
      return Response.json(await env.CMS_KV.list({ prefix: `${body.instance}:` }));
    }
    if (!body.method || !methods.has(body.method)) return new Response("Unknown method", { status: 400 });
    try {
      const base = adapter(body.provider, body.instance, body.ttl, body.coordinated);
      let storage: StorageAdapter = base;
      if (body.editor) {
        const raw = await base.makeEditorOverlay(body.editor);
        if (body.raceChanges || body.raceRecovery) {
          const coordinator = raw.coordinateDrafts?.(base);
          if (!coordinator) throw new Error("Missing draft coordinator");
          raw.coordinateDrafts = () => ({ ...coordinator, commitEntries: async (changes, baselines, guards) => {
            if (body.raceChanges) {
              const changed = await adapter(body.provider, body.instance).commitEntries(body.raceChanges);
              if (!changed.ok) throw new Error("Test base race failed");
            }
            if (body.raceRecovery) {
              const { collection, id } = changes[0];
              const existing = await raw.getEntry(collection, id);
              if (!existing) throw new Error("Missing test draft");
              await raw.writeEntry(collection, id, { ...existing.data, __caret_publish__: { version: 1 } });
            }
            return coordinator.commitEntries(changes, baselines, guards);
          } });
        }
        storage = body.view ? new SessionOverlayAdapter(base, raw) : raw;
      }
      if (body.session) storage = await storage.makeSessionOverlay!(body.session);
      const callable = storage[body.method as keyof typeof storage] as (...args: unknown[]) => Promise<unknown>;
      const value = await callable.apply(storage, body.args ?? []);
      return Response.json({ value: value ?? null });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
