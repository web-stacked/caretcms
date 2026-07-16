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
 * Frontmatter fence matcher, MIRRORING Astro's own
 * (`@astrojs/internal-helpers/dist/frontmatter.js` `frontmatterRE`) byte for
 * byte. This must agree with what Astro strips before rendering — a stricter
 * hand-rolled detector diverged on three legal shapes (UTF-8 BOM before the
 * fence, blank lines before the fence, a `----` close line whose first three
 * chars satisfy Astro's close) and every body save on such files 409'd as
 * "stale" because plugin-side and server-side offsets disagreed.
 */
const ASTRO_FRONTMATTER_RE = /(?:^\uFEFF?|^\s*\n)(?:---|\+\+\+)([\s\S]*?\n)(?:---|\+\+\+)/;

/**
 * Byte offset where the markdown body begins (0 when there is no frontmatter
 * fence) — everything Astro's stripper would remove, including any BOM or
 * leading blank lines consumed by its match.
 */
function bodyOffset(source: string): number {
  const match = ASTRO_FRONTMATTER_RE.exec(source);
  if (!match) return 0;
  return match.index + match[0].length;
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
