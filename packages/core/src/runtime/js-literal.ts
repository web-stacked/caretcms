/**
 * A strict reader for JavaScript literal values in template frontmatter: the
 * strings, numbers, booleans, null, arrays and objects that `editable()` calls
 * pass (caretize writes them as plain literals). Anything else (an identifier,
 * a call, a template literal with `${…}`, a spread) makes the whole value
 * unreadable, so a computed default is never mistaken for a stated one.
 * No evaluation: source text in, plain data out.
 */

export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

const UNREADABLE = Symbol("unreadable");
type Read = { value: Literal; end: number } | typeof UNREADABLE;

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };

function skipSpace(src: string, i: number): number {
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
    else if (src.startsWith("//", i)) { const nl = src.indexOf("\n", i); i = nl === -1 ? src.length : nl + 1; }
    else if (src.startsWith("/*", i)) { const close = src.indexOf("*/", i + 2); if (close === -1) return src.length; i = close + 2; }
    else break;
  }
  return i;
}

function readString(src: string, i: number): Read {
  const quote = src[i];
  let out = "";
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === quote) return { value: out, end: j + 1 };
    if (quote === "`" && c === "$" && src[j + 1] === "{") return UNREADABLE;
    if ((c === "\n" || c === "\r") && quote !== "`") return UNREADABLE;
    if (c === "\\") {
      const next = src[j + 1];
      if (next === undefined) return UNREADABLE;
      if (next === "u") {
        const braced = src[j + 2] === "{" ? /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(j + 2)) : null;
        const hex = braced ? braced[1] : src.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]+$/.test(hex) || (!braced && hex.length !== 4)) return UNREADABLE;
        out += String.fromCodePoint(parseInt(hex, 16));
        j += braced ? braced[0].length + 1 : 5;
      } else if (next === "x") {
        const hex = src.slice(j + 2, j + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return UNREADABLE;
        out += String.fromCharCode(parseInt(hex, 16));
        j += 3;
      } else if (next === "\n") {
        j += 1; // line continuation
      } else {
        out += ESCAPES[next] ?? next;
        j += 1;
      }
      continue;
    }
    out += c;
  }
  return UNREADABLE;
}

function readValue(src: string, start: number, depth: number): Read {
  if (depth > 32) return UNREADABLE;
  const i = skipSpace(src, start);
  const c = src[i];
  if (c === "\"" || c === "'" || c === "`") return readString(src, i);
  if (c === "[") {
    const items: Literal[] = [];
    let j = skipSpace(src, i + 1);
    while (src[j] !== "]") {
      const item = readValue(src, j, depth + 1);
      if (item === UNREADABLE) return UNREADABLE;
      items.push(item.value);
      j = skipSpace(src, item.end);
      if (src[j] === ",") j = skipSpace(src, j + 1);
      else if (src[j] !== "]") return UNREADABLE;
    }
    return { value: items, end: j + 1 };
  }
  if (c === "{") {
    const out: { [key: string]: Literal } = {};
    let j = skipSpace(src, i + 1);
    while (src[j] !== "}") {
      let key: string;
      if (src[j] === "\"" || src[j] === "'") {
        const read = readString(src, j);
        if (read === UNREADABLE) return UNREADABLE;
        key = read.value as string;
        j = read.end;
      } else {
        const ident = /^[A-Za-z_$][\w$]*/.exec(src.slice(j));
        if (!ident) return UNREADABLE;
        key = ident[0];
        j += key.length;
      }
      j = skipSpace(src, j);
      if (src[j] !== ":") return UNREADABLE; // shorthand or method: computed
      const value = readValue(src, j + 1, depth + 1);
      if (value === UNREADABLE) return UNREADABLE;
      if (key !== "__proto__" && key !== "constructor" && key !== "prototype") out[key] = value.value;
      j = skipSpace(src, value.end);
      if (src[j] === ",") j = skipSpace(src, j + 1);
      else if (src[j] !== "}") return UNREADABLE;
    }
    return { value: out, end: j + 1 };
  }
  const number = /^-?(?:\d[\d_]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
  if (number) return { value: Number(number[0].replace(/_/g, "")), end: i + number[0].length };
  for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
    if (src.startsWith(word, i) && !/[\w$]/.test(src[i + word.length] ?? "")) return { value, end: i + word.length };
  }
  return UNREADABLE;
}

/** The literal starting at `start` and where it ends, or null when it isn't one. */
export function readLiteral(src: string, start: number): { value: Literal; end: number } | null {
  const read = readValue(src, start, 0);
  return read === UNREADABLE ? null : read;
}
