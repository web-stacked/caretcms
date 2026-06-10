/**
 * The byte-correct splice core for caretize.
 *
 * Why this file exists at all: `@astrojs/compiler` reports node positions as
 * **0-based UTF-8 byte offsets** (see `Point.offset` in its AST types), but
 * JavaScript string indexing counts UTF-16 code units. The two diverge the
 * moment a file contains a multibyte character (em-dash, curly quote,
 * box-drawing glyph, emoji) before an element. Splicing at a byte offset into a
 * JS string therefore lands in the wrong place and silently corrupts the tag.
 *
 * The rule, proven by spike against the example corpus: do ALL offset
 * arithmetic and splicing on a UTF-8 `Buffer`, never on a string. Everything in
 * this module takes and returns `Buffer`s for that reason.
 *
 * We use the compiler AST for DETECTION only. Writing is pure insertion of an
 * attribute just before the `>` of an opening tag — never AST reprinting — so
 * the user's formatting, comments, and whitespace are preserved byte-for-byte.
 */

// ASCII byte constants (all the structural characters we scan for are ASCII,
// so single-byte comparisons on the UTF-8 buffer are safe).
const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f; // /
const LBRACE = 0x7b; // {
const RBRACE = 0x7d; // }
const DQUOTE = 0x22; // "
const SQUOTE = 0x27; // '
const BACKTICK = 0x60; // `

export interface OpenTagEnd {
  /** Byte offset at which to insert an attribute (just before `>` or `/>`). */
  insertAt: number;
  /** Byte offset of the closing `>` itself. */
  gtOffset: number;
  /** Whether the tag is self-closing (`<img ... />`). */
  selfClosing: boolean;
}

/**
 * Given the byte offset of an opening tag's `<`, find where its opening tag
 * ends. Scans forward to the `>` that is not inside a quoted attribute value or
 * a `{...}` expression (Astro attributes can hold JS expressions and template
 * literals that legitimately contain `>`), so we don't stop early.
 *
 * Returns null if `startOffset` isn't a `<` or no closing `>` is found.
 */
export function findOpenTagEnd(
  buf: Buffer,
  startOffset: number,
): OpenTagEnd | null {
  let i = startOffset;
  if (buf[i] !== LT) return null;
  i++;

  let braceDepth = 0;
  while (i < buf.length) {
    const b = buf[i];

    // Skip quoted attribute values (only when not inside an expression).
    if (braceDepth === 0 && (b === DQUOTE || b === SQUOTE || b === BACKTICK)) {
      const quote = b;
      i++;
      while (i < buf.length && buf[i] !== quote) i++;
      i++; // step past the closing quote
      continue;
    }

    if (b === LBRACE) {
      braceDepth++;
      i++;
      continue;
    }
    if (b === RBRACE) {
      braceDepth = Math.max(0, braceDepth - 1);
      i++;
      continue;
    }

    if (braceDepth === 0 && b === GT) {
      const selfClosing = buf[i - 1] === SLASH;
      return {
        insertAt: selfClosing ? i - 1 : i,
        gtOffset: i,
        selfClosing,
      };
    }

    i++;
  }

  return null;
}

/**
 * Insert `attribute` (e.g. ` data-caret="pages::home::headline"`, including its
 * leading space) at the given byte offset, returning a new buffer. Pure
 * insertion: removing the inserted bytes yields the original exactly, which is
 * the reversibility invariant the writer relies on for backups/undo.
 */
export function spliceAttribute(
  buf: Buffer,
  insertAt: number,
  attribute: string,
): Buffer {
  const attrBuf = Buffer.from(attribute, "utf8");
  return Buffer.concat([
    buf.subarray(0, insertAt),
    attrBuf,
    buf.subarray(insertAt),
  ]);
}
