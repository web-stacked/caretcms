/**
 * `caretize remove`: take CaretCMS's binding attributes out of templates in
 * place. Unlike `--restore`, which copies old files back, this edits the files
 * as they are now, so work done since caretize ran is kept.
 *
 * Pure functions here; the CLI wraps them with backups and prompts.
 */

import { parseAstro, walkTags } from "./parse.js";
import { findOpenTagEnd } from "./splice.js";

/** CaretCMS's binding attributes: `data-caret`, `data-caret-scope`, `data-caret-rich`, `data-caret-md`, … */
const BINDING_ATTR_RE = /^data-caret(?:-|$)/;

const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c]);
const QUOTES = new Set([0x22, 0x27, 0x60]); // " ' `
const LBRACE = 0x7b, RBRACE = 0x7d, EQUALS = 0x3d, SLASH = 0x2f, GT = 0x3e;

/** Past a quoted string starting at `i` (its opening quote). */
function skipQuoted(buf: Buffer, i: number, end: number): number {
  const quote = buf[i];
  i++;
  while (i < end && buf[i] !== quote) i++;
  return Math.min(end, i + 1);
}

/** Past a `{…}` expression starting at `i`, with nested braces and strings. */
function skipBraces(buf: Buffer, i: number, end: number): number {
  let depth = 0;
  while (i < end) {
    const byte = buf[i];
    if (QUOTES.has(byte)) { i = skipQuoted(buf, i, end); continue; }
    if (byte === LBRACE) depth++;
    if (byte === RBRACE && --depth === 0) return i + 1;
    i++;
  }
  return end;
}

/** Byte ranges (leading whitespace included) of the binding attributes in one opening tag. */
function bindingAttributeRanges(buf: Buffer, tagStart: number, tagEnd: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = tagStart + 1;
  while (i < tagEnd && !SPACE.has(buf[i]) && buf[i] !== SLASH && buf[i] !== GT) i++; // tag name
  while (i < tagEnd) {
    const gap = i;
    while (i < tagEnd && SPACE.has(buf[i])) i++;
    if (i >= tagEnd || buf[i] === SLASH || buf[i] === GT) break;
    // A spread or shorthand attribute: `{...props}`, `{name}`.
    if (buf[i] === LBRACE) { i = skipBraces(buf, i, tagEnd); continue; }
    const nameStart = i;
    while (i < tagEnd && !SPACE.has(buf[i]) && buf[i] !== EQUALS && buf[i] !== SLASH && buf[i] !== GT) i++;
    const name = buf.toString("utf8", nameStart, i);
    let valueEnd = i;
    let next = i;
    while (next < tagEnd && SPACE.has(buf[next])) next++;
    if (buf[next] === EQUALS) {
      next++;
      while (next < tagEnd && SPACE.has(buf[next])) next++;
      if (QUOTES.has(buf[next])) valueEnd = skipQuoted(buf, next, tagEnd);
      else if (buf[next] === LBRACE) valueEnd = skipBraces(buf, next, tagEnd);
      else {
        valueEnd = next;
        while (valueEnd < tagEnd && !SPACE.has(buf[valueEnd]) && buf[valueEnd] !== GT) valueEnd++;
      }
      i = valueEnd;
    }
    if (BINDING_ATTR_RE.test(name)) ranges.push([gap, valueEnd]);
  }
  return ranges;
}

export interface StripResult {
  ok: boolean;
  output: string;
  /** How many binding attributes were taken out. */
  removed: number;
  /** Why the file was left alone, when `ok` is false. */
  reason?: string;
}

async function countBindings(source: string): Promise<{ tags: number; bindings: number }> {
  let tags = 0, bindings = 0;
  walkTags(await parseAstro(source), (node) => {
    tags++;
    bindings += node.attributes.filter((attribute) => BINDING_ATTR_RE.test(attribute.name)).length;
  });
  return { tags, bindings };
}

/**
 * Remove every CaretCMS binding attribute from an `.astro` source. Only those
 * attributes (and the whitespace before each) are cut; everything else stays
 * byte-for-byte. The result is parsed again: if any binding is left or the
 * element structure changed, the file is reported and returned unchanged.
 */
export async function stripBindings(source: string): Promise<StripResult> {
  const buf = Buffer.from(source, "utf8");
  const before = await countBindings(source);
  if (before.bindings === 0) return { ok: true, output: source, removed: 0 };

  const cuts: Array<[number, number]> = [];
  walkTags(await parseAstro(source), (node) => {
    if (!node.attributes.some((attribute) => BINDING_ATTR_RE.test(attribute.name))) return;
    const start = node.position?.start.offset;
    const end = start === undefined ? null : findOpenTagEnd(buf, start);
    if (start === undefined || !end) return;
    cuts.push(...bindingAttributeRanges(buf, start, end.gtOffset));
  });

  cuts.sort((a, b) => b[0] - a[0]);
  let out = buf;
  for (const [start, end] of cuts) out = Buffer.concat([out.subarray(0, start), out.subarray(end)]);
  const output = out.toString("utf8");

  const after = await countBindings(output);
  if (after.bindings !== 0 || after.tags !== before.tags) {
    return { ok: false, output: source, removed: 0, reason: "some attributes are written in a way caretize can't remove safely" };
  }
  return { ok: true, output, removed: cuts.length };
}

/** Past a balanced `( … )` starting at `i` (its opening parenthesis), with strings. */
function skipParens(source: string, i: number): number {
  let depth = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i++;
      while (i < source.length && source[i] !== char) i += source[i] === "\\" ? 2 : 1;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i + 1;
    i++;
  }
  return source.length;
}

/**
 * Take the CaretCMS integration out of an astro.config: its import and its
 * `caret(…)` entry in `integrations` (the whole `integrations` line when that
 * was its only entry). Returns null when the config doesn't use it in the
 * shape `caretize init` writes, so the caller can ask for a manual edit
 * instead of guessing.
 */
export function unwireConfig(source: string): string | null {
  const importRe = /^[ \t]*import\s+(\w+)\s+from\s+['"]@caretcms\/core['"];?[ \t]*\r?\n/m;
  const imported = importRe.exec(source);
  if (!imported) return null;
  const name = imported[1];
  let output = source.replace(importRe, "");

  const call = new RegExp(`\\b${name}\\s*\\(`).exec(output);
  if (!call) return null;
  const callEnd = skipParens(output, call.index + call[0].length - 1);
  // The only entry: drop the whole `integrations: [caret()],` line.
  const lineStart = output.lastIndexOf("\n", call.index) + 1;
  const lineEnd = output.indexOf("\n", callEnd);
  const line = output.slice(lineStart, lineEnd === -1 ? output.length : lineEnd);
  const alone = new RegExp(`^[ \\t]*integrations\\s*:\\s*\\[\\s*$`).test(output.slice(lineStart, call.index)) &&
    /^\s*\]\s*,?\s*$/.test(output.slice(callEnd, lineEnd === -1 ? output.length : lineEnd));
  if (alone && line.includes("integrations")) {
    output = output.slice(0, lineStart) + output.slice(lineEnd === -1 ? output.length : lineEnd + 1);
  } else {
    // One of several entries: remove it with one neighbouring comma.
    let start = call.index, end = callEnd;
    const trailing = /^\s*,[ \t]*/.exec(output.slice(end));
    if (trailing) end += trailing[0].length;
    else {
      const leading = /,\s*$/.exec(output.slice(0, start));
      if (leading) start -= leading[0].length;
    }
    output = output.slice(0, start) + output.slice(end);
  }
  // Anything still naming the integration means a shape this can't handle.
  if (new RegExp(`\\b${name}\\s*\\(`).test(output) || output.includes("@caretcms/core")) return null;
  return output;
}

/**
 * The lines of a content file's frontmatter that hold text saved over a
 * template (the fields named under `__caret_template__`). After removal that
 * text no longer shows on the site, so the caller lists it for copying.
 */
export function savedTemplateText(fileSource: string): string[] {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fileSource)?.[1];
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => /^["']?__caret_template__["']?\s*:/.test(line));
  if (start === -1) return [];
  const fields: string[] = [];
  for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    const field = /^\s+["']?([^"':]+)["']?\s*:/.exec(lines[i])?.[1];
    if (field) fields.push(field);
  }
  // Top-level fields only: a nested path is listed by its first key.
  const tops = new Set(fields.map((field) => field.split(".")[0]));
  return lines.filter((line, index) => index !== start && [...tops].some((top) => new RegExp(`^["']?${top.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`).test(line)));
}
