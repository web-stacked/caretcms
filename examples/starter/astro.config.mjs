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
      schemas: {
        "site-settings-fixture": {
          type: "object",
          title: "Site Settings Fixture",
          properties: {
            title: { type: "string", title: "Site title", default: "Example site" },
          },
        },
        "studio-fixture": {
          type: "object",
          title: "Studio Fixture",
          properties: {
            title: { type: "string", title: "Title", default: "Untitled" },
            summary: { type: "string", title: "Summary", format: "textarea", default: "" },
            website: { type: "string", title: "Website", format: "url", default: "" },
            published: { type: "boolean", title: "Published", default: false },
            details: {
              type: "array",
              title: "Details",
              default: [],
              items: {
                type: "object",
                properties: {
                  label: { type: "string", title: "Field name", default: "" },
                  value: { type: "string", title: "Value", default: "" },
                },
              },
            },
            images: {
              type: "array",
              title: "Images",
              default: [],
              items: {
                type: "object",
                properties: {
                  id: { type: "string", title: "Identifier", default: "" },
                  src: { type: "string", title: "Image", format: "image", default: "" },
                  title: { type: "string", title: "Image title", default: "" },
                  alt: { type: "string", title: "Alternative text", default: "" },
                  width: { type: "integer", title: "Width", minimum: 1, default: 1600 },
                  height: { type: "integer", title: "Height", minimum: 1, default: 1200 },
                },
              },
            },
          },
        },
      },
      collections: {
        "site-settings-fixture": {
          label: "Site Settings",
          description: "Global singleton configuration",
          icon: "settings",
          order: -10,
          singletonId: "global",
          creatable: false,
          orderable: false,
          deletable: false,
        },
      },
    }),
  ],
});
