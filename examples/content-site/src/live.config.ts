/**
 * Caret LIVE collections — Astro loads this file because the name contains
 * `live.config` (a hard requirement of Astro's live content collections).
 *
 * Each collection is read on every request by `caretLoader`, which pulls the
 * entry from the configured storage adapter (here: markdownStorage over
 * src/content) and, for an authenticated editor, stega-encodes every string so
 * the inline editor can offer click-to-edit with no `data-caret` attribute.
 *
 * The blog is intentionally NOT here — it's a build-time Astro content
 * collection (see content.config.ts) so we can render its markdown BODY with
 * render(). Its frontmatter is still caret-editable via explicit data-caret
 * bindings, because the same .md files are the markdownStorage source.
 */
import { defineLiveCollection } from "astro:content";
import { caretLoader } from "@caretcms/core";

const site = defineLiveCollection({ loader: caretLoader("site") });
const pages = defineLiveCollection({ loader: caretLoader("pages") });
const gallery = defineLiveCollection({ loader: caretLoader("gallery") });
const team = defineLiveCollection({ loader: caretLoader("team") });

export const collections = { site, pages, gallery, team };
