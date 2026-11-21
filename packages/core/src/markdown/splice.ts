/**
 * Publish-time body splice: apply drafted block edits to a markdown source
 * file. This is the ONLY code that rewrites user prose in place, so it is
 * all-or-nothing by construction — every block is found again in the CURRENT
 * file (hash + bounds + overlap) before a single byte moves, and any failure
 * leaves the file untouched.
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

/** Text that may sit between a line's start and a block: indentation, list markers, quote markers. */
const BLOCK_PREFIX_RE = /^(?:[ \t]*(?:[-*+]|\d{1,9}[.)]|>)[ \t]+|[ \t]+)*$/;

/** A range that starts where a block can start and ends at the end of a line. */
function blockAligned(body: string, start: number, end: number): boolean {
  if (end !== body.length && body[end] !== "\n") return false;
  const lineStart = body.lastIndexOf("\n", start - 1) + 1;
  return BLOCK_PREFIX_RE.test(body.slice(lineStart, start));
}

/**
 * Where a drafted block is in the current canonical body. The draft's own
 * range when it still hashes; otherwise the one block-aligned range with the
 * same length and hash (the block moved because text was added or removed
 * around it). Null when the block's text changed, or when several identical
 * blocks could be meant: never guess which prose to replace.
 */
export function locateBlock(body: string, src: MdSrc): MdSrc | null {
  const length = src.end - src.start;
  if (length <= 0) return null;
  if (src.end <= body.length && fnv1a32(body.slice(src.start, src.end)) === src.hash) return src;
  let found: MdSrc | null = null;
  for (let start = 0; start + length <= body.length; start++) {
    const end = start + length;
    if (!blockAligned(body, start, end) || fnv1a32(body.slice(start, end)) !== src.hash) continue;
    if (found) return null;
    found = { start, end, hash: src.hash };
  }
  return found;
}

/** A stored body draft: its replacement and the range it was made against. */
export type BodyDraft = Record<string, unknown> & { src: MdSrc };

function isSrc(value: unknown): value is MdSrc {
  const src = value as MdSrc | null;
  return Boolean(src) && typeof src === "object" && Number.isSafeInteger(src!.start) && Number.isSafeInteger(src!.end) &&
    src!.start >= 0 && src!.end >= src!.start && typeof src!.hash === "string";
}

/**
 * Body drafts expressed against the current body. A draft whose block only
 * moved gets its range (and each paragraph source's range) shifted to where
 * the block is now; `lost` names the drafts whose text is gone or ambiguous.
 * Lost and malformed drafts are returned unchanged.
 */
export function reanchorBodyDrafts(body: string, drafts: Record<string, unknown>): { drafts: Record<string, unknown>; lost: string[] } {
  const out: Record<string, unknown> = {};
  const lost: string[] = [];
  for (const [path, value] of Object.entries(drafts)) {
    out[path] = value;
    const block = value as BodyDraft | null;
    if (!block || typeof block !== "object" || !isSrc(block.src)) continue;
    const located = locateBlock(body, block.src);
    if (!located) { lost.push(path); continue; }
    if (located === block.src) continue;
    const shift = located.start - block.src.start;
    let sources: unknown = block.sources;
    if (Array.isArray(sources)) {
      const moved = sources.map((source: { src?: unknown }) => {
        if (!source || !isSrc(source.src)) return null;
        const src = { start: source.src.start + shift, end: source.src.end + shift, hash: source.src.hash };
        return src.end <= body.length && fnv1a32(body.slice(src.start, src.end)) === src.hash ? { ...source, src } : null;
      });
      if (moved.some(source => source === null)) { lost.push(path); continue; }
      sources = moved;
    }
    out[path] = { ...block, src: located, ...(sources !== undefined ? { sources } : {}) };
  }
  return { drafts: out, lost };
}

/**
 * Splice `blocks` into `fileSource`. Returns the new file content, or a
 * failure (`stale` = a block's text changed since the draft, or can no longer
 * be told apart; `overlap` = two drafts claim intersecting ranges, which can
 * only happen through a corrupted draft store — never write through it).
 * A block that only moved is spliced where it is now (`locateBlock`).
 */
export function spliceBodyBlocks(
  fileSource: string,
  blocks: readonly BodySplice[],
): SpliceResult {
  const { body, fileOffsetOf } = canonicalBody(fileSource);

  const located: BodySplice[] = [];
  for (const block of blocks) {
    const src = locateBlock(body, block.src);
    if (!src) return { ok: false, reason: "stale" };
    located.push({ md: block.md, src });
  }

  const ordered = located.sort((a, b) => b.src.start - a.src.start);
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
