import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import caret, { markdownStorage, localUploads } from "@caretcms/core";
import { schemaFromZod } from "@caretcms/zod";

import { schemas } from "./src/caret.schemas.mjs";
import { blogSchema } from "./src/schemas.mjs";

// `blog` is derived from its Zod schema (the same object content.config.ts uses)
// instead of being hand-written a second time — single source of truth.
const allSchemas = { ...schemas, blog: schemaFromZod(blogSchema) };

// A robust editorial site that exercises the full CaretCMS + caretize surface:
//   - markdownStorage: every collection is a real .md file under src/content,
//     so the SAME files power Astro content collections (getCollection + render)
//     AND Caret's live collections (caretLoader). Frontmatter edits and published
//     prose edits write back to the same source files.
//   - localUploads: <img data-caret> fields accept drag-and-drop uploads.
//   - schemas: gives the Studio nice field labels/types per collection.
//   - allowedClasses: lets data-caret-rich keep a couple of styling hooks.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [
    caret({
      brand: { name: "Atlas & Co." },
      storage: markdownStorage({ contentRoot: "./src/content" }),
      uploads: localUploads({ uploadsDir: "./public/uploads" }),
      schemas: allSchemas,
      collections: {
        site: {
          label: "Site settings",
          description: "Shared navigation, brand, and footer content",
          icon: "settings",
          order: 10,
          singletonId: "global",
          orderable: false,
        },
        pages: {
          label: "Pages",
          description: "Content for the fixed home and about routes",
          icon: "document",
          order: 20,
          creatable: false,
          orderable: false,
          deletable: false,
        },
        gallery: {
          label: "Gallery",
          description: "Projects shown on the home page",
          icon: "image",
          order: 30,
          creatable: true,
          orderable: true,
          deletable: true,
        },
        team: {
          label: "Team",
          description: "People shown on the about page",
          icon: "person",
          order: 40,
          creatable: true,
          orderable: true,
          deletable: true,
        },
        blog: {
          label: "Journal",
          description: "Markdown posts ordered by publication date",
          icon: "document",
          order: 50,
          creatable: false,
          orderable: false,
          deletable: true,
        },
      },
      allowedClasses: {
        a: ["link"],
        strong: ["accent"],
      },
    }),
  ],
});
