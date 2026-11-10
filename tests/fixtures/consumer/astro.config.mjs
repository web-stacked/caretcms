import { defineConfig } from "astro/config";
import caret, { filesystemStorage } from "@caretcms/core";

const serverMode = process.env.CARET_CONSUMER_SSR === "1";
const node = serverMode ? (await import("@astrojs/node")).default : null;

export default defineConfig({
  ...(serverMode ? { output: "server", adapter: node({ mode: "standalone" }) } : {}),
  integrations: [caret({
    delivery: serverMode ? "server" : "static",
    storage: filesystemStorage({
      dataRoot: new URL("./data/", import.meta.url).pathname,
      metaRoot: new URL("./meta/", import.meta.url).pathname,
    }),
    schemas: {
      pages: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
    },
  })],
});
