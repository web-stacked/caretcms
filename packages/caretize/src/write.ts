/**
 * The multi-tag writer primitive: splice many `data-caret` attributes into one
 * source. Works on a UTF-8 Buffer (byte offsets) and applies insertions
 * right-to-left so each splice leaves the not-yet-applied (smaller) offsets
 * valid. Pure insertion only — never reformats.
 *
 * This is the in-memory core; the CLI layer wraps it with backups + atomic
 * file writes + a re-parse verification gate.
 */

import { findOpenTagEnd } from "./splice.js";

export interface TagInsertion {
  /** Byte offset of the target element's opening `<`. */
  startOffset: number;
  /** Attribute text WITHOUT a leading space, e.g. `data-caret="a::b::c"`. */
  attribute: string;
}

export interface ApplyResult {
  output: string;
  /** The exact strings inserted (each with its leading space), in source
   *  order — useful for reversibility checks. */
  inserted: string[];
  /** Insertions that could not be placed (their opening tag end wasn't found). */
  failures: Array<{ startOffset: number; reason: string }>;
}

export function applyTags(source: string, items: TagInsertion[]): ApplyResult {
  const buf = Buffer.from(source, "utf8");

  const resolved: Array<{ insertAt: number; text: string }> = [];
  const failures: ApplyResult["failures"] = [];
  for (const item of items) {
    const found = findOpenTagEnd(buf, item.startOffset);
    if (!found) {
      failures.push({ startOffset: item.startOffset, reason: "open tag end not found" });
      continue;
    }
    resolved.push({ insertAt: found.insertAt, text: ` ${item.attribute}` });
  }

  // Apply largest-offset-first so earlier splices don't shift later targets.
  resolved.sort((a, b) => b.insertAt - a.insertAt);

  let out = buf;
  for (const r of resolved) {
    out = Buffer.concat([
      out.subarray(0, r.insertAt),
      Buffer.from(r.text, "utf8"),
      out.subarray(r.insertAt),
    ]);
  }

  // Report inserted strings in source order (resolved is currently desc).
  const inserted = [...resolved].sort((a, b) => a.insertAt - b.insertAt).map((r) => r.text);

  return { output: out.toString("utf8"), inserted, failures };
}
