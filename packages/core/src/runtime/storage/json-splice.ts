/**
 * Minimal-diff JSON rewriting. Content files are often hand-formatted (short
 * objects on one line, aligned arrays), so re-serializing the whole file turns
 * a one-word edit into a diff of every line. This parses the original text
 * with the position of every value, then replaces only the values that
 * changed: a changed scalar is replaced in place, and only a value whose
 * structure changed (keys or array length) is re-serialized, indented to match
 * where it sits.
 */

type JsonNode =
  | { kind: "object"; start: number; end: number; keys: Map<string, JsonNode> }
  | { kind: "array"; start: number; end: number; items: JsonNode[] }
  | { kind: "scalar"; start: number; end: number };

function parseNode(source: string, at: number): JsonNode & { next: number } {
  let i = skipSpace(source, at);
  const start = i;
  const ch = source[i];
  if (ch === "{") {
    const keys = new Map<string, JsonNode>();
    i = skipSpace(source, i + 1);
    if (source[i] === "}") return { kind: "object", start, end: i + 1, keys, next: i + 1 };
    for (;;) {
      i = skipSpace(source, i);
      const keyEnd = stringEnd(source, i);
      const key = JSON.parse(source.slice(i, keyEnd)) as string;
      i = skipSpace(source, keyEnd);
      if (source[i] !== ":") throw new SyntaxError("Expected ':'");
      const child = parseNode(source, i + 1);
      keys.set(key, child);
      i = skipSpace(source, child.next);
      if (source[i] === ",") { i += 1; continue; }
      if (source[i] === "}") return { kind: "object", start, end: i + 1, keys, next: i + 1 };
      throw new SyntaxError("Expected ',' or '}'");
    }
  }
  if (ch === "[") {
    const items: JsonNode[] = [];
    i = skipSpace(source, i + 1);
    if (source[i] === "]") return { kind: "array", start, end: i + 1, items, next: i + 1 };
    for (;;) {
      const child = parseNode(source, i);
      items.push(child);
      i = skipSpace(source, child.next);
      if (source[i] === ",") { i += 1; continue; }
      if (source[i] === "]") return { kind: "array", start, end: i + 1, items, next: i + 1 };
      throw new SyntaxError("Expected ',' or ']'");
    }
  }
  const end = ch === '"' ? stringEnd(source, i) : scalarEnd(source, i);
  return { kind: "scalar", start, end, next: end };
}

function skipSpace(source: string, i: number): number {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

function stringEnd(source: string, i: number): number {
  if (source[i] !== '"') throw new SyntaxError("Expected string");
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === "\\") { j++; continue; }
    if (source[j] === '"') return j + 1;
  }
  throw new SyntaxError("Unterminated string");
}

function scalarEnd(source: string, i: number): number {
  let j = i;
  while (j < source.length && !/[\s,\]}]/.test(source[j])) j++;
  if (j === i) throw new SyntaxError("Expected value");
  return j;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((key) => key in b);
}

/** `value` serialized with `indent`, continuation lines indented to the line
 *  the value starts on, so a replaced block lines up with its neighbours. */
function serializeAt(source: string, start: number, value: unknown, indent: string | number): string {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lead = /^[ \t]*/.exec(source.slice(lineStart, start))?.[0] ?? "";
  return JSON.stringify(value, null, indent).replace(/\n/g, `\n${lead}`);
}

/** A value on one line in the style of a hand-written file: `{ "a": 1, "b": [1, 2] }`. */
function spacedInline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(spacedInline).join(", ")}]`;
  if (isRecord(value)) {
    const parts = Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${spacedInline(item)}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

/** New last items of an array, written like the item before them: on a line of
 *  their own or after a comma, spaced or compact, one line or several. */
function appendItems(
  source: string, node: Extract<JsonNode, { kind: "array" }>, added: unknown[], indent: string | number,
): { start: number; end: number; text: string } {
  const last = node.items[node.items.length - 1];
  const prev = node.items[node.items.length - 2];
  const lastText = source.slice(last.start, last.end);
  const separator = prev ? source.slice(prev.end, last.start) : (() => {
    const lineStart = source.lastIndexOf("\n", last.start - 1) + 1;
    const lead = source.slice(lineStart, last.start);
    return /^[ \t]*$/.test(lead) ? `,\n${lead}` : ", ";
  })();
  const text = added.map((item) => {
    if (lastText.includes("\n")) return serializeAt(source, last.start, item, indent);
    return /^[{[]\s/.test(lastText) ? spacedInline(item) : JSON.stringify(item);
  }).join(separator);
  return { start: last.end, end: last.end, text: separator + text };
}

function collectEdits(
  source: string, node: JsonNode, before: unknown, after: unknown, indent: string | number,
  edits: Array<{ start: number; end: number; text: string }>,
): void {
  if (node.kind === "object" && isRecord(before) && isRecord(after) && sameKeys(before, after)) {
    for (const [key, child] of node.keys) collectEdits(source, child, before[key], after[key], indent, edits);
    return;
  }
  if (node.kind === "array" && Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    node.items.forEach((child, index) => collectEdits(source, child, before[index], after[index], indent, edits));
    return;
  }
  if (node.kind === "array" && Array.isArray(before) && Array.isArray(after) && before.length > 0 && node.items.length === before.length) {
    // An item added at the end, or one taken out: only that text changes.
    if (after.length > before.length) {
      before.forEach((item, index) => collectEdits(source, node.items[index], item, after[index], indent, edits));
      edits.push(appendItems(source, node, after.slice(before.length), indent));
      return;
    }
    if (after.length === before.length - 1) {
      const key = (value: unknown) => JSON.stringify(value);
      let at = 0;
      while (at < after.length && key(before[at]) === key(after[at])) at++;
      if (before.slice(at + 1).every((item, index) => key(item) === key(after[at + index]))) {
        const gone = node.items[at];
        const next = node.items[at + 1];
        const prev = node.items[at - 1];
        // The item and the separator that followed it; the last one takes the one before it.
        if (next) edits.push({ start: gone.start, end: next.start, text: "" });
        else if (prev) edits.push({ start: prev.end, end: gone.end, text: "" });
        else edits.push({ start: node.start, end: node.end, text: "[]" });
        return;
      }
    }
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  edits.push({ start: node.start, end: node.end, text: serializeAt(source, node.start, after, indent) });
}

/**
 * `source` with its value changed from `before` (what `source` parses to) to
 * `after`, touching only the text of values that differ. Falls back to a full
 * re-serialization when `source` cannot be parsed for positions.
 */
export function spliceJson(source: string, before: unknown, after: unknown, indent: string | number): string {
  let root: JsonNode;
  try {
    root = parseNode(source, 0);
  } catch {
    return JSON.stringify(after, null, indent) + (source.endsWith("\n") ? "\n" : "");
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  collectEdits(source, root, before, after, indent, edits);
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
