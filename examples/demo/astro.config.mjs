import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import caret from "@caretcms/core";
import { cloudflareDurableStorage, r2Uploads } from "@caretcms/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [
    caret({
      brand: { name: "Studio Norra" },
      storage: cloudflareDurableStorage({ binding: "CMS_CONTENT", instanceName: "demo" }),
      uploads: r2Uploads({ binding: "CMS_R2" }),
    }),
  ],
});
