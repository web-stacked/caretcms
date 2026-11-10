import { CloudflareDurableStorageAdapter, CloudflareKvStorageAdapter, R2UploadHandler } from "@caretcms/cloudflare";
import { runStorageConformance } from "@caretcms/core/testing/storage";
import { env } from "cloudflare:workers";
export { CaretCmsContent } from "@caretcms/cloudflare/durable-object";

export default {
  async fetch() {
    const conformance = {};
    for (const provider of ["kv", "durable", "coordinated"]) {
      let number = 0;
      conformance[provider] = await runStorageConformance(async () => {
        const identity = `${provider}-${number++}`;
        const create = () => provider === "kv"
          ? new CloudflareKvStorageAdapter({ keyPrefix: `${identity}:`, bundledFallback: false })
          : new CloudflareDurableStorageAdapter({ instanceName: identity, bundledFallback: false,
            editorDrafts: provider === "coordinated" ? "coordinated" : "separate" });
        return { adapter: create(), reopen: async () => create() };
      });
    }
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), character => character.charCodeAt(0));
    const uploaded = await new R2UploadHandler({ publicBaseUrl: "https://assets.artifacts.test" })
      .upload(new File([png], "artifact.png", { type: "image/png" }));
    const object = await env.CMS_R2.get(new URL(uploaded.url).pathname.slice(1));
    const stored = new Uint8Array(await object.arrayBuffer());
    return Response.json({ conformance, upload: stored.length === png.length && stored.every((byte, n) => byte === png[n]),
      contentType: object.httpMetadata.contentType });
  },
};
