import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import caret from "@caretcms/core";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [caret()],
});
