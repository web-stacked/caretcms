import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import caret from "@caretcms/core";
import { cloudflareStorage, r2Uploads } from "@caretcms/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [
    caret({
      brand: { name: "Studio Norra" },
      storage: cloudflareStorage({ binding: "CMS_KV" }),
      uploads: r2Uploads({ binding: "CMS_R2" }),
    }),
  ],
});
