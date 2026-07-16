/**
 * DOM-free markdown block serializer.
 *
 * Turns the inline content of ONE editable block into markdown source. The
 * closed set is deliberately tiny — text, `strong`/`b`, `em`/`i`, `a[href]`,
 * `code`, `br` — so serialization is a small, total, reversible function
 * rather than a general HTML→markdown converter. Anything outside the set is a
 * hard error: the browser sanitizes to this set before serializing, so a throw
 * means a bug or an attack, never normal input.
 *
 * Pure and DOM-free by design: it operates on a minimal {@link SNode} tree so
 * it can be property-tested in Node without a DOM, and the browser editor
 * (`static/cms/editor/md-serialize.js`) supplies a matching tree from real DOM
 * nodes. A parity test holds the two implementations to identical output.
 *
 * Known limitations (CommonMark/GFM constraints, not corruption — text is
 * always preserved; only emphasis boundaries or auto-linking may shift):
 *  - Abutting emphasis whose first span ends in punctuation and is followed by
 *    a word char: asterisks fuse, underscore can't close (see `emphasisMarker`).
 *  - Emphasis that starts with punctuation-leading content (e.g. a link) while
 *    immediately preceded by a word char: the opening `*`/`_` is not
 *    left-flanking, so the emphasis can't open. Unrepresentable in CommonMark.
 *  - A bare email/URL in plain text (`a@b.com`, `www.x.com`) is auto-linked by
 *    GFM on render; a second edit then serializes it as an explicit link.
 *  - Links normalize to untitled inline form: editing a block rewrites
 *    reference-style links (`[x][1]`) as inline links and drops link titles
 *    (`"…"`) — text and destination are preserved, the definition lines
 *    elsewhere in the document are untouched. Title support needs `title` in
 *    the shared rich allowlist (v0.4 candidate).
 * The editor doesn't produce these from normal selection-based formatting, so
 * they are documented rather than special-cased.
 */

/** A minimal, DOM-independent representation of inline content. */
export type SNode =
  | { type: "text"; value: string }
  | { type: "element"; tag: string; attrs: Record<string, string>; children: SNode[] };

/** Which block wraps the inline content — determines markers and break rules. */
export type BlockContext =
  | { block: "heading"; level: number }
  | { block: "paragraph"; nested: boolean };

/** Thrown when the tree contains anything outside the closed inline set. */
export class SerializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerializeError";
  }
}

/** ASCII punctuation that CommonMark/GFM lets a backslash escape; we escape the
 *  subset that can change inline parsing (`~` is GFM strikethrough). */
const INLINE_ESCAPE_RE = /[\\`*_[\]<&>~]/g;

function escapeText(value: string): string {
  // Collapse ASCII whitespace runs to a single space FIRST — this is exactly
  // what HTML rendering does visually, and it makes `<br>` the serializer's
  // only newline source. Without it, a raw `\n` in a text node emits a soft
  // line break whose next line can open a block, and 4+ leading spaces form an
  // indented code block when spliced. ` ` (nbsp) is deliberately NOT
  // collapsed — HTML preserves it, so we do too.
  return value.replace(/[ \t\r\n]+/g, " ").replace(INLINE_ESCAPE_RE, (c) => `\\${c}`);
}

/**
 * Escape a leading block-marker so spliced paragraph text can't open a new
 * block. Markers act only at line start, and a bullet / ordered marker triggers
 * even with no following text (`+` alone is an empty list item), so the guard
 * covers end-of-line too. Ordered markers escape the punctuation, not the digit
 * (`\1` is not a valid escape; `1\.` is).
 */
function escapeLineStart(md: string): string {
  const ws = /^\s*/.exec(md)![0];
  const rest = md.slice(ws.length);

  const ordered = /^(\d{1,9})([.)])(\s|$)/.exec(rest);
  if (ordered) {
    return `${ws}${ordered[1]}\\${ordered[2]}${rest.slice(ordered[1].length + 1)}`;
  }

  // Dash/equals runs cover three block constructs at once: setext underlines
  // are ONE-or-more `-`/`=` (a lone `=` after a hard break turns the paragraph
  // into an <h1>), and thematic breaks allow interior spaces (`-- -`). `*`/`_`
  // variants are already neutralized by escapeText.
  const marker =
    /^(?:#{1,6}(?=\s|$)|>|[-+*](?=\s|$)|-(?:[ \t]*-)*[ \t]*$|=(?:[ \t]*=)*[ \t]*$|~{3,}|`{3,}|\|)/.test(
      rest,
    );
  return marker ? `${ws}\\${rest}` : md;
}

function tagOf(node: Extract<SNode, { type: "element" }>): string {
  const t = node.tag.toLowerCase();
  if (t === "b") return "strong";
  if (t === "i") return "em";
  return t;
}

/** Concatenated text of a subtree (for code spans, whose content is literal). */
function rawText(nodes: readonly SNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.value;
    else if (n.tag.toLowerCase() === "br") out += " ";
    else out += rawText(n.children);
  }
  return out;
}

/** Render a code span with a backtick fence long enough to hold the content. */
function codeSpan(content: string): string {
  if (content === "") return "``";
  let runs = content.match(/`+/g) ?? [];
  let fenceLen = 1;
  while (runs.some((r) => r.length === fenceLen)) fenceLen++;
  const fence = "`".repeat(fenceLen);
  // Pad when the content touches a backtick edge or is all spaces (CommonMark rule).
  const needsPad =
    content.startsWith("`") ||
    content.endsWith("`") ||
    (content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "");
  return needsPad ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

/** Represent a link destination, using the `<...>` form when it isn't bare-safe. */
function linkDestination(href: string): string {
  // Control characters (incl. \n, \r) have no representable escape in either
  // destination form — a newline inside `<...>` terminates the destination and
  // injects raw markdown structure. Hard-fail, per this file's philosophy.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(href)) {
    throw new SerializeError("control character in link destination");
  }
  if (/^[^\s<>()\\]*$/.test(href)) return href;
  return `<${href.replace(/([<>\\])/g, "\\$1")}>`;
}

interface InlineOpts {
  allowBreak: boolean;
}

/**
 * Coalesce adjacent siblings that would otherwise emit colliding markdown:
 * consecutive text nodes merge, and consecutive elements of the same
 * (normalized) tag and attributes fuse their children. Without this,
 * `<strong>a</strong><strong>b</strong>` serializes to `**a****b**`, whose
 * `****` run CommonMark parses ambiguously. Merging renders identically and
 * round-trips cleanly.
 */
function mergeAdjacent(nodes: readonly SNode[]): SNode[] {
  const out: SNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === "text" && prev?.type === "text") {
      prev.value += node.value;
      continue;
    }
    if (
      node.type === "element" &&
      prev?.type === "element" &&
      tagOf(prev) === tagOf(node) &&
      tagOf(node) !== "br" &&
      sameAttrs(prev.attrs, node.attrs)
    ) {
      prev.children = [...prev.children, ...node.children];
      continue;
    }
    out.push(node.type === "text" ? { ...node } : { ...node, children: [...node.children] });
  }
  return out;
}

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** First raw character of the next sibling, or "" — used to keep an underscore
 *  emphasis from abutting a word character (CommonMark's intraword rule). */
function nextLeadChar(nodes: readonly SNode[], i: number): string {
  const next = nodes[i + 1];
  if (!next) return "";
  if (next.type === "text") return next.value[0] ?? "";
  return "<"; // an element emits a delimiter/bracket — never a word char
}

/**
 * Emphasis delimiter for the element at `i`. Consecutive `em`/`strong` siblings
 * abut with no text between, so their `*` delimiters would fuse into an
 * ambiguous run (CommonMark's rule of three). We alternate `*`↔`_` across such
 * a run so neighbours never share a delimiter character. Underscore can't close
 * against a following word character, so we fall back to `*` there (safe for
 * every realistic case; see the serializer notes for the one excluded shape).
 */
function emphasisMarker(
  nodes: readonly SNode[],
  i: number,
  prevMarker: "*" | "_" | null,
): "*" | "_" {
  if (prevMarker === null) return "*";
  const flipped = prevMarker === "*" ? "_" : "*";
  if (flipped === "_" && /[A-Za-z0-9_]/.test(nextLeadChar(nodes, i))) return "*";
  return flipped;
}

function serializeChildren(rawNodes: readonly SNode[], opts: InlineOpts): string {
  const nodes = mergeAdjacent(rawNodes);
  let out = "";
  let prevMarker: "*" | "_" | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === "text") {
      out += escapeText(node.value);
      prevMarker = null;
      continue;
    }
    const tag = tagOf(node);
    switch (tag) {
      case "strong": {
        const inner = serializeChildren(node.children, opts);
        if (inner === "") {
          prevMarker = null;
          break;
        }
        const m = emphasisMarker(nodes, i, prevMarker);
        out += `${m}${m}${inner}${m}${m}`;
        prevMarker = m;
        break;
      }
      case "em": {
        const inner = serializeChildren(node.children, opts);
        if (inner === "") {
          prevMarker = null;
          break;
        }
        const m = emphasisMarker(nodes, i, prevMarker);
        out += `${m}${inner}${m}`;
        prevMarker = m;
        break;
      }
      case "code": {
        prevMarker = null;
        out += codeSpan(rawText(node.children));
        break;
      }
      case "a": {
        const href = node.attrs.href;
        if (href === undefined) throw new SerializeError("<a> without href");
        prevMarker = null;
        const inner = serializeChildren(node.children, opts);
        out += `[${inner}](${linkDestination(href)})`;
        break;
      }
      case "br": {
        if (!opts.allowBreak) {
          throw new SerializeError("hard break not allowed in a nested block");
        }
        prevMarker = null;
        out += "\\\n";
        break;
      }
      default:
        throw new SerializeError(`unsupported inline element <${node.tag}>`);
    }
  }
  return out;
}

/**
 * Serialize the inline children of one block to markdown source, ready to
 * splice into the block's source range.
 */
export function serializeBlock(children: readonly SNode[], ctx: BlockContext): string {
  if (ctx.block === "heading") {
    if (!Number.isInteger(ctx.level) || ctx.level < 1 || ctx.level > 6) {
      throw new SerializeError(`invalid heading level: ${ctx.level}`);
    }
    const inline = serializeChildren(children, { allowBreak: false });
    return `${"#".repeat(ctx.level)} ${inline}`;
  }
  const inline = serializeChildren(children, { allowBreak: !ctx.nested });
  // Every LINE of a paragraph must be prevented from opening another block —
  // CommonMark's block scanner runs before inline parsing, so a line after a
  // hard break that starts with `#`/`>`/`- `/etc. would interrupt the
  // paragraph. `escapeText` collapses raw newlines, so the hard-break sequence
  // is the only line boundary the serializer can emit.
  return inline.split("\\\n").map(escapeLineStart).join("\\\n");
}
