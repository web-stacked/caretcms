/**
 * Server-side inline-HTML → SNode parser for the markdown body write path.
 *
 * Exists so the server NEVER trusts client-supplied markdown: an `md_block`
 * mutation carries only HTML, which is re-sanitized against the rich allowlist
 * and then converted here into the same minimal tree `serializeBlock` consumes.
 * The markdown that eventually gets spliced into a source file is therefore
 * always derived server-side, and anything outside the closed set hard-fails
 * in the serializer.
 *
 * Deliberately tiny and strict — this only needs to parse the SANITIZER'S
 * output (balanced inline tags, double-quoted attributes, standard entities),
 * not arbitrary HTML. Malformed input throws; the mutation returns 400.
 */

import type { SNode } from "./serialize.js";

export class HtmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlParseError";
  }
}

import { decodeHtmlEntities } from "../runtime/decode-entities.js";

const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const VOID_TAGS = new Set(["br"]);

/**
 * Parse a sanitized inline-HTML fragment into SNodes. Throws
 * {@link HtmlParseError} on anything structurally unexpected (unbalanced tags,
 * malformed tag syntax, comments/doctypes/CDATA) — the sanitizer never emits
 * those, so their presence means the input didn't come through it.
 */
export function htmlToSNodes(html: string): SNode[] {
  const roots: SNode[] = [];
  const stack: Array<{ tag: string; attrs: Record<string, string>; children: SNode[] }> = [];
  const push = (node: SNode): void => {
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else roots.push(node);
  };

  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      const next = html.indexOf("<", i);
      const end = next === -1 ? html.length : next;
      push({ type: "text", value: decodeHtmlEntities(html.slice(i, end)) });
      i = end;
      continue;
    }

    const gt = html.indexOf(">", i);
    if (gt === -1) throw new HtmlParseError("unterminated tag");
    const raw = html.slice(i + 1, gt);
    i = gt + 1;

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      const top = stack.pop();
      if (!top || top.tag !== name) {
        throw new HtmlParseError(`unbalanced closing tag </${name}>`);
      }
      push({ type: "element", tag: top.tag, attrs: top.attrs, children: top.children });
      continue;
    }
    if (raw.startsWith("!") || raw.startsWith("?")) {
      throw new HtmlParseError("comments and declarations are not allowed");
    }

    const selfClosing = raw.endsWith("/");
    const tagBody = selfClosing ? raw.slice(0, -1) : raw;
    const spaceIdx = tagBody.search(/[\s]/);
    const name = (spaceIdx === -1 ? tagBody : tagBody.slice(0, spaceIdx)).toLowerCase();
    if (!TAG_NAME_RE.test(name)) throw new HtmlParseError(`malformed tag <${raw}>`);

    const attrs: Record<string, string> = {};
    const attrSrc = spaceIdx === -1 ? "" : tagBody.slice(spaceIdx);
    const attrRe = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    for (let m; (m = attrRe.exec(attrSrc)); ) {
      // Only carry href — the sole attribute the closed set represents. Other
      // sanitizer-permitted attributes (target/rel/class) don't round-trip to
      // markdown and are regenerated at render time.
      if (m[1].toLowerCase() === "href") attrs.href = decodeHtmlEntities(m[2] ?? "", true);
    }

    if (VOID_TAGS.has(name) || selfClosing) {
      push({ type: "element", tag: name, attrs, children: [] });
    } else {
      stack.push({ tag: name, attrs, children: [] });
    }
  }

  if (stack.length > 0) {
    throw new HtmlParseError(`unclosed tag <${stack[stack.length - 1].tag}>`);
  }
  return roots;
}
