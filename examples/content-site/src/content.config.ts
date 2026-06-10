/**
 * Astro CONTENT collection for the blog — build-time, so we get markdown BODY
 * rendering via render(). The glob loader reads the very same .md files that
 * markdownStorage writes to, which is what lets caret edit a post's frontmatter
 * (title/excerpt/…) in place while Astro still renders the body.
 */
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { blogSchema } from "./schemas.mjs";

// Schema lives in ./schemas.mjs — the SINGLE source. astro.config derives the
// Studio's JSON Schema from the same object via @caretcms/zod, so a field is
// defined exactly once.
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: blogSchema,
});

export const collections = { blog };
