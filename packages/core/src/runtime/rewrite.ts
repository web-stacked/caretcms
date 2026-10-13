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
import { BODY_OVERLAY_KEY, parseMdBinding, formatMdSrc, BLOCK_PATH_RE, type MdSrc } from "../markdown/contracts.js";
import { sanitizeHtml } from "./sanitize-html.js";
import { getNestedValue } from "./utils.js";
import { scanHtmlTags, type HtmlTag } from "./html-tokens.js";

// --- Types ---

type Binding = {
  collection: string;
  id: string;
  field: string;
  fullMatch: string;
  openingLength: number;
  closingStart: number;
  srcAttribute?: { start: number; end: number };
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

function findNearestScope(stack: { scope: ScopeMatch | null }[]): ScopeMatch | null {
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

  const textTags = new Set<string>(REWRITABLE_TEXT_TAGS);
  const stack: { tag: HtmlTag; scope: ScopeMatch | null; binding?: Binding; foreign: boolean }[] = [];
  for (const tag of scanHtmlTags(html)) {
    if (tag.closing) {
      let frameIndex = stack.length - 1;
      while (frameIndex >= 0 && stack[frameIndex].tag.name !== tag.name) frameIndex--;
      if (frameIndex < 0) continue;
      const frame = stack[frameIndex];
      stack.splice(frameIndex);
      if (frame.binding) {
        frame.binding.fullMatch = html.slice(frame.tag.start, tag.end);
        frame.binding.contentEnd = tag.end;
        frame.binding.closingStart = tag.start - frame.tag.start;
        frame.binding.hasChildMarkup = frame.binding.mdBlockPath === undefined && hasChildMarkup(html.slice(frame.tag.end, tag.start));
        bindings.push(frame.binding);
      }
      continue;
    }
    const foreign = tag.name === "svg" || tag.name === "math" || stack.some(frame => frame.foreign);
    const scopeParts = tag.attributes.get("data-caret-scope")?.value.split("::");
    const ownScope = scopeParts?.length === 2 ? { collection: scopeParts[0], id: scopeParts[1] } : null;
    let binding: Binding | undefined;
    if (!foreign) {
      const mdValue = tag.attributes.get("data-caret-md")?.value;
      const md = mdValue !== undefined && /^(h[1-6]|p|li)$/.test(tag.name) ? parseMdBinding(mdValue) : null;
      const caretValue = tag.attributes.get("data-caret")?.value;
      const resolved = caretValue !== undefined && (tag.name === "img" || textTags.has(tag.name))
        ? resolveBinding(caretValue, findNearestScope(stack)) : null;
      if (md || resolved) {
        const key = md ?? resolved!;
        entryKeys.add(`${key.collection}::${key.id}`);
        const src = tag.attributes.get("src");
        binding = {
          collection: key.collection, id: key.id, field: resolved?.field ?? "",
          fullMatch: html.slice(tag.start, tag.end), openingLength: tag.end - tag.start, closingStart: tag.end - tag.start,
          contentStart: tag.start, contentEnd: tag.end,
          isImg: tag.name === "img", isRich: !md && tag.attributes.has("data-caret-rich"),
          hasChildMarkup: false,
          ...(md ? { mdBlockPath: md.blockPath } : {}),
          ...(src ? { srcAttribute: { start: src.start - tag.start, end: src.end - tag.start } } : {}),
        };
        if (tag.void) bindings.push(binding);
      }
    }
    if (!tag.void) stack.push({ tag, scope: ownScope, binding, foreign });
  }

  if (bindings.length === 0) return html;

  // 2. Batch-load entries
  const entries = await batchLoadEntries(adapter, entryKeys);
  if (entries.size === 0) return html;

  // 3. Apply replacements (reverse order to preserve indices)
  const replacements: { binding: Binding; value: string }[] = [];
  const replace = (binding: Binding, value: string): void => { replacements.push({ binding, value }); };
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
      // Structural drafts own several original stamps but splice one verified
      // contiguous range. Only their first stamp renders the editable group.
      let consumed = false;
      for (const [path, value] of Object.entries(drafts)) {
        if (path === binding.mdBlockPath || !value || typeof value !== "object") continue;
        const sources = (value as Record<string, unknown>).sources;
        if (Array.isArray(sources) && sources.some(source => source?.blockPath === binding.mdBlockPath)) consumed = true;
      }
      if (consumed) {
        replace(binding, "");
        continue;
      }
      const block = (drafts as Record<string, unknown>)[binding.mdBlockPath];
      if (block === null || typeof block !== "object") continue;
      const group = block as Record<string, unknown>;
      if (Array.isArray(group.paragraphs) && group.paragraphs.every(p => typeof p === "string") &&
          Array.isArray(group.sources) && group.sources.length > 0 && group.sources.length <= 128 &&
          group.sources.every(source => source && typeof source.blockPath === "string" && BLOCK_PATH_RE.test(source.blockPath) && source.src && typeof source.html === "string")) {
        const sources = group.sources.map(source => ({ blockPath: source.blockPath,
          src: formatMdSrc(source.src as MdSrc), html: source.html }));
        const bindingValue = `${binding.collection}::${binding.id}::body::${binding.mdBlockPath}`;
        const paragraphs = group.paragraphs.map(p => `<p>${sanitizeHtml(p, { allowedClasses: options?.allowedClasses }) || "<br>"}</p>`).join("");
        const rendered = `<div data-caret-md="${escapeAttr(bindingValue)}" data-caret-md-src="${escapeAttr(sources[0].src)}" data-caret-md-sources="${escapeAttr(JSON.stringify(sources))}" data-caret-md-draft>${paragraphs || "<p><br></p>"}</div>`;
        replace(binding, rendered);
        continue;
      }
      const draftHtml = (block as Record<string, unknown>).html;
      if (typeof draftHtml !== "string") continue;

      const openTagEnd = binding.openingLength;
      const closeTagStart = binding.closingStart;
      if (openTagEnd > 0 && closeTagStart >= openTagEnd) {
        // Mark the block as showing an unpublished draft so the editor UI can
        // flag it (a reloaded preview otherwise looks identical to live prose).
        // This only fires when the adapter surfaced a draft — a previewing
        // editor — so the public, which reads the base, never receives it.
        const openTag = binding.fullMatch.slice(0, openTagEnd);
        const before = openTag.includes("data-caret-md-draft")
          ? openTag
          : `${openTag.slice(0, -1)}${openTag.includes('data-caret-md-paragraph="true"') ? ` data-caret-md-original="${escapeAttr(binding.fullMatch.slice(openTagEnd, closeTagStart))}"` : ""} data-caret-md-draft>`;
        const after = binding.fullMatch.slice(closeTagStart);
        const injected = sanitizeHtml(draftHtml, { allowedClasses: options?.allowedClasses });
        replace(binding, before + injected + after);
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
      const src = binding.srcAttribute;
      if (src) {
        const newImgTag = imgTag.slice(0, src.start) + `src="${escapeAttr(storedValue)}"` + imgTag.slice(src.end);
        replace(binding, newImgTag);
      }
    } else {
      // Replace text content between tags
      // Find the opening tag end and closing tag start within the full match
      const openTagEnd = binding.openingLength;
      const closeTagStart = binding.closingStart;

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

        replace(binding, newMatch);
      }
    }
  }

  // Resolve nested edits against ORIGINAL spans. A replaced rich parent owns
  // its subtree; applying children first would invalidate the parent's offsets.
  replacements.sort((a, b) => a.binding.contentStart - b.binding.contentStart || b.binding.contentEnd - a.binding.contentEnd);
  let result = "";
  let cursor = 0;
  for (const { binding, value } of replacements) {
    if (binding.contentStart < cursor) continue;
    result += html.slice(cursor, binding.contentStart) + value;
    cursor = binding.contentEnd;
  }
  return result + html.slice(cursor);
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
