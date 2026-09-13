/**
 * Remark plugin that stamps `data-caret-md` bindings (Astro 6 / unified
 * holdouts). Behaviour-identical to the Sätteri frontend — both call the shared
 * `computeStamp`/`planParagraph`, and a parity test runs the two over the same
 * trees. A tiny internal walker avoids a `unist-util-visit` dependency.
 */

import { computeStamp, planParagraph } from "./stamp.js";

interface CaretRemarkOptions {
  contentRoot: string;
}

interface Pos {
  start?: { offset?: number };
  end?: { offset?: number };
}
interface MdNode {
  type: string;
  position?: Pos;
  children?: MdNode[];
  data?: Record<string, unknown> & { hProperties?: Record<string, unknown> };
}
interface VFileLike {
  value?: unknown;
  path?: string;
  toString(): string;
}

function setData(target: MdNode, attrs: Record<string, string>): void {
  target.data ??= {};
  target.data.hProperties = { ...(target.data.hProperties as object | undefined), ...attrs };
}

/** Remark transformer (returned by the attacher). Exposed for direct testing. */
export function transformCaretRemark(tree: MdNode, file: VFileLike, contentRoot: string): void {
  const source = typeof file.value === "string" ? file.value : file.toString();
  const fileURL = file.path;

  const base = (node: MdNode) => ({
    source,
    fileURL,
    contentRoot,
    start: node.position?.start?.offset,
    end: node.position?.end?.offset,
  });

  const walk = (
    node: MdNode,
    parent: MdNode | undefined,
    ancestorTypes: string[],
    idxPath: number[],
  ): void => {
    if (node.type === "heading") {
      const parentType = ancestorTypes[0] ?? "root";
      const attrs = computeStamp({
        ...base(node),
        blockPath: idxPath,
        ancestorTypes,
        nested: parentType !== "root",
        blockType: "heading",
      });
      if (attrs) setData(node, attrs);
    } else if (node.type === "paragraph") {
      const parentType = ancestorTypes[0] ?? "root";
      const plan = planParagraph(parentType, idxPath[idxPath.length - 1]);
      if (plan.action !== "skip") {
        const toParent = plan.action === "parent";
        const target = toParent ? parent! : node;
        const attrs = computeStamp({
          ...base(node), // the paragraph's (marker-free) offsets
          blockPath: toParent ? idxPath.slice(0, -1) : idxPath,
          ancestorTypes: toParent ? ancestorTypes.slice(1) : ancestorTypes,
          nested: toParent ? true : plan.nested,
          blockType: "paragraph",
        });
        if (attrs) setData(target, attrs);
      }
    }

    if (Array.isArray(node.children)) {
      node.children.forEach((child, i) =>
        walk(child, node, [node.type, ...ancestorTypes], [...idxPath, i]),
      );
    }
  };

  walk(tree, undefined, [], []);
}

export function caretRemarkPlugin(options: CaretRemarkOptions) {
  const { contentRoot } = options;
  return function attacher() {
    return function transform(tree: MdNode, file: VFileLike): void {
      transformCaretRemark(tree, file, contentRoot);
    };
  };
}
