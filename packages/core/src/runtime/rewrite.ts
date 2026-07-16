/**
 * Response-rewriting engine for attribute-first CMS (ADR-005).
 *
 * Scans rendered HTML for data-caret and data-caret-scope attributes,
 * batch-loads stored overrides from the StorageAdapter, and replaces
 * element content (text) or src (images) with stored values.
 *
 * v1 scope: text-only leaf nodes + <img> src swaps.
 * Elements with nested child markup are skipped (editor warns at runtime).
 */

import type { StorageAdapter, EntryData } from "../types.js";
import { BODY_OVERLAY_KEY, parseMdBinding } from "../markdown/contracts.js";
import { sanitizeHtml } from "./sanitize-html.js";
import { getNestedValue } from "./utils.js";

// --- Types ---

type Binding = {
  collection: string;
  id: string;
  field: string;
  fullMatch: string;
  contentStart: number;
  contentEnd: number;
  isImg: boolean;
  isRich: boolean;
  hasChildMarkup: boolean;
  /** Set for `data-caret-md` bindings: the body-draft blockPath to swap from. */
  mdBlockPath?: string;
};

type ScopeMatch = {
  collection: string;
  id: string;
};

type ScopeFrame = {
  tagName: string;
  scope: ScopeMatch | null;
};

// --- Patterns ---

/**
 * Tags whose text content the rewrite engine can swap (`data-caret` bindings).
 * `<img>` (src swap) is handled separately. This list is a PUBLIC CONTRACT:
 * caretize mirrors it as its candidate set (a parity test asserts equality) —
 * a `data-caret` on any tag outside this list saves through the editor but is
 * never injected into the public render (a silently inert binding).
 */
export const REWRITABLE_TEXT_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "span", "small", "strong", "em", "a", "li", "td", "th", "label",
  "button", "figcaption", "blockquote", "dt", "dd", "summary", "caption",
  "legend",
] as const;

// Matches any element with data-caret attribute.
// Captures: tag name, full opening tag, data-caret value, content between tags, closing tag
//
// Stateful (g flag) regexes are constructed per-call inside rewriteCaretAttributes
// to avoid cross-request lastIndex contamination if the loop ever yields.
// Text-content elements: always emitted with an explicit closing tag, so we
// capture the inner content. <img> is handled separately by IMG_ELEMENT_PATTERN
// because it is a void element with no closing tag and (in standard HTML5
// output) no self-closing slash — it would never match this pattern.
const CARET_ELEMENT_PATTERN = new RegExp(
  `<(${REWRITABLE_TEXT_TAGS.join("|")})\\b([^>]*?\\bdata-caret\\s*=\\s*"([^"]*)"[^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/\\1>)`,
);

// Void <img> with a data-caret binding. Closes on a bare `>` or a self-closing
// `/>` — never on a closing tag. Captures: 1 = attribute string, 2 = data-caret value.
const IMG_ELEMENT_PATTERN =
  /<img\b([^>]*?\bdata-caret\s*=\s*"([^"]*)"[^>]*?)\/?>/;

// Markdown body blocks stamped by the mdast plugins (`data-caret-md`). Only
// the block tags the stamping rules can emit; their content is inline-only by
// construction (the closed editing set), so a lazy match to the first closing
// tag can't be fooled by a nested same-tag element.
// Captures: 1 = tag, 2 = attrs, 3 = binding value, 4 = content.
const CARET_MD_ELEMENT_PATTERN = new RegExp(
  `<(h[1-6]|p|li)\\b([^>]*?\\bdata-caret-md\\s*=\\s*"([^"]*)"[^>]*?)>([\\s\\S]*?)<\\/\\1>`,
);

// Scans the document to maintain the scope-frame stack. Matches EITHER a whole
// HTML comment OR a start/end tag. Handling both keeps tag-like text the browser
// never treats as a tag from corrupting the stack:
//   - `<!-- <div> -->` — the comment is consumed whole, so the inner `<div>`
//     never pushes a frame.
//   - a `>` inside a quoted attribute (`<a title="a>b">`) — the attribute body
//     matches quoted runs, so the tag closes on the real `>`, not the one in the
//     value. Branches are mutually exclusive on their first char ("/'/other), so
//     there is no ambiguous backtracking (ReDoS-safe).
// Rawtext bodies (<script>/<style>/…) are skipped in advanceScopeStack itself.
// Group 1 = tag name (undefined for the comment branch).
const TAG_PATTERN = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>/;

// Elements whose content is raw text (CDATA-like), so `<div>`-looking substrings
// inside them are NOT tags and must not touch the scope stack.
const RAWTEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

const SCOPE_ATTR_RE = /\bdata-caret-scope\s*=\s*"([^"]+)"/i;
const RICH_ATTR_RE = /\bdata-caret-rich\b/i;

// Matches <img ... data-caret="..." ... src="..." ...> (self-closing or not)
// We need to find and replace the src attribute within the img tag
const IMG_SRC_RE = /\bsrc\s*=\s*"([^"]*)"/;

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function parseScope(tagHtml: string): ScopeMatch | null {
  const match = SCOPE_ATTR_RE.exec(tagHtml);
  if (!match) return null;
  const parts = match[1].split("::");
  if (parts.length !== 2) return null;
  return { collection: parts[0], id: parts[1] };
}

function popFrame(stack: ScopeFrame[], tagName: string): void {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].tagName === tagName) {
      stack.splice(i, 1);
      return;
    }
  }
}

function advanceScopeStack(
  html: string,
  untilIndex: number,
  state: { stack: ScopeFrame[]; cursor: number },
  tagRe: RegExp,
): void {
  tagRe.lastIndex = state.cursor;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    if (match.index >= untilIndex) break;

    const tagHtml = match[0];
    // Comment branch (no tag-name capture): consumed whole, nothing to track.
    if (match[1] === undefined) {
      state.cursor = tagRe.lastIndex;
      continue;
    }

    const tagName = match[1].toLowerCase();
    const isClosing = tagHtml.startsWith("</");
    const isSelfClosing = !isClosing && (tagHtml.endsWith("/>") || VOID_TAGS.has(tagName));

    if (isClosing) {
      popFrame(state.stack, tagName);
      state.cursor = tagRe.lastIndex;
      continue;
    }

    // Rawtext element: skip its entire body so tag-like text inside (e.g.
    // `if (a < b)` in a <script>, or `</div>` in a <textarea> template) can't
    // push/pop frames. Rawtext can't nest, so the first matching close wins.
    if (!isSelfClosing && RAWTEXT_TAGS.has(tagName)) {
      const closeRe = new RegExp(`</${tagName}\\b`, "gi");
      closeRe.lastIndex = tagRe.lastIndex;
      const close = closeRe.exec(html);
      tagRe.lastIndex = close ? close.index + close[0].length : html.length;
      state.cursor = tagRe.lastIndex;
      continue;
    }

    if (!isSelfClosing) {
      state.stack.push({
        tagName,
        scope: parseScope(tagHtml),
      });
    }

    state.cursor = tagRe.lastIndex;
  }
}

function findNearestScope(stack: ScopeFrame[]): ScopeMatch | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].scope) return stack[i].scope;
  }
  return null;
}

/**
 * CANONICAL data-caret value resolution (exported for the parser parity test):
 * full triple as-is; bare field resolved against the nearest enclosing scope;
 * anything else (2 or 4+ parts) is not a binding. The hand-mirrored copies in
 * browser-runtime.ts, static/cms/editor/helpers.js, and
 * static/cms/dev-toolbar/app.js are held to this behavior by
 * tests/unit/caret-parser-parity.test.ts.
 */
export function resolveBinding(
  caretValue: string,
  scope: ScopeMatch | null,
): { collection: string; id: string; field: string } | null {
  const parts = caretValue.split("::");
  if (parts.length === 3) {
    return isReservedField(parts[2]) ? null : { collection: parts[0], id: parts[1], field: parts[2] };
  }
  if (parts.length === 1 && !caretValue.includes("::")) {
    // Field-only — resolve from nearest scope
    if (!scope) return null;
    if (isReservedField(caretValue)) return null;
    return { collection: scope.collection, id: scope.id, field: caretValue };
  }
  return null;
}

/** A `data-caret` field may never read the reserved markdown body-draft map —
 *  a crafted `x::y::__body.0.md` binding would surface draft plumbing into
 *  rendered HTML. Body drafts render only through the dedicated
 *  `data-caret-md` preview path. */
function isReservedField(field: string): boolean {
  return field === BODY_OVERLAY_KEY || field.startsWith(`${BODY_OVERLAY_KEY}.`);
}

// --- Content detection ---

function hasChildMarkup(content: string): boolean {
  // If content contains any HTML tags, it has child markup
  return /<[a-zA-Z]/.test(content);
}

// --- Entry cache ---

async function batchLoadEntries(
  adapter: StorageAdapter,
  keys: Set<string>,
): Promise<Map<string, EntryData>> {
  const entries = new Map<string, EntryData>();
  const promises = [...keys].map(async (key) => {
    const [collection, id] = key.split("::");
    const entry = await adapter.getEntry(collection, id);
    if (entry) entries.set(key, entry);
  });
  await Promise.all(promises);
  return entries;
}

function getNestedString(
  data: Record<string, unknown>,
  path: string,
): string | undefined {
  const value = getNestedValue(data, path);
  return typeof value === "string" ? value : undefined;
}

// --- Main rewrite ---

export async function rewriteCaretAttributes(
  html: string,
  adapter: StorageAdapter,
  options?: { allowedClasses?: Record<string, readonly string[]> },
): Promise<string> {
  // 1. Find all data-caret bindings and collect unique entry keys
  const bindings: Binding[] = [];
  const entryKeys = new Set<string>();

  const addBinding = (
    caretValue: string,
    attrs: string,
    content: string,
    isImg: boolean,
    scope: ScopeMatch | null,
    fullMatch: string,
    index: number,
  ): void => {
    const resolved = resolveBinding(caretValue, scope);
    if (!resolved) return;

    entryKeys.add(`${resolved.collection}::${resolved.id}`);
    bindings.push({
      ...resolved,
      fullMatch,
      contentStart: index,
      contentEnd: index + fullMatch.length,
      isImg,
      isRich: !isImg && RICH_ATTR_RE.test(attrs),
      hasChildMarkup: !isImg && hasChildMarkup(content),
    });
  };

  // Each pass walks the document independently with its own scope stack, since
  // void <img> and text elements are matched by separate patterns. Discovery
  // order does not matter: replacements are applied in reverse index order below.
  const discover = (
    pattern: RegExp,
    onMatch: (match: RegExpExecArray, scope: ScopeMatch | null) => void,
  ): void => {
    const re = new RegExp(pattern.source, "gi");
    const tagRe = new RegExp(TAG_PATTERN.source, "g");
    const scopeState = { stack: [] as ScopeFrame[], cursor: 0 };
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      advanceScopeStack(html, match.index, scopeState, tagRe);
      onMatch(match, findNearestScope(scopeState.stack));
    }
  };

  // Text-content elements: 1 = tag, 2 = attrs, 3 = data-caret value, 4 = content.
  discover(CARET_ELEMENT_PATTERN, (match, scope) => {
    addBinding(match[3], match[2], match[4] ?? "", false, scope, match[0], match.index);
  });

  // Void <img>: 1 = attrs, 2 = data-caret value (no content).
  discover(IMG_ELEMENT_PATTERN, (match, scope) => {
    addBinding(match[2], match[1], "", true, scope, match[0], match.index);
  });

  // Markdown body blocks: preview-only swap. Base markdown entries never carry
  // the body-draft map (their data IS the frontmatter), so this can only ever
  // replace content when the adapter is a previewing editor's draft overlay —
  // public requests and the static bake read the base and are untouched.
  discover(CARET_MD_ELEMENT_PATTERN, (match) => {
    const parsed = parseMdBinding(match[3]);
    if (!parsed) return;
    entryKeys.add(`${parsed.collection}::${parsed.id}`);
    bindings.push({
      collection: parsed.collection,
      id: parsed.id,
      field: "",
      fullMatch: match[0],
      contentStart: match.index,
      contentEnd: match.index + match[0].length,
      isImg: false,
      isRich: false,
      hasChildMarkup: false,
      mdBlockPath: parsed.blockPath,
    });
  });

  if (bindings.length === 0) return html;

  // 2. Batch-load entries
  const entries = await batchLoadEntries(adapter, entryKeys);
  if (entries.size === 0) return html;

  // 3. Apply replacements (reverse order to preserve indices)
  let result = html;
  const sorted = [...bindings].sort((a, b) => b.contentStart - a.contentStart);

  for (const binding of sorted) {
    const entryKey = `${binding.collection}::${binding.id}`;

    // Markdown body block: swap inner HTML with the drafted block, re-sanitized
    // on the way out (defense in depth — it was sanitized at write time too).
    // Same trust model as the data-caret-rich path below.
    if (binding.mdBlockPath !== undefined) {
      const entry = entries.get(entryKey);
      if (!entry) continue;
      const drafts = entry.data[BODY_OVERLAY_KEY];
      if (drafts === null || typeof drafts !== "object") continue;
      const block = (drafts as Record<string, unknown>)[binding.mdBlockPath];
      if (block === null || typeof block !== "object") continue;
      const draftHtml = (block as Record<string, unknown>).html;
      if (typeof draftHtml !== "string") continue;

      const openTagEnd = binding.fullMatch.indexOf(">") + 1;
      const closeTagStart = binding.fullMatch.lastIndexOf("</");
      if (openTagEnd > 0 && closeTagStart >= openTagEnd) {
        const before = binding.fullMatch.slice(0, openTagEnd);
        const after = binding.fullMatch.slice(closeTagStart);
        const injected = sanitizeHtml(draftHtml, { allowedClasses: options?.allowedClasses });
        result =
          result.slice(0, binding.contentStart) +
          before +
          injected +
          after +
          result.slice(binding.contentEnd);
      }
      continue;
    }

    // Skip elements with nested child markup (unless rich text, which expects HTML content)
    if (binding.hasChildMarkup && !binding.isRich) continue;

    const entry = entries.get(entryKey);
    if (!entry) continue;

    const storedValue = getNestedString(entry.data, binding.field);
    if (storedValue === undefined) continue;

    if (binding.isImg) {
      // Replace src attribute value in the img tag
      const imgTag = binding.fullMatch;
      const srcMatch = IMG_SRC_RE.exec(imgTag);
      if (srcMatch) {
        // Function replacement (not a string) so `$`-sequences in the stored
        // value — `$&`, `$1`, `` $` `` — are inserted literally instead of being
        // interpreted as String.prototype.replace substitution patterns.
        const newImgTag = imgTag.replace(
          srcMatch[0],
          () => `src="${escapeAttr(storedValue)}"`,
        );
        result =
          result.slice(0, binding.contentStart) +
          newImgTag +
          result.slice(binding.contentEnd);
      }
    } else {
      // Replace text content between tags
      // Find the opening tag end and closing tag start within the full match
      const openTagEnd = binding.fullMatch.indexOf(">") + 1;
      const closeTagStart = binding.fullMatch.lastIndexOf("</");

      // `>=` so an empty bound element (`<h1 data-caret="x"></h1>`) — a valid
      // placeholder awaiting its first override — is filled too. When content
      // is empty the two indices are equal and the slices still reconstruct
      // `<tag …>` + value + `</tag>` correctly.
      if (openTagEnd > 0 && closeTagStart >= openTagEnd) {
        const before = binding.fullMatch.slice(0, openTagEnd);
        const after = binding.fullMatch.slice(closeTagStart);
        const injected = binding.isRich
          ? sanitizeHtml(storedValue, { allowedClasses: options?.allowedClasses })
          : escapeHtml(storedValue);
        const newMatch = before + injected + after;

        result =
          result.slice(0, binding.contentStart) +
          newMatch +
          result.slice(binding.contentEnd);
      }
    }
  }

  return result;
}

// --- Escaping ---

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
