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
//     AND caret's live collections (caretLoader). Edits write back to frontmatter.
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
      allowedClasses: {
        a: ["link"],
        strong: ["accent"],
      },
    }),
  ],
});
