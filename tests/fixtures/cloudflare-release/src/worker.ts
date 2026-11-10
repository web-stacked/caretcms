import { handle } from "@astrojs/cloudflare/handler";
import { CaretCmsContent as BaseContent } from "gate:object-base";
import { CloudflareDurableStorageAdapter } from "gate:durable-adapter";
import { CloudflareKvStorageAdapter } from "gate:kv-adapter";
import { publishOverlay } from "../../../../packages/core/src/runtime/publish";

type GateEnv = { CARET_GATE_TOKEN?: string; CARET_GATE_BUILD?: string; CMS_CONTENT: DurableObjectNamespace };
let boot: string | undefined;

// A dedicated protected deployment, never the demo/starter Worker. This class
// keeps the production protocol and adds a read-only test inspection endpoint.
export class CaretCmsContent extends BaseContent {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__gate/inspect") {
      return Response.json({ keys: [...(await this.ctx.storage.list()).keys()], alarm: await this.ctx.storage.getAlarm() });
    }
    return super.fetch(request);
  }
}

async function authorized(request: Request, token?: string): Promise<boolean> {
  const supplied = request.headers.get("authorization");
  if (!token || !/^[a-f0-9]{64}$/.test(token) || !supplied || supplied.length > 80) return false;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(supplied), digest(`Bearer ${token}`)]);
  let difference = 0;
  for (let n = 0; n < left.length; n++) difference |= left[n]! ^ right[n]!;
  return difference === 0;
}

const methods = new Set(["writeEntry", "getEntry", "getRevision", "bumpRevision", "appendHistory", "getHistory",
  "createCollection", "deleteCollection", "listEntryIds", "discoverCollections", "getCollectionMetadata",
  "getRebuildReceipt", "setRebuildReceipt", "getDeploymentTarget", "setDeploymentTarget", "commitEntries"]);

export default {
  async fetch(request: Request, env: GateEnv, ctx: ExecutionContext): Promise<Response> {
    if (!(await authorized(request, env.CARET_GATE_TOKEN))) return new Response("Forbidden", { status: 403 });
    const path = new URL(request.url).pathname;
    if (path === "/__gate/info") return Response.json({ build: env.CARET_GATE_BUILD, boot: boot ??= crypto.randomUUID(), colo: request.cf?.colo ?? "local" },
      { headers: { "cache-control": "private, no-store" } });
    if (path.startsWith("/__gate/")) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        const body = await request.json() as { provider: string; instance?: string; prefix?: string; editor?: string;
          session?: string; coordinated?: boolean; ttl?: number; method: string; args?: unknown[] };
        const instance = body.instance ?? "recovery";
        if (!["primary", "recovery", "expiry"].includes(instance)) return new Response("Unknown test instance", { status: 400 });
        const base = body.provider === "kv"
          ? new CloudflareKvStorageAdapter({ keyPrefix: body.prefix ?? "", bundledFallback: false, expirationTtl: body.ttl })
          : new CloudflareDurableStorageAdapter({ instanceName: instance, bundledFallback: false,
            editorDrafts: body.coordinated ? "coordinated" : "separate" }, body.ttl);
        if (path === "/__gate/inspect") {
          const stub = env.CMS_CONTENT.get(env.CMS_CONTENT.idFromName(instance));
          return stub.fetch("https://gate.test/__gate/inspect");
        }
        let storage = body.editor ? await base.makeEditorOverlay(body.editor) : base;
        if (body.session) storage = await storage.makeSessionOverlay(body.session);
        if (path === "/__gate/publish" && body.editor) return Response.json(await publishOverlay(base, storage));
        if (path !== "/__gate/storage" || !methods.has(body.method)) return new Response("Unknown test method", { status: 400 });
        const callable = storage[body.method as keyof typeof storage];
        if (typeof callable !== "function") return new Response("Unsupported method", { status: 400 });
        const value = await callable.apply(storage, body.args ?? []);
        return Response.json({ value: value ?? null }, { headers: { "cache-control": "private, no-store" } });
      } catch {
        return Response.json({ error: "Validation operation failed" }, { status: 500 });
      }
    }
    return handle(request, env, ctx);
  },
};
