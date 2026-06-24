/**
 * Zero-dependency YAML-frontmatter codec for the markdown StorageAdapter.
 *
 * Core ships no runtime dependencies, so this is a hand-rolled parser/serializer
 * for the SUBSET of YAML that appears in Astro content-collection frontmatter:
 * block mappings, block sequences (of scalars or mappings), and scalars
 * (quoted/plain strings, integers, floats, booleans, null), plus empty/scalar
 * flow collections (`[]`, `{}`, `[a, b]`, `{a: b}`).
 *
 * Design rules:
 *  - **Fail loud, never lossy.** `parseFrontmatter` returns `{ ok: false }` for
 *    any construct it cannot faithfully represent (anchors, aliases, tags, block
 *    scalars `|`/`>`, tab indentation). The adapter turns that into a thrown
 *    error so a later whole-entry `writeEntry` can never silently drop the
 *    frontmatter it failed to read.
 *  - **Round-trip safe by construction.** A value is emitted as a plain scalar
 *    only when re-parsing that exact text yields the identical string; anything
 *    else is double-quoted with JSON escapes (valid YAML double-quote escapes),
 *    so `parse(serialize(x))` deep-equals `x` for every supported value.
 *  - **Comments are not preserved** on write (preserving them needs a full CST).
 *    Documented and accepted for v1; the markdown BODY, by contrast, is never
 *    touched — the adapter splices it back verbatim using `bodyStart`.
 */

const MAX_DEPTH = 32;

export type ParseResult =
  | { ok: true; data: Record<string, unknown>; bodyStart: number }
  | { ok: false; reason: string };

export type SerializeResult = { ok: true; content: string } | { ok: false; reason: string };

class CodecError extends Error {}

// ---------------------------------------------------------------------------
// Scalar interpretation
// ---------------------------------------------------------------------------

const INT_RE = /^[-+]?\d+$/;
const FLOAT_RE = /^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const EXP_INT_RE = /^[-+]?\d+[eE][-+]?\d+$/;

/** Interpret an unquoted plain scalar token as null/bool/number, else string. */
function parsePlainScalar(s: string): unknown {
  if (s === "") return null;
  const lower = s.toLowerCase();
  if (s === "~" || lower === "null") return null;
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;
  if (INT_RE.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
    return s; // out of safe-integer range → keep as string (no precision loss)
  }
  if (FLOAT_RE.test(s) || EXP_INT_RE.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function unescapeChar(c: string): string {
  switch (c) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "b": return "\b";
    case "f": return "\f";
    case "0": return "\0";
    default: return c; // covers \" \\ \/ and any other escaped char
  }
}

/** Parse a double-quoted scalar — JSON-compatible first, tolerant fallback. */
function parseDoubleQuoted(text: string): string {
  try {
    const v = JSON.parse(text);
    if (typeof v === "string") return v;
  } catch {
    // fall through to tolerant unescape
  }
  if (!text.endsWith('"') || text.length < 2) throw new CodecError(`unterminated string: ${text}`);
  const inner = text.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") {
      out += unescapeChar(inner[i + 1] ?? "");
      i++;
    } else {
      out += inner[i];
    }
  }
  return out;
}

/** Parse a single-quoted scalar (`''` is an escaped quote). */
function parseSingleQuoted(text: string): string {
  if (!text.endsWith("'") || text.length < 2) throw new CodecError(`unterminated string: ${text}`);
  const inner = text.slice(1, -1);
  return inner.replace(/''/g, "'");
}

// ---------------------------------------------------------------------------
// Flow collections (`[...]`, `{...}`)
// ---------------------------------------------------------------------------

function parseFlow(src: string, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new CodecError("frontmatter nested too deeply");
  let i = 0;
  const skipWs = (): void => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  const parseQuoted = (): string => {
    const q = src[i];
    let out = "";
    i++;
    if (q === '"') {
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          out += unescapeChar(src[i + 1] ?? "");
          i += 2;
        } else {
          out += src[i++];
        }
      }
      if (src[i] !== '"') throw new CodecError("unterminated flow string");
      i++;
      return out;
    }
    while (i < src.length) {
      if (src[i] === "'") {
        if (src[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        i++;
        return out;
      }
      out += src[i++];
    }
    throw new CodecError("unterminated flow string");
  };

  const parseValue = (): unknown => {
    skipWs();
    const c = src[i];
    if (c === "[") return parseArray();
    if (c === "{") return parseObject();
    if (c === '"' || c === "'") return parseQuoted();
    const start = i;
    while (i < src.length && !"]},:".includes(src[i])) i++;
    return parsePlainScalar(src.slice(start, i).trim());
  };

  function parseArray(): unknown[] {
    i++; // consume [
    const arr: unknown[] = [];
    skipWs();
    if (src[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "]") {
        i++;
        break;
      }
      throw new CodecError("malformed flow sequence");
    }
    return arr;
  }

  function parseObject(): Record<string, unknown> {
    i++; // consume {
    const obj: Record<string, unknown> = {};
    skipWs();
    if (src[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      let key: string;
      if (src[i] === '"' || src[i] === "'") {
        key = parseQuoted();
      } else {
        const start = i;
        while (i < src.length && !":,}".includes(src[i])) i++;
        key = src.slice(start, i).trim();
      }
      skipWs();
      if (src[i] !== ":") throw new CodecError("expected ':' in flow mapping");
      i++;
      obj[key] = parseValue();
      skipWs();
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] === "}") {
        i++;
        break;
      }
      throw new CodecError("malformed flow mapping");
    }
    return obj;
  }

  const value = parseValue();
  skipWs();
  if (i < src.length) throw new CodecError("trailing characters after flow value");
  return value;
}

/** Parse a value token that may be quoted, a flow collection, or a plain scalar. */
function parseValueToken(text: string, depth: number): unknown {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) return parseFlow(t, depth);
  if (t.startsWith('"')) return parseDoubleQuoted(t);
  if (t.startsWith("'")) return parseSingleQuoted(t);
  if (t.startsWith("&") || t.startsWith("*") || t.startsWith("!")) {
    throw new CodecError("anchors, aliases, and tags are not supported");
  }
  // Block scalar headers: `|`, `>`, with optional chomping (`+`/`-`) and/or an
  // indentation indicator (`|2`, `>2-`). Must fail loud — silently reading the
  // header as a plain string would drop the multi-line body on the next write.
  if (/^[|>][0-9]*[+-]?$/.test(t)) {
    throw new CodecError("block scalars (| and >) are not supported");
  }
  return parsePlainScalar(t);
}

// ---------------------------------------------------------------------------
// Block parsing (indentation-based)
// ---------------------------------------------------------------------------

type Token = { indent: number; dash: boolean; text: string };

/** Strip a trailing ` # comment`, respecting single/double quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inDouble && c === "\\") {
      i++;
      continue;
    }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Turn the raw frontmatter block into indentation tokens, splitting `-` leads. */
function tokenize(yaml: string): Token[] {
  const tokens: Token[] = [];
  for (const rawLine of yaml.split(/\r?\n/)) {
    const lead = /^[ \t]*/.exec(rawLine)![0];
    if (lead.includes("\t")) throw new CodecError("tab indentation is not supported");
    let indent = lead.length;
    let text = stripComment(rawLine.slice(indent)).replace(/\s+$/, "");
    if (text === "") continue; // blank or comment-only line

    // Peel leading dash markers: `- - x` → DASH(indent) DASH(indent+2) scalar(indent+4)
    while (text === "-" || text.startsWith("- ")) {
      tokens.push({ indent, dash: true, text: "" });
      if (text === "-") {
        text = "";
        break;
      }
      text = text.slice(2).replace(/\s+$/, "");
      indent += 2;
    }
    if (text !== "") tokens.push({ indent, dash: false, text });
  }
  return tokens;
}

/** Index of the key/value colon (`:` followed by space or end), respecting quotes. */
function findKeyColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inDouble && c === "\\") {
      i++;
      continue;
    }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === ":" && !inSingle && !inDouble && (i + 1 >= text.length || text[i + 1] === " ")) {
      return i;
    }
  }
  return -1;
}

function parseKey(text: string): string {
  const t = text.trim();
  if (t.startsWith('"')) return parseDoubleQuoted(t);
  if (t.startsWith("'")) return parseSingleQuoted(t);
  if (t === "") throw new CodecError("empty mapping key");
  return t;
}

class BlockParser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Record<string, unknown> {
    if (this.tokens.length === 0) return {};
    const value = this.parseBlock(this.tokens[0].indent, 0);
    if (this.pos < this.tokens.length) {
      throw new CodecError("inconsistent indentation in frontmatter");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new CodecError("frontmatter must be a mapping");
    }
    return value as Record<string, unknown>;
  }

  private parseBlock(indent: number, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new CodecError("frontmatter nested too deeply");
    const tok = this.tokens[this.pos];
    if (tok.dash) return this.parseSequence(indent, depth);
    if (findKeyColon(tok.text) !== -1) return this.parseMapping(indent, depth);
    // Lone scalar value (e.g. the content following a `-`).
    this.pos++;
    return parseValueToken(tok.text, depth);
  }

  private parseMapping(indent: number, depth: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (this.pos < this.tokens.length && this.tokens[this.pos].indent === indent) {
      const tok = this.tokens[this.pos];
      if (tok.dash) throw new CodecError("unexpected sequence item in mapping");
      const colon = findKeyColon(tok.text);
      if (colon === -1) throw new CodecError(`expected 'key: value', got: ${tok.text}`);
      const key = parseKey(tok.text.slice(0, colon));
      const rest = tok.text.slice(colon + 1).trim();
      this.pos++;
      if (rest === "") {
        obj[key] =
          this.pos < this.tokens.length && this.tokens[this.pos].indent > indent
            ? this.parseBlock(this.tokens[this.pos].indent, depth + 1)
            : null;
      } else {
        obj[key] = parseValueToken(rest, depth);
      }
    }
    return obj;
  }

  private parseSequence(indent: number, depth: number): unknown[] {
    const arr: unknown[] = [];
    while (
      this.pos < this.tokens.length &&
      this.tokens[this.pos].indent === indent &&
      this.tokens[this.pos].dash
    ) {
      this.pos++; // consume the dash marker
      if (this.pos < this.tokens.length && this.tokens[this.pos].indent > indent) {
        arr.push(this.parseBlock(this.tokens[this.pos].indent, depth + 1));
      } else {
        arr.push(null);
      }
    }
    return arr;
  }
}

// ---------------------------------------------------------------------------
// Public: parse
// ---------------------------------------------------------------------------

/** Locate the frontmatter fence; returns the YAML block and the body offset. */
function locateFrontmatter(source: string): { yaml: string; bodyStart: number } | null {
  if (!source.startsWith("---")) return null;
  const firstNL = source.indexOf("\n");
  if (firstNL === -1) return null;
  if (source.slice(0, firstNL).replace(/\r$/, "").trim() !== "---") return null;

  const rest = source.slice(firstNL + 1);
  const close = /^---[ \t]*\r?(?:\n|$)/m.exec(rest);
  if (!close) return null;

  return {
    yaml: rest.slice(0, close.index),
    bodyStart: firstNL + 1 + close.index + close[0].length,
  };
}

export function parseFrontmatter(source: string): ParseResult {
  const located = locateFrontmatter(source);
  if (!located) return { ok: true, data: {}, bodyStart: 0 };

  try {
    const data = new BlockParser(tokenize(located.yaml)).parse();
    return { ok: true, data, bodyStart: located.bodyStart };
  } catch (error) {
    const reason = error instanceof CodecError ? error.message : String(error);
    return { ok: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Public: serialize
// ---------------------------------------------------------------------------

const PLAIN_RE = /^[A-Za-z0-9][A-Za-z0-9 _\-./]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when `s` can be emitted unquoted and re-parse to the identical string. */
function isPlainSafe(s: string): boolean {
  if (!PLAIN_RE.test(s) || s.endsWith(" ")) return false;
  const parsed = parsePlainScalar(s);
  return typeof parsed === "string" && parsed === s;
}

function quoteString(s: string): string {
  return isPlainSafe(s) ? s : JSON.stringify(s);
}

/** Inline scalar / empty-collection representation, or null if a block is needed. */
function inlineScalar(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CodecError(`cannot serialize non-finite number: ${value}`);
    return String(value);
  }
  if (typeof value === "string") return quoteString(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : null;
  if (isPlainObject(value)) return Object.keys(value).length === 0 ? "{}" : null;
  throw new CodecError(`unsupported value type: ${Object.prototype.toString.call(value)}`);
}

function emitEntry(key: string, value: unknown, indent: number, depth: number): string[] {
  if (depth > MAX_DEPTH) throw new CodecError("data nested too deeply to serialize");
  const pad = " ".repeat(indent);
  const ks = quoteString(key);
  const inline = inlineScalar(value);
  if (inline !== null) return [`${pad}${ks}: ${inline}`];

  const lines = [`${pad}${ks}:`];
  if (Array.isArray(value)) {
    for (const item of value) lines.push(...emitSeqItem(item, indent + 2, depth + 1));
  } else {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      lines.push(...emitEntry(k, v, indent + 2, depth + 1));
    }
  }
  return lines;
}

function emitSeqItem(value: unknown, indent: number, depth: number): string[] {
  if (depth > MAX_DEPTH) throw new CodecError("data nested too deeply to serialize");
  const pad = " ".repeat(indent);
  const inline = inlineScalar(value);
  if (inline !== null) return [`${pad}- ${inline}`];

  // Non-empty array/object item: a bare dash, then the nested block indented.
  const lines = [`${pad}-`];
  if (Array.isArray(value)) {
    for (const item of value) lines.push(...emitSeqItem(item, indent + 2, depth + 1));
  } else {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      lines.push(...emitEntry(k, v, indent + 2, depth + 1));
    }
  }
  return lines;
}

/**
 * Serialize a data record into a YAML frontmatter block (WITHOUT the `---`
 * fences; the adapter composes those around it). Returns `{ ok: false }` if any
 * value cannot be safely represented (non-finite number, Date, function, …) so
 * the write is rejected before touching the file.
 */
export function serializeFrontmatter(data: Record<string, unknown>): SerializeResult {
  try {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      lines.push(...emitEntry(key, value, 0, 0));
    }
    return { ok: true, content: lines.length === 0 ? "" : `${lines.join("\n")}\n` };
  } catch (error) {
    const reason = error instanceof CodecError ? error.message : String(error);
    return { ok: false, reason };
  }
}
