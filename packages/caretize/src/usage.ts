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

import { walkTags, isTagNode } from "./parse.js";
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
 * Field names whose values CaretCMS core never marks with a binding key — they
 * are identifiers, not prose. Mirrors core's MACHINE_FIELD
 * (runtime/stega-policy.ts); held identical by tests/unit/contracts-parity.test.ts.
 */
export const MACHINE_FIELD = /^(id|uid|uuid|slug|key|lang|locale|type|kind|variant|layout|template|icon|class|classname|color|colour|theme|target|rel|format|currency|status|mode|code|tag|tags|hash|anchor|component)$/i;

/** Whether core leaves a field of this name unmarked (an identifier field). */
export function isMachineField(name: string): boolean {
  return MACHINE_FIELD.test(name);
}

const ARRAY_CALLBACK_METHODS = "map|flatMap|filter|find|findIndex|findLast|findLastIndex|some|every|forEach|sort|toSorted|reduce";

/**
 * Locals bound by a destructuring param, each with the field it reads:
 * `{ key, label: name }` → key→key, name→label. Nested patterns and array
 * destructuring map to no field (null), which callers treat as unprovable.
 */
function destructuredFields(param: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!param.startsWith("{")) {
    for (const id of paramIdents(param)) out.set(id, null);
    return out;
  }
  const body = param.slice(1, param.lastIndexOf("}"));
  let depth = 0;
  let part = "";
  const parts: string[] = [];
  for (const c of body) {
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(part); part = ""; } else part += c;
  }
  parts.push(part);
  for (const raw of parts) {
    const p = raw.trim().replace(/\s*=.*$/s, "");
    if (!p) continue;
    if (p.startsWith("...")) { out.set(p.slice(3).trim(), null); continue; }
    const colon = p.indexOf(":");
    if (colon < 0) { if (IDENT.test(p)) out.set(p, p); continue; }
    const field = p.slice(0, colon).trim();
    const local = p.slice(colon + 1).trim();
    if (IDENT.test(local)) out.set(local, IDENT.test(field) ? field : null);
    else for (const id of paramIdents(local)) out.set(id, null); // nested pattern
  }
  return out;
}

/** Contexts where a value is used as an identifier rather than shown. */
const COMPARE_AFTER = /^\s*(?:===|!==|==|!=)/;
const COMPARE_BEFORE = /(?:===|!==|==|!=|\bcase|\bswitch\s*\(|[\w$\])]\s*\[|\.\s*(?:includes|has|get|indexOf|lastIndexOf|startsWith|endsWith)\s*\()\s*$/;

/**
 * Where a value of `varName` is used as an identifier — compared
 * (`=== s.key`), switched on, or used as a lookup key (`map[s.key]`,
 * `.includes(s.key)`, `.get(s.key)`) — across the frontmatter and every
 * template expression. Each use reports the field it reads (`key`), or null
 * when the whole value (or an unprovable part of it) is used.
 *
 * Locals follow the value through array callbacks on it (`sections.map((s) =>`,
 * `s.items.filter((it) =>`), plain or destructured.
 */
export function identifierUses(root: AstroNode, varName: string): Array<string | null> {
  const chunks: string[] = [];
  const collect = (node: AstroNode): void => {
    if (node.type === "frontmatter") chunks.push((node as { value?: string }).value ?? "");
    if (node.type === "expression") chunks.push(exprJs(node));
    for (const child of node.children ?? []) collect(child);
  };
  collect(root);
  const js = chunks.join("\n;\n");

  // local → the field it holds (null = the value itself / an element of it).
  const locals = new Map<string, string | null>([[varName, null]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const name of [...locals.keys()]) {
      const head = new RegExp(
        `${identRefRe(name).source}(?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)*\\s*\\??\\.\\s*(?:${ARRAY_CALLBACK_METHODS})\\s*\\(`,
        "g",
      );
      for (const m of js.matchAll(head)) {
        const param = readCallbackFirstParam(js, (m.index ?? 0) + m[0].length);
        for (const [local, field] of destructuredFields(param)) {
          if (!locals.has(local)) { locals.set(local, field); grew = true; }
        }
      }
    }
  }

  const uses: Array<string | null> = [];
  for (const [name, heldField] of locals) {
    const ref = new RegExp(
      `${identRefRe(name).source}((?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*|\\[\\s*["'][^"']+["']\\s*\\])*)`,
      "g",
    );
    for (const m of js.matchAll(ref)) {
      const start = m.index ?? 0;
      // A member of something else (`obj.key`), or a declaration/param, is not
      // a read of this local.
      if (/\.\s*$/.test(js.slice(Math.max(0, start - 4), start))) continue;
      const end = start + m[0].length;
      // A method call on the value (`s.label.toUpperCase()`) reads it as text.
      if (/^\s*\(/.test(js.slice(end, end + 4)) && m[1]) continue;
      if (!COMPARE_AFTER.test(js.slice(end, end + 6)) && !COMPARE_BEFORE.test(js.slice(Math.max(0, start - 40), start))) continue;
      const members = [...(m[1] ?? "").matchAll(/[A-Za-z_$][\w$]*|["']([^"']+)["']/g)].map((x) => x[1] ?? x[0]);
      uses.push(members.length ? members[members.length - 1] : heldField);
    }
  }
  return uses;
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

  // A field used as an identifier (compared, switched on, a lookup key) must
  // come out of editable() byte-for-byte. Core leaves identifier-named fields
  // (key, id, slug, …) unmarked, so those are fine; any other field — or the
  // value itself — would carry a hidden binding key into the comparison.
  if (!unsafe) {
    const compared = identifierUses(root, varName).find((f) => f === null || !isMachineField(f));
    if (compared !== undefined) {
      unsafe = compared === null
        ? `"${varName}" is compared or used as a lookup key`
        : `field "${compared}" of "${varName}" is compared or used as a lookup key`;
    }
  }

  if (unsafe) return { safe: false, reason: unsafe, handoffs };
  return { safe: true, handoffs };
}

/** Elements that live in (or feed) the document `<head>`. A field rendered only
 *  here is text-safe for stega, but the inline editor's click-to-edit can never
 *  surface it — so it isn't a real editable sink. */
const HEAD_ELEMENTS = new Set(["head", "title", "meta", "base", "link"]);

function inHead(ancestors: AstroNode[], node?: AstroNode): boolean {
  if (node && isTagNode(node) && HEAD_ELEMENTS.has(node.name)) return true;
  return ancestors.some((a) => isTagNode(a) && HEAD_ELEMENTS.has(a.name));
}

/**
 * Does the template render any of `names` in a BODY-reachable position — a text
 * expression (`{title}`) or a `set:html`/`set:text` content sink — that is NOT
 * inside the document `<head>`?
 *
 * `classifyConstUsage` proves a field never lands in a corrupting attribute, but
 * a field that renders ONLY into `<head>` (a layout's `<title>{title}</title>`)
 * is text-safe yet has no click-to-edit target. The prop-hoist tier requires a
 * positive body sink so it doesn't mint `editable()` bindings the editor can't
 * surface (and, incidentally, won't hoist a prop the child never renders at all).
 */
export function rendersOutsideHead(root: AstroNode, names: string[]): boolean {
  let found = false;
  const stack: AstroNode[] = [];
  const visit = (node: AstroNode): void => {
    if (found || !node || typeof node !== "object") return;

    if (node.type === "expression" && referencesIdent(exprJs(node), names) && !inHead(stack)) {
      found = true;
      return;
    }
    if (isTagNode(node) && !inHead(stack, node)) {
      for (const attr of node.attributes) {
        if (HTML_DIRECTIVES.has(attr.name) && attrReferences(attr, names)) {
          found = true;
          return;
        }
      }
    }

    const children = node.children;
    if (Array.isArray(children)) {
      stack.push(node);
      for (const child of children) visit(child);
      stack.pop();
    }
  };
  visit(root);
  return found;
}
