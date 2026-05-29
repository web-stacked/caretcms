/**
 * Thin wrapper over `@astrojs/compiler` for caretize: parse a `.astro` source,
 * walk its tag nodes, and tag-then-verify an element.
 *
 * Minimal structural node types are declared locally rather than imported from
 * the compiler's type barrels, so we stay decoupled from which entrypoint
 * happens to re-export the AST interfaces. We only need a handful of fields.
 */

import { parse } from "@astrojs/compiler";
import { findOpenTagEnd, spliceAttribute } from "./splice.js";

/** A tag-like AST node (element / component / custom-element / fragment). */
export interface TagNode {
  type: "element" | "component" | "custom-element" | "fragment";
  name: string;
  attributes: Array<{ type: string; name: string; value: string }>;
  children: AstroNode[];
  position?: { start: { offset: number }; end?: { offset: number } };
}

export interface ContainerNode {
  type: string;
  children?: AstroNode[];
  position?: { start: { offset: number }; end?: { offset: number } };
}

export type AstroNode = (TagNode | ContainerNode) & {
  type: string;
  children?: AstroNode[];
};

const TAG_TYPES = new Set(["element", "component", "custom-element", "fragment"]);

export function isTagNode(node: AstroNode): node is TagNode {
  return TAG_TYPES.has(node.type);
}

/** Parse a `.astro` source into its AST root with byte positions populated. */
export async function parseAstro(source: string): Promise<AstroNode> {
  const result = await parse(source, { position: true });
  return result.ast as unknown as AstroNode;
}

/**
 * Depth-first walk over every tag-like node in document order. The callback
 * receives the node and its chain of ancestor nodes (root-first), so callers
 * can answer "am I inside an expression / iterator / a given scope?" without
 * re-walking.
 */
export function walkTags(
  root: AstroNode,
  visit: (node: TagNode, ancestors: AstroNode[]) => void,
): void {
  const stack: AstroNode[] = [];
  const recurse = (node: AstroNode): void => {
    if (!node || typeof node !== "object") return;
    if (isTagNode(node)) visit(node, [...stack]);
    const children = node.children;
    if (Array.isArray(children)) {
      stack.push(node);
      for (const child of children) recurse(child);
      stack.pop();
    }
  };
  recurse(root);
}

export interface TagResult {
  /** The spliced source (only meaningful when `ok` is true). */
  output: string;
  /** True when the attribute was inserted AND the result re-parses with the
   *  attribute present on the intended element. */
  ok: boolean;
  /** Populated when `ok` is false, explaining why the splice was rejected. */
  reason?: string;
}

/**
 * Splice ` ${attribute}` into the opening tag of the element at `startOffset`,
 * then re-parse the result to confirm (a) it still parses and (b) the intended
 * element now carries the attribute. This converts a bad offset from "silent
 * file corruption" into a rejected, recoverable result — the safety net the
 * writer wraps every change in.
 *
 * `attribute` is the full attribute text WITHOUT a leading space, e.g.
 * `data-caret="pages::home::headline"`.
 */
export async function tagElementAndVerify(
  source: string,
  element: { name: string; startOffset: number },
  attribute: string,
  attrName = "data-caret",
): Promise<TagResult> {
  const buf = Buffer.from(source, "utf8");
  const found = findOpenTagEnd(buf, element.startOffset);
  if (!found) {
    return { output: source, ok: false, reason: "could not locate end of opening tag" };
  }

  const spliced = spliceAttribute(buf, found.insertAt, ` ${attribute}`);
  const output = spliced.toString("utf8");

  // Re-parse and confirm the intended element (still at the same start offset,
  // since we inserted strictly after the tag's `<`) now has the attribute.
  let verifiedNode: TagNode | undefined;
  try {
    const reAst = await parseAstro(output);
    walkTags(reAst, (node) => {
      if (verifiedNode) return;
      if (
        node.name === element.name &&
        node.position?.start.offset === element.startOffset &&
        node.attributes.some((a) => a.name === attrName)
      ) {
        verifiedNode = node;
      }
    });
  } catch (err) {
    return {
      output: source,
      ok: false,
      reason: `re-parse threw: ${(err as Error).message}`,
    };
  }

  if (!verifiedNode) {
    return {
      output: source,
      ok: false,
      reason: "attribute not present on intended element after re-parse",
    };
  }

  return { output, ok: true };
}
