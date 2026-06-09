/**
 * Shared content-collection schemas — the SINGLE source of truth.
 *
 * Astro's content.config.ts uses `blogSchema` for build-time validation; astro.config
 * derives the Studio's JSON Schema from the very same object via @caretcms/zod
 * (`schemaFromZod`). Field labels come from `.describe()`, Studio widget hints from
 * `.meta({ format })`. Change a field here and both Astro and the Studio follow.
 *
 * Plain `zod` (not `astro:content`) so this module is importable from astro.config.mjs,
 * which evaluates in Node before Astro's virtual modules exist.
 */
import { z } from "zod";

export const blogSchema = z
  .object({
    title: z.string().describe("Title"),
    excerpt: z.string().describe("Excerpt"),
    // coerce.date accepts both the quoted "2026-05-18" we author AND the bare
    // 2026-05-18 caret's frontmatter codec re-emits; @caretcms/zod maps it to
    // { type: "string", format: "date" } for the Studio's date input.
    date: z.coerce.date().describe("Date"),
    author: z.string().describe("Author"),
    tags: z.array(z.string()).default([]).describe("Tags"),
    cover: z.string().meta({ format: "image" }).describe("Cover image").optional(),
    cover_alt: z.string().describe("Cover alt text").optional(),
  })
  .describe("Blog post");
