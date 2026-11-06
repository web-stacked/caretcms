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
  /** Local names of imported image files (see `assetImportNames`). A dynamic
   *  src is tagged only when it is one of these (`hero` or `hero.src`). */
  assetImports?: ReadonlySet<string>;
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
  | "dynamic-src" // image src comes from props/data — bind it at its source (editable(), caretLoader)
  | "inside-rich" // descendant of a node we promoted to data-caret-rich
  | "mixed-children" // block/component child markup — can't round-trip as a field
  | "rich-eligible" // inline-only & lossless — would tag with --rich (run with --rich)
  | "rich-class-promotable" // inline-only but a class needs allowedClasses — tag with --rich-class
  | "rich-unsafe-attrs" // inline-only but carries non-class attrs the sanitizer strips
  | "empty" // no non-whitespace text and no src
  | "script-hook" // a script finds it (valueless data-*, or a class/id its <script> selects)
  | "ui-control" // <button> label (and its contents): interface chrome, not page content
  | "home-link" // the <a href="/"> home link / logo: the site name, not page content
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
  "b", "strong", "i", "em", "u", "s", "a", "br", "sub", "sup", "span", "code",
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
export const SAFE_HREF_RE = /^(?!.*[\u0000-\u001f\u007f\\])(?:https?:|mailto:|tel:|\/(?!\/))/i;

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

/** Classes and ids a component's own `<script>` looks elements up by. */
export interface ScriptHooks {
  classes: Set<string>;
  ids: Set<string>;
}

// Optional TS type argument (`querySelectorAll<HTMLElement>(…)`), then a
// string literal first argument.
const STRING_ARG = String.raw`(?:<[^<>()]*>)?\s*\(\s*(?:"([^"]*)"|'([^']*)'|\x60([^\x60$]*)\x60)`;
const SELECTOR_CALL_RE = new RegExp(String.raw`\.\s*(?:querySelector(?:All)?|closest|matches)\s*` + STRING_ARG, "g");
const CLASS_CALL_RE = new RegExp(String.raw`\.\s*getElementsByClassName\s*` + STRING_ARG, "g");
const ID_CALL_RE = new RegExp(String.raw`\.\s*getElementById\s*` + STRING_ARG, "g");

/**
 * The class and id selectors a script uses to find elements:
 * `querySelector('.counter-value')`, `getElementsByClassName('x')`,
 * `getElementById('y')`, `closest('.card')`. For a CSS selector only its
 * subject (the last compound of each comma-separated part) counts, since that
 * is the element the script gets back.
 */
export function scriptSelectorHooks(js: string): ScriptHooks {
  const hooks: ScriptHooks = { classes: new Set(), ids: new Set() };
  const arg = (m: RegExpMatchArray): string => m[1] ?? m[2] ?? m[3] ?? "";
  for (const m of js.matchAll(SELECTOR_CALL_RE)) {
    for (const part of arg(m).split(",")) {
      const subject = part
        .replace(/\[[^\]]*\]|\([^)]*\)/g, " ") // attribute selectors, :not(...) args
        .trim()
        .split(/\s*[>+~]\s*|\s+/)
        .pop() ?? "";
      for (const c of subject.matchAll(/\.([\w-]+)/g)) hooks.classes.add(c[1]);
      for (const i of subject.matchAll(/#([\w-]+)/g)) hooks.ids.add(i[1]);
    }
  }
  for (const m of js.matchAll(CLASS_CALL_RE)) {
    for (const c of arg(m).split(/\s+/)) if (c) hooks.classes.add(c);
  }
  for (const m of js.matchAll(ID_CALL_RE)) if (arg(m)) hooks.ids.add(arg(m).trim());
  return hooks;
}

/** The hooks of every `<script>` in a parsed file. */
function collectScriptHooks(
  root: AstroNode,
  walk: (root: AstroNode, visit: (n: TagNode, ancestors: AstroNode[]) => void) => void,
): ScriptHooks {
  const hooks: ScriptHooks = { classes: new Set(), ids: new Set() };
  walk(root, (node) => {
    if (node.name !== "script" || node.type !== "element") return;
    const js = (node.children ?? [])
      .map((c) => (c.type === "text" ? ((c as { value?: string }).value ?? "") : ""))
      .join("");
    const found = scriptSelectorHooks(js);
    for (const c of found.classes) hooks.classes.add(c);
    for (const i of found.ids) hooks.ids.add(i);
  });
  return hooks;
}

/** Does a script find this element by its static class or id? */
function isScriptTarget(node: TagNode, hooks: ScriptHooks): boolean {
  if (hooks.classes.size === 0 && hooks.ids.size === 0) return false;
  for (const a of node.attributes) {
    if (a.kind !== "quoted" && a.kind !== undefined) continue;
    if (a.name === "class" && a.value.split(/\s+/).some((c) => hooks.classes.has(c))) return true;
    if (a.name === "id" && hooks.ids.has(a.value.trim())) return true;
  }
  return false;
}

/** A link to the site root: the header logo / home link carries the site
 *  name, which is site chrome rather than the page's content. */
function isHomeLink(node: TagNode): boolean {
  if (node.name.toLowerCase() !== "a") return false;
  const href = node.attributes.find((a) => a.name === "href");
  if (!href || (href.kind !== "quoted" && href.kind !== undefined)) return false;
  return /^\/(?:index(?:\.html?)?)?$/.test(href.value.trim());
}

function hasCaretAttr(node: TagNode): boolean {
  return node.attributes.some(
    (a) => a.name === "data-caret" || a.name === "data-caret-scope",
  );
}

/**
 * Text content of an element, including text inside inline markup, so a rich
 * candidate's preview and name keep its bold or linked words.
 */
function textContent(node: AstroNode): string {
  const parts: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === "text") parts.push((child as { value?: string }).value ?? "");
    else if (isTagNode(child)) parts.push(textContent(child));
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
  const assetImports = options.assetImports ?? NO_IMAGE_COMPONENTS;
  const flagsByOffset = new Map<number, IteratorFlag>();
  // Nodes promoted to data-caret-rich. Their descendants must NOT be tagged
  // separately (the rich field owns the whole subtree); walkTags is preorder,
  // so a host is recorded before its descendants are visited.
  const richHosts = new Set<TagNode>();
  // Elements skipped together with their whole subtree (a button, the home
  // link, an element a script rewrites, a block left for the rich tier): their
  // inline children are part of the same unit, not separate content.
  const ownedHosts = new Map<TagNode, SkipReason>();
  const scriptHooks = collectScriptHooks(root, walk);

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
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const owned = ownedHosts.get(ancestors[i] as TagNode);
      if (owned) return skip(owned);
    }
    // Descendants inherit the host's reason, except under a block left for a
    // rich tier: they are "inside-rich" so no tally counts them twice.
    const skipSubtree = (reason: SkipReason): void => {
      ownedHosts.set(node, reason === "rich-eligible" || reason === "rich-class-promotable" ? "inside-rich" : reason);
      skip(reason);
    };

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

    // `<span data-counter>01</span>`: a valueless data-* attribute is a hook a
    // script finds the element by, usually to rewrite its text. An edit would
    // be overwritten, or would freeze what the script animates.
    if (node.attributes.some((a) => /^data-(?!caret)/.test(a.name) && (a.kind === "empty" || (a.value === "" && a.kind !== "quoted")))) {
      return skipSubtree("script-hook");
    }
    // The same for an element this file's <script> selects by class or id
    // (`querySelector('.counter-value')`): its text is what the script writes.
    if (isScriptTarget(node, scriptHooks)) return skipSubtree("script-hook");

    // Interface chrome rather than page content: a button's label, and the
    // home link / logo that repeats the site name on every page.
    if (tag.toLowerCase() === "button") return skipSubtree("ui-control");
    if (isHomeLink(node)) return skipSubtree("home-link");

    if (tag === "img" || isImageComponent) {
      const srcAttr = node.attributes.find((a) => a.name === "src");
      if (srcAttr === undefined || srcAttr.value.trim() === "") return skip("empty");
      // A dynamic src is tagged only when it is an imported image file; one
      // from props or data would get an invented key that shadows the binding
      // the data itself carries (editable(), caretLoader).
      const staticSrc = srcAttr.kind === "quoted" || srcAttr.kind === undefined;
      if (!staticSrc) {
        const asset = /^([A-Za-z_$][\w$]*)(?:\.src)?$/.exec(srcAttr.value.trim());
        if (!asset || !assetImports.has(asset[1])) return skip("dynamic-src");
      }
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
      // A block left for a rich tier keeps its inline children: the block is
      // the editable unit, so "family-run bakery" inside a paragraph never
      // becomes a field of its own. This also keeps the lower-confidence count
      // the same whichever tiers are chosen.
      if (richShape === "rich-class" && !(options.rich && options.richClass)) {
        // Inline-only except for a class the sanitizer strips unless blessed via
        // allowedClasses. Surfaced (so the hint can name the classes) until both
        // --rich and --rich-class (the latter rides in --all) are on.
        return skipSubtree("rich-class-promotable");
      }
      // rich-safe: promote only when opted in; otherwise report it as eligible.
      if (richShape === "rich-safe" && !options.rich) return skipSubtree("rich-eligible");
      richHosts.add(node);
      candidates.push({
        decision: "tag", kind: "text", node, tag, startOffset,
        confidence: "medium", text: textContent(node).trim(), rich: true,
      });
      return;
    }

    candidates.push({
      decision: "tag", kind: "text", node, tag, startOffset,
      confidence: CONFIDENCE[tag], text: textContent(node).trim(),
    });
  });

  return {
    candidates,
    skipped,
    flags: [...flagsByOffset.values()].sort((a, b) => a.startOffset - b.startOffset),
  };
}
