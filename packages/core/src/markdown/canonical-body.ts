/**
 * Canonical body base for markdown block offsets.
 *
 * Astro feeds the markdown processor a DIFFERENT source string per render path
 * (verified against Astro 7.0.6): direct `.md` imports blank the frontmatter
 * with equal-length whitespace, while content collections strip the
 * frontmatter and `.trim()` the body. Raw mdast offsets are therefore not
 * portable. Every `data-caret-md-src` offset is instead defined against ONE
 * canonical base — the frontmatter-stripped, trimmed body — so the stamping
 * plugin (any pipeline) and the server splicer agree on coordinates.
 *
 * Plugin side: `canonicalOffset = nodeOffset - (source.length - source.trimStart().length)`.
 * Server side: this module maps canonical offsets back to file offsets for the
 * publish splice.
 */

export interface CanonicalBody {
  /** The frontmatter-stripped, trimmed body — the offset base. */
  body: string;
  /** Map a canonical body offset to an absolute offset in the source file. */
  fileOffsetOf: (canonicalOffset: number) => number;
}

/**
 * Byte offset where the markdown body begins (0 when there is no frontmatter
 * fence). Recognizes both YAML (`---`) and TOML (`+++`) fences — locating the
 * body only needs the fence bounds, not the frontmatter's content, so this is
 * intentionally independent of the YAML-only frontmatter codec.
 */
function bodyOffset(source: string): number {
  const delim = source.startsWith("---") ? "---" : source.startsWith("+++") ? "+++" : null;
  if (!delim) return 0;
  const firstNL = source.indexOf("\n");
  if (firstNL === -1) return 0;
  if (source.slice(0, firstNL).replace(/\r$/, "").trim() !== delim) return 0;

  const rest = source.slice(firstNL + 1);
  const close = new RegExp(`^\\${delim[0]}{3}[ \\t]*\\r?(?:\\n|$)`, "m").exec(rest);
  if (!close) return 0;
  return firstNL + 1 + close.index + close[0].length;
}

/**
 * Derive the canonical body and its offset mapping from a full source file.
 *
 * `body === fileSource.slice(bodyStart).trim()`, and `fileOffsetOf(0)` is the
 * first non-whitespace byte after the frontmatter fence. Trailing-whitespace
 * trimming does not affect the mapping (it only shortens `body`).
 */
export function canonicalBody(fileSource: string): CanonicalBody {
  const start = bodyOffset(fileSource);
  const afterFm = fileSource.slice(start);
  const leading = afterFm.length - afterFm.trimStart().length;
  const base = start + leading;
  return {
    body: afterFm.trim(),
    fileOffsetOf: (canonicalOffset: number) => base + canonicalOffset,
  };
}
