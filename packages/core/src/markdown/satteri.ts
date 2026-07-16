/**
 * Sätteri mdast plugin that stamps `data-caret-md` bindings (Astro 7).
 *
 * Registered on `markdown.processor.options.mdastPlugins` by the integration
 * when markdown storage is active. Position tracking is opt-in, so the plugin
 * declares `options: { position: true }`. Attributes are written through the
 * per-node `data.hProperties` bag, which Sätteri carries into the rendered
 * HTML like remark-rehype.
 *
 * Type-only imports keep core free of a `satteri` runtime dependency — the
 * package is present in the user's Astro build, never shipped by us.
 */

import type { MdastPluginDefinition } from "satteri";
import { computeStamp, planParagraph, type StampInput } from "./stamp.js";

interface CaretSatteriOptions {
  contentRoot: string;
}

// A minimal structural view of the nodes/context we touch, so this file needs
// no value import from `satteri`.
interface Pos {
  start?: { offset?: number };
  end?: { offset?: number };
}
interface Node {
  type: string;
  position?: Pos;
  data?: Record<string, unknown> & { hProperties?: Record<string, unknown> };
}
interface Ctx {
  fileURL: URL | undefined;
  source: string;
  parent(node: Node): Node | undefined;
  indexOf(node: Node): number | undefined;
  setProperty(node: Node, key: "data", value: Record<string, unknown>): void;
}

// Sätteri (Rust / pulldown-cmark) reports positions as UTF-8 BYTE offsets,
// while our contracts, hashing, and the server-side splice all work in JS
// string (UTF-16 code unit) space. Convert once per document. Memoized because
// a document's blocks are visited consecutively against the same `ctx.source`.
let byteMapCache: { source: string; prefix: Uint32Array } | null = null;

function byteToStringIndex(source: string, byteOffset: number): number {
  if (!byteMapCache || byteMapCache.source !== source) {
    const prefix = new Uint32Array(source.length + 1);
    let bytes = 0;
    for (let i = 0; i < source.length; ) {
      const cp = source.codePointAt(i)!;
      const units = cp > 0xffff ? 2 : 1;
      prefix[i] = bytes;
      if (units === 2) prefix[i + 1] = bytes; // low surrogate: mid-char
      bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      i += units;
    }
    prefix[source.length] = bytes;
    byteMapCache = { source, prefix };
  }
  const { prefix } = byteMapCache;
  // Smallest string index whose byte-prefix reaches byteOffset.
  let lo = 0;
  let hi = source.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] < byteOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Root-to-node child indexes (`indexOf` returns `undefined` at the root). */
function pathOf(node: Node, ctx: Ctx): number[] {
  const idx: number[] = [];
  let cur: Node | undefined = node;
  while (cur) {
    const i = ctx.indexOf(cur);
    if (i === undefined) break;
    idx.unshift(i);
    cur = ctx.parent(cur);
  }
  return idx;
}

/** Ancestor node types, nearest-first, excluding the node itself. */
function ancestorTypes(node: Node, ctx: Ctx): string[] {
  const out: string[] = [];
  let cur = ctx.parent(node);
  while (cur) {
    out.push(cur.type);
    cur = ctx.parent(cur);
  }
  return out;
}

function stamp(target: Node, ctx: Ctx, input: StampInput): void {
  const attrs = computeStamp(input);
  if (!attrs) return;
  const data = { ...(target.data ?? {}) };
  data.hProperties = { ...(data.hProperties as object | undefined), ...attrs };
  ctx.setProperty(target, "data", data);
}

export function caretSatteriPlugin(options: CaretSatteriOptions): MdastPluginDefinition {
  const { contentRoot } = options;
  const base = (node: Node, ctx: Ctx) => {
    const startByte = node.position?.start?.offset;
    const endByte = node.position?.end?.offset;
    return {
      source: ctx.source,
      fileURL: ctx.fileURL,
      contentRoot,
      start: startByte == null ? undefined : byteToStringIndex(ctx.source, startByte),
      end: endByte == null ? undefined : byteToStringIndex(ctx.source, endByte),
    };
  };

  return {
    name: "caretcms-stamp",
    options: { position: true },

    heading(node: Node, ctx: Ctx) {
      const parentType = ctx.parent(node)?.type ?? "root";
      stamp(node, ctx, {
        ...base(node, ctx),
        blockPath: pathOf(node, ctx),
        ancestorTypes: ancestorTypes(node, ctx),
        nested: parentType !== "root",
        blockType: "heading",
      });
    },

    paragraph(node: Node, ctx: Ctx) {
      const parent = ctx.parent(node);
      const plan = planParagraph(parent?.type ?? "root", ctx.indexOf(node));
      if (plan.action === "skip") return;
      const target = plan.action === "parent" ? parent! : node;
      stamp(target, ctx, {
        ...base(node, ctx), // the paragraph's (marker-free) offsets
        blockPath: pathOf(target, ctx),
        ancestorTypes: ancestorTypes(target, ctx),
        nested: plan.action === "parent" ? true : plan.nested,
      });
    },
  } as unknown as MdastPluginDefinition;
}
