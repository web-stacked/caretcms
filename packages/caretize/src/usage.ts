/**
 * Usage safety classifier — the single safety primitive both wrap tiers depend on.
 *
 * `editable()` stega-encodes EVERY string leaf of the value it wraps (see
 * `@caretcms/core`'s encodeLeaves). An encoded string is invisible and harmless
 * when it renders as visible TEXT, but it CORRUPTS anything it lands in as an
 * attribute — a broken href/src/class/id/datetime. So a literal const is only
 * safe to wrap when every field that flows out of it reaches the DOM as text and
 * never as a native-element attribute.
 *
 * This module answers exactly that, from the `@astrojs/compiler` AST:
 *   - native element (`type:"element"`) + a DYNAMIC attribute that references a
 *     field of the value  →  UNSAFE.
 *   - native element text position (`{item.title}`)                →  safe.
 *   - component (`type:"component"`) attribute that references a field → a prop
 *     hand-off; reported so a cross-file pass can verify the child (Tier-2),
 *     and — depending on `componentHandoffUnsafe` — either tolerated (Tier-1,
 *     preserving prior behavior) or treated as unprovable/UNSAFE (Tier-2 child).
 *
 * The bias is conservative throughout: anything we cannot positively prove is
 * text-only is reported UNSAFE. False negatives (a safe const left unwrapped)
 * are acceptable; a false positive (encoding into an attribute) is not. In line
 * with that, the loop-variable scan over-approximates — within an expression
 * that mentions the const, EVERY `.map()`/`.flatMap()` binding is treated as
 * carrying a field of it, so nested and chained loops can never smuggle a field
 * into an attribute unnoticed.
 */

import { walkTags } from "./parse.js";
import type { AstroNode, TagNode } from "./parse.js";
import { IDENT, identRefRe, referencesIdent } from "./identifiers.js";

export interface Handoff {
  /** Component the value (or a field of it) is passed to. */
  component: string;
  /** Prop name it is passed as. */
  prop: string;
}

export interface UsageVerdict {
  safe: boolean;
  /** Populated when `safe` is false. */
  reason?: string;
  /** Component prop hand-offs of this const, for an optional cross-file check. */
  handoffs: Handoff[];
}

export interface ClassifyOptions {
  /**
   * When true, a field flowing into a component prop counts as UNSAFE (we can't
   * prove how the component renders it). Tier-2's child analysis sets this so a
   * re-pass to a grandchild is conservatively skipped. Tier-1 leaves it false to
   * preserve its established "component prop ≈ text" behavior.
   */
  componentHandoffUnsafe?: boolean;
  /**
   * When true, the `set:html` / `set:text` directives count as TEXT sinks, not
   * native attributes. They render the value as element CONTENT, where stega
   * survives harmlessly — so a field reaching them is safe to encode. Off by
   * default (the wrap tiers stay conservative); the prop-hoist child check sets
   * it so a `<p set:html={prop} />` rich field can be hoisted.
   */
  htmlDirectivesSafe?: boolean;
}

const HTML_DIRECTIVES = new Set(["set:html", "set:text"]);

/** Concatenated raw JS text of an expression node's direct text children. */
function exprJs(node: AstroNode): string {
  let s = "";
  for (const child of node.children ?? []) {
    if (child.type === "text") s += (child as { value?: string }).value ?? "";
  }
  return s;
}

/** The first parameter of an arrow/function param list, respecting brackets. */
function firstParam(paramSrc: string): string {
  let depth = 0;
  let out = "";
  for (const c of paramSrc) {
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) break;
    out += c;
  }
  return out.trim();
}

/** Identifiers bound by a single callback parameter (plain or destructured). */
function paramIdents(param: string): string[] {
  if (!param) return [];
  if (param.startsWith("{") || param.startsWith("[")) {
    // Destructuring: collect every binding identifier. For `{ a: b }` the bound
    // local is `b`; over-collecting (keeping `a` too) only makes us more
    // conservative, which is safe. Rest elements (`...rest`) included likewise.
    const out: string[] = [];
    for (const tok of param.replace(/[[\]{}.]/g, " ").split(/[,\s:=]+/)) {
      const t = tok.trim();
      if (IDENT.test(t)) out.push(t);
    }
    return out;
  }
  // Plain param, possibly with a default (`item = {}`): keep the binding name.
  const name = param.split("=")[0].trim();
  return IDENT.test(name) ? [name] : [];
}

/** Read the callback's first-parameter source starting just after `map(`. */
function readCallbackFirstParam(js: string, from: number): string {
  let i = from;
  const skipWs = (): void => {
    while (i < js.length && /\s/.test(js[i])) i++;
  };
  skipWs();
  if (js.startsWith("async", i) && /[\s(]/.test(js[i + 5] ?? "")) i += 5; // async arrow
  skipWs();
  if (js.startsWith("function", i)) {
    const paren = js.indexOf("(", i);
    if (paren < 0) return "";
    i = paren;
  }
  if (js[i] === "(") {
    let depth = 0;
    let src = "";
    for (; i < js.length; i++) {
      const c = js[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      } else if (depth >= 1) src += c;
    }
    return firstParam(src);
  }
  // Parenless arrow: `x => …` — read up to `=>`, `,` or `)`.
  let src = "";
  while (i < js.length && !/[=,)\s]/.test(js[i])) src += js[i++];
  return src;
}

/**
 * Loop-binding identifiers introduced by `.map()`/`.flatMap()` callbacks in a JS
 * fragment. With `receiver`, only loops over that exact variable are read; with
 * no receiver, EVERY map/flatMap is read (the conservative scan used during
 * classification, so chained/nested loops can't hide a field).
 */
export function mapParamIdents(js: string, receiver?: string): string[] {
  const idents = new Set<string>();
  const head = receiver
    ? `${identRefRe(receiver).source}\\s*\\.\\s*(?:map|flatMap)\\s*\\(`
    : `\\.\\s*(?:map|flatMap)\\s*\\(`;
  const re = new RegExp(head, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(js))) {
    for (const id of paramIdents(readCallbackFirstParam(js, m.index + m[0].length))) {
      idents.add(id);
    }
  }
  return [...idents];
}

/** Attribute kinds that can carry a JS reference (static `quoted`/`empty` cannot). */
function attrIsDynamic(kind: string | undefined): boolean {
  return kind === "expression" || kind === "template-literal" || kind === "shorthand" || kind === "spread";
}

/** Does this attribute reference any of `names` (its value, raw, or shorthand/spread name)? */
function attrReferences(attr: TagNode["attributes"][number], names: string[]): boolean {
  if (attr.kind === "shorthand" || attr.kind === "spread") {
    // `{name}` / `{...name}` — the identifier is the attribute name.
    return names.includes(attr.name) || referencesIdent(attr.name, names);
  }
  return referencesIdent(`${attr.value} ${attr.raw ?? ""}`, names);
}

/**
 * Classify how a literal const `varName` is consumed in a parsed template.
 *
 * For every tag node, the field-carrying identifiers in scope are `varName`
 * itself plus the binding variables of any ancestor expression that mentions
 * `varName` and loops. A dynamic attribute referencing one of those names is the
 * encoded value escaping into a sink: a native element → UNSAFE; a component → a
 * recorded prop hand-off (and UNSAFE too under `componentHandoffUnsafe`). Text
 * positions (`{item.x}` as an element's child) are never attributes, so they
 * never trip this — exactly the leaves `editable()` can safely encode.
 */
export function classifyConstUsage(
  root: AstroNode,
  varName: string,
  opts: ClassifyOptions = {},
): UsageVerdict {
  const handoffs: Handoff[] = [];
  let unsafe: string | undefined;
  const varRe = identRefRe(varName);

  walkTags(root, (node, ancestors) => {
    const names = [varName];
    for (const anc of ancestors) {
      if (anc.type !== "expression") continue;
      const js = exprJs(anc);
      if (varRe.test(js)) names.push(...mapParamIdents(js));
    }

    for (const attr of node.attributes) {
      if (!attrIsDynamic(attr.kind)) continue; // static `quoted`/`empty` are inert
      if (!attrReferences(attr, names)) continue;

      if (node.type === "element") {
        // set:html / set:text render the value as CONTENT, not a real attribute;
        // stega survives there, so (when opted in) it's a safe text sink.
        if (opts.htmlDirectivesSafe && HTML_DIRECTIVES.has(attr.name)) continue;
        // Encoded field would land in a real DOM attribute → corrupting.
        unsafe ??= `field of "${varName}" used in <${node.name}> attribute "${attr.name}"`;
      } else if (node.type === "component") {
        handoffs.push({ component: node.name, prop: attr.name });
        if (opts.componentHandoffUnsafe) {
          unsafe ??= `field of "${varName}" handed to <${node.name}> prop "${attr.name}" (child not verified)`;
        }
      } else {
        // custom-element / fragment — unknown rendering; be conservative.
        unsafe ??= `field of "${varName}" used on <${node.name}> (unverifiable)`;
      }
    }
  });

  if (unsafe) return { safe: false, reason: unsafe, handoffs };
  return { safe: true, handoffs };
}
