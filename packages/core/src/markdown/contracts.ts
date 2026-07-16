/**
 * Contract surface for markdown BODY inline editing (v0.3.0).
 *
 * These identifiers gate a security- and correctness-critical path: the
 * `data-caret-md` attribute binds a rendered block back to a byte range in a
 * source `.md` file, and a Publish splices edited markdown into that range.
 * The grammar, the source-hint format, and the content hash are therefore a
 * compatibility promise shared across the render-time stamping plugins, the
 * mutation engine, the publish splicer, and the browser editor.
 *
 * Zero-dependency by policy (core ships no runtime deps). The browser editor
 * ships as raw unbundled JS and hand-mirrors the pieces it needs
 * (`static/cms/editor/md-serialize.js`); a parity test holds the mirror to
 * this source of truth.
 */

import { COLLECTION_NAME_RE, ENTRY_ID_RE } from "../runtime/storage/id-contracts.js";

/** Attribute carrying the block binding (`collection::id::body::blockPath`). */
export const CARET_MD_ATTR = "data-caret-md";

/** Attribute carrying the source hint (`start:end:hash`). */
export const CARET_MD_SRC_ATTR = "data-caret-md-src";

/**
 * Reserved field name for the body-draft map inside an entry's draft overlay
 * `data`. Read boundaries strip it so it never surfaces to schema/loader
 * consumers.
 */
export const BODY_OVERLAY_KEY = "__body";

/** The synthetic field segment identifying a body binding (vs a `data-caret` field). */
export const BODY_FIELD = "body";

/**
 * A block path: dot-joined child indexes from the mdast root to the block node
 * (`"4"` = fifth top-level block; `"6.2"` = third child of the seventh block).
 * Stable identity for the block within an entry across edits.
 */
export const BLOCK_PATH_RE = /^\d+(?:\.\d+)*$/;

export interface MdBinding {
  collection: string;
  id: string;
  blockPath: string;
}

/** Format a block path from root-to-node child indexes. */
export function formatBlockPath(indexes: readonly number[]): string {
  return indexes.join(".");
}

/** Parse a block path into its child indexes, or `null` if malformed. */
export function parseBlockPath(raw: string): number[] | null {
  if (!BLOCK_PATH_RE.test(raw)) return null;
  return raw.split(".").map(Number);
}

/** Format a `data-caret-md` binding value. */
export function formatMdBinding(b: MdBinding): string {
  return `${b.collection}::${b.id}::${BODY_FIELD}::${b.blockPath}`;
}

/** Parse a `data-caret-md` binding value, or `null` if it fails the grammar. */
export function parseMdBinding(raw: string): MdBinding | null {
  const parts = raw.split("::");
  if (parts.length !== 4) return null;
  const [collection, id, field, blockPath] = parts;
  if (field !== BODY_FIELD) return null;
  if (!COLLECTION_NAME_RE.test(collection)) return null;
  if (!ENTRY_ID_RE.test(id)) return null;
  if (!BLOCK_PATH_RE.test(blockPath)) return null;
  return { collection, id, blockPath };
}

export interface MdSrc {
  /** Start offset in the canonical body (see `canonical-body.ts`). */
  start: number;
  /** End offset (exclusive) in the canonical body. */
  end: number;
  /** `fnv1a32` of the canonical body slice `[start, end)`. */
  hash: string;
}

const HASH_RE = /^[0-9a-f]{8}$/;

/** Format a `data-caret-md-src` hint value. */
export function formatMdSrc(s: MdSrc): string {
  return `${s.start}:${s.end}:${s.hash}`;
}

/** Parse a `data-caret-md-src` hint, validating bounds and hash shape. */
export function parseMdSrc(raw: string): MdSrc | null {
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const [startStr, endStr, hash] = parts;
  if (!/^\d+$/.test(startStr) || !/^\d+$/.test(endStr)) return null;
  if (!HASH_RE.test(hash)) return null;
  const start = Number(startStr);
  const end = Number(endStr);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= end) return null;
  return { start, end, hash };
}

/**
 * FNV-1a (32-bit) hash as an 8-char lowercase hex string. Not cryptographic —
 * a staleness fingerprint over a source slice, chosen for a dependency-free,
 * byte-identical implementation on both the TS and browser-JS sides. Iterates
 * UTF-16 code units, so the two sides must hash the same string form.
 */
export function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
