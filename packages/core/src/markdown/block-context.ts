/**
 * Derive a block's serialization context from its SOURCE, not from client
 * claims. A forged context could change a block's type (paragraph -> heading)
 * or smuggle a hard break into a container-nested block (corrupting `> `/list
 * structure on publish), so both facts are read off the canonical body at the
 * verified source range instead of being accepted from the request.
 */

import type { BlockContext } from "./serialize.js";
import type { MdSrc } from "./contracts.js";

const HEADING_RE = /^(#{1,6})[ \t]/;

/**
 * Block context for the range `src` in `canonical` (the canonical body the
 * range was hash-verified against):
 *
 * - Heading when the slice starts with ATX markers — the level comes from the
 *   marker count (heading ranges include their `#`s).
 * - Otherwise a paragraph; `nested` is true when anything (a `> ` marker, list
 *   indent) precedes the range on its line — nested blocks are single-line by
 *   the stamping contract, and `nested` makes the serializer refuse `<br>`.
 */
export function deriveBlockContext(canonical: string, src: MdSrc): BlockContext {
  const slice = canonical.slice(src.start, src.end);
  const heading = HEADING_RE.exec(slice);
  if (heading) return { block: "heading", level: heading[1].length };

  const lineStart = canonical.lastIndexOf("\n", src.start - 1) + 1;
  return { block: "paragraph", nested: lineStart < src.start };
}
