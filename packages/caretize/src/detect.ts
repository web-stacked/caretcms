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
}

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
  | "rich-unsafe-attrs" // inline-only but carries class/attrs the sanitizer strips
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
const CONFIDENCE: Record<string, Confidence> = {
  h1: "high", h2: "high", h3: "high", h4: "high", h5: "high", h6: "high",
  p: "high", blockquote: "high",
  li: "medium", a: "medium", button: "medium", figcaption: "medium",
  summary: "medium", caption: "medium", dt: "medium", dd: "medium",
  th: "medium", td: "medium", label: "medium",
  span: "low", div: "low", strong: "low", em: "low", small: "low",
  code: "low", cite: "low", b: "low", i: "low", mark: "low", q: "low",
};

// Always requires the method call (`.map(`); also captures the immediate
// receiver identifier when it's a plain variable (group 1), so callers can tell
// whether the loop iterates a name a wrap tier already made editable. Receiver
// is optional in the capture so chained/expression receivers (`foo().map(`)
// still flag — they just carry no receiver to match against. Group 2 = method.
const ITERATOR_RE = /(?:([A-Za-z_$][\w$]*)\s*)?\.\s*(map|filter|forEach|flatMap|reduce)\s*\(/;

// Inline formatting tags the rich-text sanitizer keeps. MUST match ALLOWED_TAGS
// in core's sanitize-html.ts / static/cms/editor/sanitize.js — anything outside
// this set is unwrapped on save, so promoting it would not round-trip.
const RICH_INLINE_TAGS = new Set([
  "b", "strong", "i", "em", "u", "s", "a", "br", "sub", "sup",
]);

// Attributes the sanitizer keeps. Everything else (notably `class`) is stripped
// on save unless blessed via the runtime `allowedClasses` option — which the
// CLI can't see — so caretize stays conservative and treats any attribute here
// other than these as lossy.
const RICH_SAFE_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
};
const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|\/)/i;

/** How the inline-markup children of a mixed element classify for rich promotion. */
type RichShape =
  | "rich-safe" // all inline, no stripped attrs → lossless as data-caret-rich
  | "rich-unsafe-attrs" // all inline tags, but some carry class/attrs (lossy)
  | "not-inline"; // a block/component/expression child — can't be a rich field

/** Are this element's own attributes within the sanitizer's keep set? */
function inlineAttrsSafe(node: TagNode): boolean {
  const allowed = RICH_SAFE_ATTRS[node.name.toLowerCase()];
  for (const a of node.attributes ?? []) {
    if (!allowed || !allowed.has(a.name)) return false;
    if (a.name === "href" && !SAFE_HREF_RE.test(a.value ?? "")) return false;
  }
  return true;
}

/**
 * Classify a mixed-content element's subtree for rich promotion. Walks every
 * descendant: a non-inline tag / component / expression makes it "not-inline";
 * an inline tag carrying a stripped attribute makes it "rich-unsafe-attrs";
 * otherwise "rich-safe". `attrsClean` threads the downgrade through recursion.
 */
function classifyRichShape(node: TagNode): RichShape {
  let attrsClean = true;
  const visit = (n: TagNode): RichShape | null => {
    for (const child of n.children ?? []) {
      if (child.type === "text") continue;
      if (child.type === "expression") return "not-inline";
      if (isTagNode(child)) {
        if (child.type !== "element") return "not-inline"; // component/fragment
        if (!RICH_INLINE_TAGS.has(child.name.toLowerCase())) return "not-inline";
        if (!inlineAttrsSafe(child)) attrsClean = false;
        const nested = visit(child);
        if (nested === "not-inline") return "not-inline";
      }
      // comments/doctype are inert — ignore
    }
    return null;
  };
  if (visit(node) === "not-inline") return "not-inline";
  return attrsClean ? "rich-safe" : "rich-unsafe-attrs";
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

    if (hasCaretAttr(node)) return skip("already-tagged");

    // Inside a node we already promoted to rich → the rich field owns it.
    if (ancestors.some((a) => richHosts.has(a as TagNode))) return skip("inside-rich");

    if (node.type !== "element") return skip("component"); // component/custom-element/fragment

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

    if (tag === "img") {
      const src = attr(node, "src");
      if (src === undefined || src.trim() === "") return skip("empty");
      candidates.push({
        decision: "tag", kind: "image", node, tag, startOffset,
        confidence: "high", text: src,
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
      // rich-safe: promote only when opted in; otherwise report it as eligible.
      if (!options.rich) return skip("rich-eligible");
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
