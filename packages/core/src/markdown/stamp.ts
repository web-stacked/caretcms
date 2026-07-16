/**
 * Shared, pipeline-independent logic for stamping `data-caret-md` bindings.
 *
 * Two frontends drive this — a Sätteri mdast plugin (Astro 7) and a remark
 * plugin (Astro 6) — walking their own trees but calling the SAME pure
 * functions here so both emit byte-identical attributes (a parity test holds
 * them together). Nothing in this module touches a tree or a pipeline type; it
 * takes already-extracted node facts and returns attributes or `null`.
 */

import { COLLECTION_NAME_RE, ENTRY_ID_RE } from "../runtime/storage/id-contracts.js";
import {
  CARET_MD_ATTR,
  CARET_MD_SRC_ATTR,
  fnv1a32,
  formatBlockPath,
  formatMdBinding,
  formatMdSrc,
} from "./contracts.js";

/**
 * mdast node types that make their subtree non-editable: their inner text is
 * either structured (tables), reference plumbing (footnote definitions), or
 * raw/JSX passthrough that markdown block editing can't safely round-trip.
 */
export const ISLAND_TYPES: ReadonlySet<string> = new Set([
  "table",
  "tableRow",
  "tableCell",
  "footnoteDefinition",
  "html",
  "mdxJsxFlowElement",
  "mdxJsxTextElement",
  "code",
]);

export interface ResolvedEntry {
  collection: string;
  id: string;
}

/** Normalize a file URL or path to a forward-slash filesystem path. */
function toPath(fileURL: string | URL | undefined): string | null {
  if (fileURL == null) return null;
  let p = typeof fileURL === "string" ? fileURL : (fileURL.pathname ?? String(fileURL));
  if (p.startsWith("file://")) {
    try {
      p = new URL(p).pathname;
    } catch {
      /* keep p */
    }
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep p */
  }
  return p.replace(/\\/g, "/");
}

function normalizeRoot(contentRoot: string): string {
  return contentRoot.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Resolve a source file to its `{collection, id}` under the content root, or
 * `null`. v1 scope: flat `<contentRoot>/<collection>/<id>.md` only — `.mdx`,
 * nested slugs, and identifiers failing the id grammar are intentionally
 * unmatched (and so never stamped).
 */
export function resolveEntry(
  fileURL: string | URL | undefined,
  contentRoot: string,
): ResolvedEntry | null {
  const path = toPath(fileURL);
  if (path === null) return null;
  const root = normalizeRoot(contentRoot);
  if (!path.startsWith(`${root}/`)) return null;

  const rel = path.slice(root.length + 1);
  const segments = rel.split("/");
  if (segments.length !== 2) return null; // nested slugs are out of scope in v1

  const [collection, filename] = segments;
  if (!filename.endsWith(".md")) return null; // .mdx stamped in a later version
  const id = filename.slice(0, -".md".length);
  if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) return null;
  return { collection, id };
}

export type ParagraphPlan =
  | { action: "skip" }
  | { action: "self"; nested: boolean }
  | { action: "parent" };

/**
 * Decide how a paragraph maps to a bound element. A list item renders its text
 * on the `<li>` (a tight list drops the `<p>` entirely), so we bind the item —
 * via its FIRST paragraph, using that paragraph's marker-free offsets. Other
 * paragraphs bind themselves; `nested` marks those inside a container.
 */
export function planParagraph(
  parentType: string,
  indexInParent: number | undefined,
): ParagraphPlan {
  if (parentType === "listItem") {
    return indexInParent === 0 ? { action: "parent" } : { action: "skip" };
  }
  return { action: "self", nested: parentType !== "root" };
}

export interface StampInput {
  /** The exact source string the pipeline parsed (offsets are relative to it). */
  source: string;
  /** The file being rendered. */
  fileURL: string | URL | undefined;
  /** Absolute content root the markdown adapter reads from. */
  contentRoot: string;
  /** unist offsets of the block whose text the binding edits. */
  start: number | undefined;
  end: number | undefined;
  /** Root-to-element child indexes identifying the bound element. */
  blockPath: readonly number[];
  /** Types of the bound node's ancestors (island detection). */
  ancestorTypes: readonly string[];
  /** True when the block sits inside a container (blockquote / list item). */
  nested: boolean;
  /** mdast node type of the bound block ("heading" | "paragraph" | "listItem"). */
  blockType?: string;
}

/**
 * Compute the `{data-caret-md, data-caret-md-src}` attributes for one block, or
 * `null` to leave it unstamped. Offsets are normalized to the canonical body
 * base (frontmatter-stripped, trimmed) so a `.md` import, a content-collection
 * entry, and Astro 6 remark all yield the same numbers.
 */
export function computeStamp(input: StampInput): Record<string, string> | null {
  const { source, start, end, blockPath, ancestorTypes, nested } = input;
  if (start == null || end == null || start >= end || end > source.length) return null;

  const entry = resolveEntry(input.fileURL, input.contentRoot);
  if (!entry) return null;

  if (ancestorTypes.some((t) => ISLAND_TYPES.has(t))) return null;

  const slice = source.slice(start, end);
  // A container-nested block whose source spans lines embeds `> `/indent
  // prefixes inside its range; splicing prefix-free text would corrupt it.
  if (nested && slice.includes("\n")) return null;
  // Setext headings (`Title\n====`) are not editable in v1: the write path
  // derives block context from the slice and only understands ATX markers, so
  // an edit would silently demote the heading to a paragraph. Skip stamping.
  if (input.blockType === "heading" && !slice.startsWith("#")) return null;

  const delta = source.length - source.trimStart().length;
  const canonicalStart = start - delta;
  const canonicalEnd = end - delta;
  if (canonicalStart < 0) return null;

  return {
    [CARET_MD_ATTR]: formatMdBinding({
      collection: entry.collection,
      id: entry.id,
      blockPath: formatBlockPath(blockPath),
    }),
    [CARET_MD_SRC_ATTR]: formatMdSrc({
      start: canonicalStart,
      end: canonicalEnd,
      hash: fnv1a32(slice),
    }),
  };
}
