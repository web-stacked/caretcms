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
import { sanitizeHtml } from "./sanitize-html.js";

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

// Matches any element with data-caret attribute.
// Captures: tag name, full opening tag, data-caret value, content between tags, closing tag
//
// Stateful (g flag) regexes are constructed per-call inside rewriteCaretAttributes
// to avoid cross-request lastIndex contamination if the loop ever yields.
// Text-content elements: always emitted with an explicit closing tag, so we
// capture the inner content. <img> is handled separately by IMG_ELEMENT_PATTERN
// because it is a void element with no closing tag and (in standard HTML5
// output) no self-closing slash — it would never match this pattern.
const CARET_ELEMENT_PATTERN =
  /<(h[1-6]|p|span|small|strong|em|a|li|td|th|label|button|figcaption|blockquote|dt|dd|summary|caption|legend)\b([^>]*?\bdata-caret\s*=\s*"([^"]*)"[^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;

// Void <img> with a data-caret binding. Closes on a bare `>` or a self-closing
// `/>` — never on a closing tag. Captures: 1 = attribute string, 2 = data-caret value.
const IMG_ELEMENT_PATTERN =
  /<img\b([^>]*?\bdata-caret\s*=\s*"([^"]*)"[^>]*?)\/?>/;

const TAG_PATTERN = /<\/?([a-zA-Z][\w:-]*)\b[^>]*>/;

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
    const tagName = match[1].toLowerCase();
    const isClosing = tagHtml.startsWith("</");
    const isSelfClosing = !isClosing && (tagHtml.endsWith("/>") || VOID_TAGS.has(tagName));

    if (isClosing) {
      popFrame(state.stack, tagName);
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

function resolveBinding(
  caretValue: string,
  scope: ScopeMatch | null,
): { collection: string; id: string; field: string } | null {
  const parts = caretValue.split("::");
  if (parts.length === 3) {
    return { collection: parts[0], id: parts[1], field: parts[2] };
  }
  if (parts.length === 1 && !caretValue.includes("::")) {
    // Field-only — resolve from nearest scope
    if (!scope) return null;
    return { collection: scope.collection, id: scope.id, field: caretValue };
  }
  return null;
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

function getNestedValue(
  data: Record<string, unknown>,
  path: string,
): string | undefined {
  const keys = path.split(".");
  let current: unknown = data;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

// --- Main rewrite ---

export async function rewriteCaretAttributes(
  html: string,
  adapter: StorageAdapter,
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

  if (bindings.length === 0) return html;

  // 2. Batch-load entries
  const entries = await batchLoadEntries(adapter, entryKeys);
  if (entries.size === 0) return html;

  // 3. Apply replacements (reverse order to preserve indices)
  let result = html;
  const sorted = [...bindings].sort((a, b) => b.contentStart - a.contentStart);

  for (const binding of sorted) {
    // Skip elements with nested child markup (unless rich text, which expects HTML content)
    if (binding.hasChildMarkup && !binding.isRich) continue;

    const entryKey = `${binding.collection}::${binding.id}`;
    const entry = entries.get(entryKey);
    if (!entry) continue;

    const storedValue = getNestedValue(entry.data, binding.field);
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
          ? sanitizeHtml(storedValue)
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
