/**
 * Vendored steganographic encoder for Content Source Maps.
 *
 * Hides a small JSON payload (e.g. a Caret binding key) *inside* a string by
 * appending invisible Unicode "tag" characters (U+E0000–U+E007F, the Unicode
 * Tags block, which render to nothing). Because the metadata lives in the string
 * value itself — not on a DOM element — it survives flowing through component
 * props, slots, and `.map()` loops, and can later be decoded from a rendered DOM
 * text node to power click-to-edit overlays with no `data-caret` attribute.
 *
 * This is the same technique used by `@vercel/stega`, reimplemented here in a
 * few lines so `@caretcms/core` keeps ZERO runtime dependencies. The wire format
 * is Caret's own (Caret encodes and Caret decodes), so it is intentionally
 * simple rather than byte-compatible with Vercel's envelope.
 *
 * Isomorphic: encode/clean run server-side (loaders, middleware); decode runs in
 * the editor's browser bundle. Published output MUST be run through stegaClean().
 */

// The Unicode Tags block. Every character here is invisible when rendered.
const TAG_BASE = 0xe0000;
const TAG_MAX = 0xe007f;

// Delimiters at offsets 0x00 / 0x01 — these are NOT base64 characters, so they
// can never collide with an encoded body.
const START = String.fromCodePoint(TAG_BASE + 0x00);
const END = String.fromCodePoint(TAG_BASE + 0x01);

// Matches any character in the Tags block (used to strip all stega metadata).
const TAG_RE = /[\u{E0000}-\u{E007F}]/gu;

function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encode a payload into an invisible, appendable string of tag characters. */
function encodePayload(payload: unknown): string {
  const b64 = toBase64(JSON.stringify(payload));
  let body = "";
  for (let i = 0; i < b64.length; i++) {
    // base64 chars are ASCII; map each to its invisible tag-block counterpart.
    body += String.fromCodePoint(TAG_BASE + b64.charCodeAt(i));
  }
  return START + body + END;
}

/**
 * Append `payload` to `value` as invisible metadata. The returned string looks
 * and prints identically to `value`, but carries the payload for later decode.
 */
export function stegaCombine(value: string, payload: unknown): string {
  return value + encodePayload(payload);
}

/**
 * Extract the hidden payload from a string, or `undefined` if there is none
 * (or it is malformed). Safe to call on any string, encoded or not.
 */
export function stegaDecode<T = unknown>(value: string): T | undefined {
  const start = value.indexOf(START);
  if (start === -1) return undefined;
  const end = value.indexOf(END, start + START.length);
  if (end === -1) return undefined;

  let b64 = "";
  for (const ch of value.slice(start + START.length, end)) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp < TAG_BASE || cp > TAG_MAX) return undefined;
    b64 += String.fromCharCode(cp - TAG_BASE);
  }
  try {
    return JSON.parse(fromBase64(b64)) as T;
  } catch {
    return undefined;
  }
}

/** Strip ALL stega metadata, returning the clean visible string. */
export function stegaClean(value: string): string {
  return value.replace(TAG_RE, "");
}

/** Convenience: the cleaned string and the decoded payload in one call. */
export function stegaSplit<T = unknown>(
  value: string,
): { cleaned: string; payload: T | undefined } {
  return { cleaned: stegaClean(value), payload: stegaDecode<T>(value) };
}

/** Whether a string carries any stega metadata. */
export function hasStega(value: string): boolean {
  return value.includes(START);
}
