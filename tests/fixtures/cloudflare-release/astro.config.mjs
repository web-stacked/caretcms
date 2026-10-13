import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import caret, { defineStorageProvider, defineUploadProvider } from "@caretcms/core";
import { fileURLToPath } from "node:url";

const released = process.env.CARET_GATE_STAGE === "released";
const source = relative => fileURLToPath(new URL(relative, import.meta.url));
const legacy = "../upgrade/cloudflare-v0.5.0/packages/cloudflare/src/";

export default defineConfig({
  output: "server",
  outDir: `./dist/${released ? "released" : "current"}`,
  adapter: cloudflare({ sessionKVBindingName: "CMS_KV" }),
  vite: { resolve: { alias: {
    "gate:durable-adapter": released ? source(`${legacy}adapters/durable-storage.ts`) : source("../../../packages/cloudflare/src/adapters/durable-storage.ts"),
    "gate:kv-adapter": released ? source(`${legacy}adapters/kv-storage.ts`) : source("../../../packages/cloudflare/src/adapters/kv-storage.ts"),
    "gate:object-base": released ? source(`${legacy}durable-object.ts`) : source("../../../packages/cloudflare/src/durable-object.ts"),
  } } },
  integrations: [caret({
    delivery: "server",
    storage: defineStorageProvider({ entrypoint: source("./src/providers.ts"), exportName: "storage",
      options: { instanceName: "primary", editorDrafts: released ? "separate" : "coordinated" } }),
    uploads: defineUploadProvider({ entrypoint: source("./src/providers.ts"), exportName: "uploads" }),
    schemas: { pages: { type: "object", required: ["title"], properties: { title: { type: "string" } } } },
  })],
});
