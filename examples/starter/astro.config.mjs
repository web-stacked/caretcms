import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import caret from "@caretcms/core";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  // The CaretCMS inline editor works under Astro's strict CSP out of the box:
  // every editor asset (the auto-hashed bootstrap, the runtime-injected
  // editor.js + its module imports, and editor.css) is same-origin, so the
  // default `script-src 'self'` / `style-src 'self'` cover them. Do NOT enable
  // `strict-dynamic` — it disables host-based allowlisting ('self'), which
  // breaks even Astro's own bundled page scripts. CSP only applies to
  // production builds (ignored in `astro dev`); exercised by the CSP e2e
  // (playwright.csp.config.ts).
  security: {
    csp: true,
  },
  integrations: [
    caret({
      brand: {
        name: "Acme Studio",
      },
    }),
  ],
});
