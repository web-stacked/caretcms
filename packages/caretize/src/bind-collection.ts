/**
 * Tier-5 (--bind-collections): make `getCollection().map(...)` loops editable.
 *
 * Where the other tiers flag a fetched-data loop as "consider a dynamic
 * collection", this binds the DIRECT-RENDER case in place: a leaf element whose
 * only dynamic content is `{item.data.field}` gets a dynamic data-caret:
 *
 *     <h2>{post.data.title}</h2>
 *  →  <h2 data-caret={`blog::${post.id}::title`}>{post.data.title}</h2>
 *
 * Astro renders the template literal to the concrete `blog::<id>::title` per
 * iteration, so the inline editor binds each row to its own entry. This is a
 * PURE attribute insertion (the same splice + re-parse gate as the data-caret
 * tag pass) — no rewrite of the map callback, nothing deleted, fully invertible.
 *
 * Scope (v1): only leaf elements rendering exactly one `item.data.X` and nothing
 * else. The component-prop case (`<Card title={post.data.title}/>`) needs
 * cross-file resolution and stays a flag.
 */
import { isTagNode, type AstroNode, type TagNode } from "./parse.js";
import { frontmatterRange } from "./frontmatter.js";

export interface CollectionBindTarget {
  /** Element opening-tag start offset — where the data-caret attribute splices in. */
  startOffset: number;
  /** Attribute text to insert, e.g. ``data-caret={`blog::${post.id}::title`}``. */
  attribute: string;
  collection: string;
  field: string;
  tag: string;
}

// `const posts = await getCollection('releases')` (also .sort()/.filter() chains —
// the call just has to appear in the initializer). Captures receiver + collection.
const GET_COLLECTION_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\s\S]*?getCollection\(\s*['"]([^'"]+)['"]\s*\)/g;

// `posts.map((post) => ...` — receiver + the iteration parameter.
const MAP_RE = /([A-Za-z_$][\w$]*)\s*\.\s*map\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)/;

/** Concatenated JS text of an expression node's direct text children. */
function expressionJs(node: AstroNode): string {
  let out = "";
  for (const child of node.children ?? []) {
    if (child.type === "text") out += (child as { value?: string }).value ?? "";
  }
  return out;
}

function hasCaretAttr(node: TagNode): boolean {
  return node.attributes?.some(
    (a) => a.name === "data-caret" || a.name === "data-caret-rich",
  ) ?? false;
}

/** If `el` is a leaf element whose only dynamic content is `{<param>.data.<field>}`
 *  (no literal text, no child elements, exactly one expression), return the field. */
function soleDataField(el: TagNode, param: string): string | null {
  let field: string | null = null;
  for (const child of el.children ?? []) {
    if (child.type === "text") {
      if ((child as { value?: string }).value?.trim()) return null; // mixed literal text
      continue;
    }
    if (child.type === "expression") {
      if (field) return null; // more than one expression
      const m = new RegExp(`^${param}\\.data\\.([A-Za-z_$][\\w$]*)$`).exec(
        expressionJs(child).trim(),
      );
      if (!m) return null;
      field = m[1];
      continue;
    }
    return null; // a nested element/component — not a leaf text element
  }
  return field;
}

/**
 * Detect direct-render collection-loop bindings. Returns one target per leaf
 * element rendering `item.data.field` inside a `getCollection(...).map(...)`.
 */
export function detectCollectionBindTargets(source: string, ast: AstroNode): CollectionBindTarget[] {
  const fm = frontmatterRange(source);
  if (!fm) return [];
  const collections = new Map<string, string>(); // receiver var -> collection name
  const fmText = source.slice(fm.start, fm.end);
  GET_COLLECTION_RE.lastIndex = 0;
  let gm: RegExpExecArray | null;
  while ((gm = GET_COLLECTION_RE.exec(fmText))) collections.set(gm[1], gm[2]);
  if (collections.size === 0) return [];

  const targets: CollectionBindTarget[] = [];

  const visit = (node: AstroNode, ctx: { collection: string; param: string } | null): void => {
    let nextCtx = ctx;
    if (node.type === "expression") {
      const mm = MAP_RE.exec(expressionJs(node));
      const collection = mm && collections.get(mm[1]);
      if (collection) nextCtx = { collection, param: mm[2] };
    }

    if (nextCtx && isTagNode(node) && node.type === "element" && !hasCaretAttr(node)) {
      const field = soleDataField(node, nextCtx.param);
      const startOffset = node.position?.start.offset ?? -1;
      if (field && startOffset >= 0) {
        const value = "`" + nextCtx.collection + "::${" + nextCtx.param + ".id}::" + field + "`";
        targets.push({
          startOffset,
          attribute: "data-caret={" + value + "}",
          collection: nextCtx.collection,
          field,
          tag: node.name,
        });
      }
    }

    for (const child of node.children ?? []) visit(child, nextCtx);
  };
  visit(ast, null);
  return targets;
}
