/**
 * Astro CONTENT collection for the blog — build-time, so we get markdown BODY
 * rendering via render(). The glob loader reads the very same .md files that
 * markdownStorage writes to, which is what lets caret edit a post's frontmatter
 * (title/excerpt/…) in place while Astro still renders the body.
 */
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    excerpt: z.string(),
    // coerce.date() accepts both the quoted "2026-05-18" we author AND the bare
    // 2026-05-18 that caret's frontmatter codec re-emits after an inline edit
    // (which Astro's YAML otherwise reads as a Date and rejects under z.string).
    date: z.coerce.date(),
    author: z.string(),
    tags: z.array(z.string()).default([]),
    cover: z.string().optional(),
    cover_alt: z.string().optional(),
  }),
});

export const collections = { blog };
