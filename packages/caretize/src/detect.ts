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
  | "mixed-children" // contains child markup; engine needs data-caret-rich (v1: skip)
  | "empty" // no non-whitespace text and no src
  | "not-content"; // structural/non-content element

export interface IteratorFlag {
  /** Byte offset of the enclosing expression. */
  startOffset: number;
  /** The iterator method that triggered the flag (map/filter/...). */
  method: string;
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

const ITERATOR_RE = /\.(map|filter|forEach|flatMap|reduce)\s*\(/;

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
): DetectResult {
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  const flagsByOffset = new Map<number, IteratorFlag>();

  walk(root, (node, ancestors) => {
    const tag = node.name;
    const startOffset = node.position?.start.offset ?? -1;
    const skip = (reason: SkipReason): void => {
      skipped.push({ decision: "skip", node, tag, startOffset, reason });
    };

    if (hasCaretAttr(node)) return skip("already-tagged");

    if (node.type !== "element") return skip("component"); // component/custom-element/fragment

    // Dynamic context: inside any {expression}. Record an iterator flag if the
    // enclosing expression looks like a .map()/.filter() loop.
    const expr = nearestExpressionAncestor(ancestors);
    if (expr) {
      const text = expressionText(expr);
      const m = ITERATOR_RE.exec(text);
      const exprOffset = expr.position?.start.offset ?? startOffset;
      if (m && !flagsByOffset.has(exprOffset)) {
        flagsByOffset.set(exprOffset, { startOffset: exprOffset, method: m[1] });
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
    if (shape === "has-element") return skip("mixed-children");
    if (shape === "empty") return skip("empty");

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
