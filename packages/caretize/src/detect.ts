/**
 * Detection: decide which tag nodes are edit candidates.
 *
 * The guiding rule — proven necessary by real-world fixtures — is that the
 * candidate set must equal *what the CaretCMS rewrite engine can actually
 * round-trip*. The engine only swaps the text content of a pure text-leaf
 * element (no child markup, unless `data-caret-rich`) and the `src` of an
 * `<img>`. So we tag exactly those and nothing else; anything we can't faithfully
 * edit is skipped (with a reason) rather than tagged into an inert binding.
 */

import { isTagNode, type AstroNode, type TagNode } from "./parse.js";

export type Confidence = "high" | "medium" | "low";
export type CandidateKind = "text" | "image";

export interface Candidate {
  decision: "tag";
  kind: CandidateKind;
  node: TagNode;
  tag: string;
  startOffset: number;
  confidence: Confidence;
  /** The static text content (text candidates) or current src (image). */
  text: string;
  /**
   * True for a rich candidate: the element has child markup, but all of it is
   * sanitizer-safe inline formatting, so it's tagged `data-caret-rich`. Only
   * emitted when `detect` runs with `{ rich: true }`.
   */
  rich?: boolean;
}

export interface DetectOptions {
  /**
   * Enable rich promotion: tag a mixed-content element as `data-caret-rich`
   * when every descendant is sanitizer-safe inline markup (no classes/attrs,
   * no components, no expressions). Off by default — promotion is a judgment
   * call, so it's opt-in via the CLI `--rich` flag.
   */
  rich?: boolean;
  /**
   * Also promote a mixed-content block whose inline children carry a `class` the
   * sanitizer strips unless blessed via the runtime `allowedClasses` config —
   * tagging it `data-caret-rich` even though caretize can't see that config. The
   * styled `class` round-trips only once the user blesses it; the hint names the
   * exact classes. Requires `rich`. Off by default; turned on by `--all` /
   * `--rich-class`. Blocks with any OTHER stripped attr stay `rich-unsafe-attrs`.
   */
  richClass?: boolean;
  /**
   * Local names that `astro:assets` `Image`/`Picture` are imported under (from
   * `imageComponentNames`). These component nodes render to a native `<img>`
   * Astro forwards `data-caret` to, so they're treated as image candidates.
   * Empty/absent by default → components are skipped as before.
   */
  imageComponents?: ReadonlySet<string>;
}

const NO_IMAGE_COMPONENTS: ReadonlySet<string> = new Set();

export interface Skipped {
  decision: "skip";
  node: TagNode;
  tag: string;
  startOffset: number;
  reason: SkipReason;
}

export type SkipReason =
  | "already-tagged"
  | "component" // <MyComponent>, custom element, fragment — won't survive to HTML
  | "inside-expression" // {cond && <h1>}, ternaries, etc. — dynamic
  | "inside-iterator" // {items.map(...)} — dynamic, flagged separately
  | "dynamic-content" // text is an {expression}
  | "inside-rich" // descendant of a node we promoted to data-caret-rich
  | "mixed-children" // block/component child markup — can't round-trip as a field
  | "rich-eligible" // inline-only & lossless — would tag with --rich (run with --rich)
  | "rich-class-promotable" // inline-only but a class needs allowedClasses — tag with --rich-class
  | "rich-unsafe-attrs" // inline-only but carries non-class attrs the sanitizer strips
  | "empty" // no non-whitespace text and no src
  | "not-content"; // structural/non-content element

export interface IteratorFlag {
  /** Byte offset of the enclosing expression. */
  startOffset: number;
  /** The iterator method that triggered the flag (map/filter/...). */
  method: string;
  /** The variable being iterated (`faqs` in `faqs.map(...)`), when a plain
   *  identifier — lets the CLI drop the flag for a loop a wrap tier covered. */
  receiver?: string;
}

export interface DetectResult {
  candidates: Candidate[];
  skipped: Skipped[];
  /** ".map()"-style blocks to surface as "consider a dynamic collection". */
  flags: IteratorFlag[];
}

// Content tags we'll tag, with their confidence tier. Anything not listed is
// treated as non-content and skipped (whitelist, not blacklist).
//
// The key set MUST equal core's REWRITABLE_TEXT_TAGS (runtime/rewrite.ts):
// the rewrite engine only injects stored values into those tags, so tagging
// anything else mints a binding that saves through the editor but never
// renders to visitors. Held in lockstep by tests/unit/contracts-parity.test.ts.
export const CONFIDENCE: Record<string, Confidence> = {
  h1: "high", h2: "high", h3: "high", h4: "high", h5: "high", h6: "high",
  p: "high", blockquote: "high",
  li: "medium", a: "medium", button: "medium", figcaption: "medium",
  summary: "medium", caption: "medium", dt: "medium", dd: "medium",
  th: "medium", td: "medium", label: "medium", legend: "medium",
  span: "low", strong: "low", em: "low", small: "low",
};

/** Can the rewrite engine swap this tag's text content? Gate for every tier
 *  that emits a text binding (tag pass via CONFIDENCE, bind tiers directly). */
export function isRewritableTextTag(tag: string): boolean {
  return tag.toLowerCase() in CONFIDENCE;
}

// Always requires the method call (`.map(`); also captures the immediate
// receiver identifier when it's a plain variable (group 1), so callers can tell
// whether the loop iterates a name a wrap tier already made editable. Receiver
// is optional in the capture so chained/expression receivers (`foo().map(`)
// still flag — they just carry no receiver to match against. Group 2 = method.
const ITERATOR_RE = /(?:([A-Za-z_$][\w$]*)\s*)?\.\s*(map|filter|forEach|flatMap|reduce)\s*\(/;

// Inline formatting tags the rich-text sanitizer keeps. MUST match
// RICH_ALLOWED_TAGS in core's runtime/rich-allowlist.ts (and the hand-mirrored
// static/cms/editor/sanitize.js) — anything outside this set is unwrapped on
// save, so promoting it would not round-trip. Held in lockstep by
// tests/unit/contracts-parity.test.ts.
export const RICH_INLINE_TAGS = new Set([
  "b", "strong", "i", "em", "u", "s", "a", "br", "sub", "sup", "span",
]);

// Attributes the sanitizer keeps. Everything else (notably `class`) is stripped
// on save unless blessed via the runtime `allowedClasses` option — which the
// CLI can't see — so caretize stays conservative and treats any attribute here
// other than these as lossy. MUST match core's RICH_ALLOWED_ATTRS/SAFE_HREF_RE
// (same parity test).
export const RICH_SAFE_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
};
// `(?!\/)` rejects protocol-relative URLs (`//evil.com`). Mirrors core exactly.
export const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|\/(?!\/))/i;

/** How the inline-markup children of a mixed element classify for rich promotion. */
type RichShape =
  | "rich-safe" // all inline, no stripped attrs → lossless as data-caret-rich
  | "rich-class" // all inline; the only stripped attr is class (needs allowedClasses)
  | "rich-unsafe-attrs" // all inline, but some carry a NON-class stripped attr (lossy)
  | "not-inline"; // a block/component/expression child — can't be a rich field

/** Classify one inline element's own attributes against the sanitizer keep set. */
type InlineAttrVerdict =
  | "safe" // every attr is kept (or there are none)
  | "class-only" // the only stripped attr(s) are class — recoverable via allowedClasses
  | "unsafe"; // a non-class attr the sanitizer drops (style, on*, data-*, …)
function inlineAttrVerdict(node: TagNode): InlineAttrVerdict {
  const allowed = RICH_SAFE_ATTRS[node.name.toLowerCase()];
  let sawClass = false;
  for (const a of node.attributes ?? []) {
    if (a.name === "class") {
      sawClass = true;
      continue; // class is gated by allowedClasses, not stripped outright
    }
    if (!allowed || !allowed.has(a.name)) return "unsafe";
    if (a.name === "href" && !SAFE_HREF_RE.test(a.value ?? "")) return "unsafe";
  }
  return sawClass ? "class-only" : "safe";
}

/**
 * Classify a mixed-content element's subtree for rich promotion. Walks every
 * descendant: a non-inline tag / component / expression makes it "not-inline";
 * an inline tag carrying a non-class stripped attr makes it "rich-unsafe-attrs";
 * an inline tag whose only stripped attr is class makes it "rich-class";
 * otherwise "rich-safe". The worst verdict seen wins (unsafe > class > safe).
 */
function classifyRichShape(node: TagNode): RichShape {
  let sawClassOnly = false;
  let sawUnsafe = false;
  const visit = (n: TagNode): "not-inline" | null => {
    for (const child of n.children ?? []) {
      if (child.type === "text") continue;
      if (child.type === "expression") return "not-inline";
      if (isTagNode(child)) {
        if (child.type !== "element") return "not-inline"; // component/fragment
        if (!RICH_INLINE_TAGS.has(child.name.toLowerCase())) return "not-inline";
        const verdict = inlineAttrVerdict(child);
        if (verdict === "unsafe") sawUnsafe = true;
        else if (verdict === "class-only") sawClassOnly = true;
        if (visit(child) === "not-inline") return "not-inline";
      }
      // comments/doctype are inert — ignore
    }
    return null;
  };
  if (visit(node) === "not-inline") return "not-inline";
  if (sawUnsafe) return "rich-unsafe-attrs";
  if (sawClassOnly) return "rich-class";
  return "rich-safe";
}

function attr(node: TagNode, name: string): string | undefined {
  return node.attributes.find((a) => a.name === name)?.value;
}

function hasCaretAttr(node: TagNode): boolean {
  return node.attributes.some(
    (a) => a.name === "data-caret" || a.name === "data-caret-scope",
  );
}

/** Direct text content of an element (concatenated text-node children). */
function directText(node: TagNode): string {
  const parts: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "text") parts.push((child as { value?: string }).value ?? "");
  }
  return parts.join("");
}

/** Classify the children of a (non-image) element. */
function childShape(node: TagNode): "pure-text" | "has-element" | "has-expression" | "empty" {
  let sawText = false;
  for (const child of node.children ?? []) {
    if (child.type === "text") {
      if (((child as { value?: string }).value ?? "").trim() !== "") sawText = true;
      continue;
    }
    if (child.type === "expression") return "has-expression";
    if (isTagNode(child)) return "has-element";
    // comments/doctype/etc. are inert — ignore
  }
  return sawText ? "pure-text" : "empty";
}

function nearestExpressionAncestor(ancestors: AstroNode[]): AstroNode | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].type === "expression") return ancestors[i];
  }
  return undefined;
}

/** Concatenated text of an expression node's direct text children (the JS). */
function expressionText(expr: AstroNode): string {
  const parts: string[] = [];
  for (const child of expr.children ?? []) {
    if (child.type === "text") parts.push((child as { value?: string }).value ?? "");
  }
  return parts.join("");
}

/**
 * Walk a parsed root and classify every tag node.
 *
 * `walk` is injected (the caller passes `walkTags`) so this module stays a pure
 * classifier with no parse dependency beyond the node shape.
 */
export function detect(
  root: AstroNode,
  walk: (root: AstroNode, visit: (n: TagNode, ancestors: AstroNode[]) => void) => void,
  options: DetectOptions = {},
): DetectResult {
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  const imageComponents = options.imageComponents ?? NO_IMAGE_COMPONENTS;
  const flagsByOffset = new Map<number, IteratorFlag>();
  // Nodes promoted to data-caret-rich. Their descendants must NOT be tagged
  // separately (the rich field owns the whole subtree); walkTags is preorder,
  // so a host is recorded before its descendants are visited.
  const richHosts = new Set<TagNode>();

  walk(root, (node, ancestors) => {
    const tag = node.name;
    const startOffset = node.position?.start.offset ?? -1;
    const skip = (reason: SkipReason): void => {
      skipped.push({ decision: "skip", node, tag, startOffset, reason });
    };

    if (hasCaretAttr(node)) {
      // An element already promoted to data-caret-rich still owns its whole
      // subtree on a re-run. Register it as a rich host so its inline
      // descendants are skipped as inside-rich rather than re-tagged at low
      // confidence — without this, a second pass (e.g. --all = rich + low) would
      // mint a duplicate binding inside an existing rich field.
      if (node.attributes.some((a) => a.name === "data-caret-rich")) richHosts.add(node);
      return skip("already-tagged");
    }

    // Inside a node we already promoted to rich → the rich field owns it.
    if (ancestors.some((a) => richHosts.has(a as TagNode))) return skip("inside-rich");

    // astro:assets <Image>/<Picture> are component nodes, but they render to a
    // native <img> that Astro forwards data-caret to — so they're image
    // candidates, not opaque components. Recognized only when resolved from an
    // `import … from "astro:assets"` (via options.imageComponents); they still
    // fall through the iterator/expression skip below, so an <Image> inside a
    // .map() is deferred, not mis-tagged.
    const isImageComponent = node.type === "component" && imageComponents.has(node.name);
    if (node.type !== "element" && !isImageComponent) return skip("component");

    // Dynamic context: inside any {expression}. Record an iterator flag if the
    // enclosing expression looks like a .map()/.filter() loop.
    const expr = nearestExpressionAncestor(ancestors);
    if (expr) {
      const text = expressionText(expr);
      const m = ITERATOR_RE.exec(text);
      const exprOffset = expr.position?.start.offset ?? startOffset;
      if (m && !flagsByOffset.has(exprOffset)) {
        flagsByOffset.set(exprOffset, {
          startOffset: exprOffset, method: m[2], receiver: m[1],
        });
      }
      return skip(m ? "inside-iterator" : "inside-expression");
    }

    if (tag === "img" || isImageComponent) {
      const srcAttr = node.attributes.find((a) => a.name === "src");
      if (srcAttr === undefined || srcAttr.value.trim() === "") return skip("empty");
      // A dynamic src (`src={expr}`, template literal, shorthand) has no
      // author-time URL to surface in review; the binding key is assigned by
      // assignFields regardless, and the engine swaps the rendered <img> src.
      const staticSrc = srcAttr.kind === "quoted" || srcAttr.kind === undefined;
      candidates.push({
        decision: "tag", kind: "image", node, tag, startOffset,
        confidence: "high", text: staticSrc ? srcAttr.value : "",
      });
      return;
    }

    if (!(tag in CONFIDENCE)) return skip("not-content");

    const shape = childShape(node);
    if (shape === "has-expression") return skip("dynamic-content");
    if (shape === "empty") return skip("empty");
    if (shape === "has-element") {
      // Mixed content: a block/component child can't round-trip as a field, but
      // a subtree of only sanitizer-safe inline markup can — as a rich field.
      // Only promote genuine content hosts (block text / links), not the
      // low-confidence generic inline containers (span/div/strong/em/…).
      const richShape = classifyRichShape(node);
      const promotable = CONFIDENCE[tag] !== "low";
      if (richShape === "not-inline" || !promotable) return skip("mixed-children");
      if (richShape === "rich-unsafe-attrs") return skip("rich-unsafe-attrs");
      if (richShape === "rich-class" && !(options.rich && options.richClass)) {
        // Inline-only except for a class the sanitizer strips unless blessed via
        // allowedClasses. Surfaced (so the hint can name the classes) until both
        // --rich and --rich-class (the latter rides in --all) are on.
        return skip("rich-class-promotable");
      }
      // rich-safe: promote only when opted in; otherwise report it as eligible.
      if (richShape === "rich-safe" && !options.rich) return skip("rich-eligible");
      richHosts.add(node);
      candidates.push({
        decision: "tag", kind: "text", node, tag, startOffset,
        confidence: "medium", text: directText(node).trim(), rich: true,
      });
      return;
    }

    candidates.push({
      decision: "tag", kind: "text", node, tag, startOffset,
      confidence: CONFIDENCE[tag], text: directText(node).trim(),
    });
  });

  return {
    candidates,
    skipped,
    flags: [...flagsByOffset.values()].sort((a, b) => a.startOffset - b.startOffset),
  };
}
