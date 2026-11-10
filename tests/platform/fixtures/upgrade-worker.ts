import { CloudflareKvStorageAdapter } from "test:kv-adapter";
import { CloudflareDurableStorageAdapter } from "test:durable-adapter";
export { CaretCmsContent } from "test:durable-object";
import { publishOverlay } from "../../../packages/core/dist/runtime/publish.js";

// Test-only entrypoint. The compiler selects either frozen release code or the
// current distribution; both use the same binding/class/persistence identity.
const methods = new Set(["writeEntry", "deleteEntry", "getEntry", "getEntrySnapshot", "getRevision", "bumpRevision",
  "getHistory", "appendHistory", "createCollection", "deleteCollection", "getCollectionMetadata", "listEntryIds",
  "discoverCollections", "getRebuildReceipt", "setRebuildReceipt", "getDeploymentTarget", "setDeploymentTarget", "commitEntries"]);

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { provider: string; instance: string; prefix?: string; editor?: string;
        session?: string; method: string; args?: unknown[]; coordinated?: boolean; bundled?: boolean };
      const base = body.provider === "kv"
        ? new CloudflareKvStorageAdapter({ keyPrefix: body.prefix ?? "", bundledFallback: body.bundled === true })
        : new CloudflareDurableStorageAdapter({ instanceName: body.instance, bundledFallback: body.bundled === true,
          editorDrafts: body.coordinated ? "coordinated" : "separate" });
      let storage = body.editor ? await base.makeEditorOverlay(body.editor) : base;
      if (body.session) storage = await storage.makeSessionOverlay(body.session);
      if (new URL(request.url).pathname === "/publish") {
        if (!body.editor) return new Response("Editor required", { status: 400 });
        return Response.json(await publishOverlay(base, storage));
      }
      if (!methods.has(body.method)) return new Response("Unknown method", { status: 400 });
      const callable = storage[body.method as keyof typeof storage];
      if (typeof callable !== "function") return new Response("Unsupported method", { status: 400 });
      const value = await callable.apply(storage, body.args ?? []);
      return Response.json({ value: value ?? null });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
