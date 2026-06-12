/**
 * Tier-6 (--bind-routes): make a collection DETAIL page (dynamic route) editable.
 *
 * A dynamic route like `src/pages/blog/[slug].astro` renders ONE entry, sourced
 * from `getStaticPaths` props. `deriveScope` skips it ("dynamic-route" — a
 * template has no single static identity), so the tag pass never touches the
 * per-entry fields that are the whole point of the page. This binds each leaf
 * `{entry.data.field}` to the CURRENT entry with a dynamic data-caret — the same
 * per-iteration template-literal trick as `--bind-collections`, but resolved
 * through the `getStaticPaths → props → Astro.props` chain instead of a `.map()`
 * callback:
 *
 *   export async function getStaticPaths() {
 *     const posts = await getCollection('blog');
 *     return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
 *   }
 *   const { post } = Astro.props;
 *   ...
 *   <h1>{post.data.title}</h1>
 *  → <h1 data-caret={`blog::${post.id}::title`}>{post.data.title}</h1>
 *
 * Astro renders the template literal to the concrete `blog::<id>::title` for the
 * page being built, so each detail page binds to its own entry. PURE attribute
 * insertion — same splice + re-parse gate as the tag pass, nothing deleted.
 *
 * Scope (v1): the single-collection `getStaticPaths`-props shape, leaf elements
 * rendering exactly one `entry.data.field`. Anything we can't resolve
 * unambiguously (multiple collections in one `getStaticPaths`, an entry fetched
 * via `getEntry()` / `Astro.params`, a component-prop field) yields no binding —
 * never guess at a permanent storage key.
 */
import { isTagNode, type AstroNode } from "./parse.js";
import { frontmatterRange } from "./frontmatter.js";
import {
  type CollectionBindTarget,
  GET_COLLECTION_RE,
  expressionJs,
  hasCaretAttr,
  iteratorParamShadows,
  soleDataField,
} from "./bind-collection.js";
import { isRewritableTextTag } from "./detect.js";

// `posts.map((post) => ...` — receiver + the iteration parameter.
const MAP_PARAM_RE = /([A-Za-z_$][\w$]*)\s*\.\s*map\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)/g;

/** A standalone identifier inside an object/destructure body (shorthand key). */
function shorthand(name: string): RegExp {
  return new RegExp(`(?:^|[{,\\s])${name}(?:\\s*[,}]|\\s*$)`);
}

/**
 * Resolve the template's current-entry variable and its collection from the
 * frontmatter, or null when the shape isn't the supported single-entry route.
 */
function resolveEntryBinding(
  fmText: string,
): { collection: string; entryVar: string } | null {
  // 1. collections declared anywhere in the frontmatter (getStaticPaths included).
  const collections = new Map<string, string>(); // receiver var -> collection name
  GET_COLLECTION_RE.lastIndex = 0;
  let gm: RegExpExecArray | null;
  while ((gm = GET_COLLECTION_RE.exec(fmText))) collections.set(gm[1], gm[2]);
  if (collections.size === 0) return null;

  // 2. the map parameter tied to a collection receiver: posts.map((post) => ...).
  //    Bail on any ambiguity (two collections mapped) — never guess.
  let collection: string | null = null;
  let param: string | null = null;
  MAP_PARAM_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = MAP_PARAM_RE.exec(fmText))) {
    const col = collections.get(mm[1]);
    if (!col) continue;
    if (collection && (collection !== col || param !== mm[2])) return null;
    collection = col;
    param = mm[2];
  }
  if (!collection || !param) return null;

  // 3. which prop key carries the entry? props: { entry: post } | props: { post }.
  const propsObj = /\bprops\s*:\s*\{([^}]*)\}/.exec(fmText);
  if (!propsObj) return null;
  const propsInner = propsObj[1];
  const explicit = new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${param}\\b`).exec(propsInner);
  const propKey = explicit
    ? explicit[1]
    : shorthand(param).test(propsInner)
      ? param
      : null;
  if (!propKey) return null;

  // 4. the template variable: const { <propKey> } = Astro.props (rename allowed).
  const destruct = /\bconst\s*\{([^}]*)\}\s*=\s*Astro\.props/.exec(fmText);
  if (!destruct) return null;
  const dInner = destruct[1];
  const rename = new RegExp(`\\b${propKey}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(dInner);
  const entryVar = rename
    ? rename[1]
    : shorthand(propKey).test(dInner)
      ? propKey
      : null;
  if (!entryVar) return null;

  return { collection, entryVar };
}

/**
 * Detect current-entry bindings on a dynamic collection-detail route. Returns one
 * target per leaf element rendering `entry.data.field`, or `[]` when the route's
 * entry source can't be resolved unambiguously.
 */
export function detectRouteBindTargets(
  source: string,
  ast: AstroNode,
): CollectionBindTarget[] {
  const fm = frontmatterRange(source);
  if (!fm) return [];
  const resolved = resolveEntryBinding(source.slice(fm.start, fm.end));
  if (!resolved) return [];
  const { collection, entryVar } = resolved;

  const targets: CollectionBindTarget[] = [];
  const visit = (node: AstroNode, shadowed: boolean): void => {
    let nextShadowed = shadowed;
    // A template loop whose callback param reuses the entry variable's name
    // (`{team.map((post) => <li>{post.data.name}</li>)}` on a page whose entry
    // var is `post`) shadows it: inside, `post` is the iterated row. Binding
    // there would write to the wrong collection — skip the whole subtree.
    if (!nextShadowed && node.type === "expression" &&
        iteratorParamShadows(expressionJs(node), entryVar)) {
      nextShadowed = true;
    }

    if (
      !nextShadowed &&
      isTagNode(node) &&
      node.type === "element" &&
      !hasCaretAttr(node) &&
      isRewritableTextTag(node.name)
    ) {
      const field = soleDataField(node, entryVar);
      const startOffset = node.position?.start.offset ?? -1;
      if (field && startOffset >= 0) {
        const value = "`" + collection + "::${" + entryVar + ".id}::" + field + "`";
        targets.push({
          startOffset,
          attribute: "data-caret={" + value + "}",
          collection,
          field,
          tag: node.name,
          receiver: entryVar,
          kind: "route",
        });
      }
    }
    for (const child of node.children ?? []) visit(child, nextShadowed);
  };
  visit(ast, false);
  return targets;
}
