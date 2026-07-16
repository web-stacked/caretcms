/**
 * Publish-time body splice: apply drafted block edits to a markdown source
 * file. This is the ONLY code that rewrites user prose in place, so it is
 * all-or-nothing by construction — every block's range is re-verified against
 * the CURRENT file (hash + bounds + overlap) before a single byte moves, and
 * any failure leaves the file untouched.
 *
 * Pure (string -> string) so it can be property-tested without a filesystem;
 * `MarkdownAdapter.spliceBodyBlocks` wraps it with read + atomic write.
 */

import { canonicalBody } from "./canonical-body.js";
import { fnv1a32, type MdSrc } from "./contracts.js";

export interface BodySplice {
  /** Server-derived markdown to put in the block's place. */
  md: string;
  /** The verified source range the draft was made against. */
  src: MdSrc;
}

export type SpliceResult =
  | { ok: true; content: string }
  | { ok: false; reason: "stale" | "overlap" };

/**
 * Splice `blocks` into `fileSource`. Returns the new file content, or a
 * failure (`stale` = a range no longer hashes, the file changed since the
 * draft; `overlap` = two drafts claim intersecting ranges, which can only
 * happen through a corrupted draft store — never write through it).
 */
export function spliceBodyBlocks(
  fileSource: string,
  blocks: readonly BodySplice[],
): SpliceResult {
  const { body, fileOffsetOf } = canonicalBody(fileSource);

  for (const { src } of blocks) {
    if (src.end > body.length) return { ok: false, reason: "stale" };
    if (fnv1a32(body.slice(src.start, src.end)) !== src.hash) {
      return { ok: false, reason: "stale" };
    }
  }

  const ordered = [...blocks].sort((a, b) => b.src.start - a.src.start);
  for (let i = 1; i < ordered.length; i++) {
    // Descending by start: the later block in the file comes first. Overlap
    // exists when the previous (later-in-file) block starts before this one ends.
    if (ordered[i - 1].src.start < ordered[i].src.end) {
      return { ok: false, reason: "overlap" };
    }
  }

  let content = fileSource;
  for (const { md, src } of ordered) {
    const start = fileOffsetOf(src.start);
    const end = fileOffsetOf(src.end);
    content = content.slice(0, start) + md + content.slice(end);
  }
  return { ok: true, content };
}
