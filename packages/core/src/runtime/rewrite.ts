/**
 * Response-rewriting engine for attribute-first CMS (ADR-005).
 *
 * Scans rendered HTML for data-caret and data-caret-scope attributes,
 * batch-loads stored overrides from the StorageAdapter, and replaces
 * element content (text) or src (images) with stored values.
 *
 * v1 scope: text-only leaf nodes + <img> src swaps.
 * Child markup within the rich allowlist is rendered as rich text; any other
 * child markup is skipped: the editor keeps such elements read-only, and the
 * dev toolbar lists them.
 */

import type { StorageAdapter, EntryData } from "../types.js";
import { BODY_OVERLAY_KEY, parseMdBinding, parseMdSrc, formatMdSrc, BLOCK_PATH_RE, type MdSrc } from "../markdown/contracts.js";
import { canonicalBody } from "../markdown/canonical-body.js";
import { loadPageContent, type PageContent } from "./page-content.js";
import { templateWins } from "./template-text.js";
import { reanchorBodyDrafts } from "../markdown/splice.js";
import { sanitizeHtml } from "./sanitize-html.js";
import { getNestedValue } from "./utils.js";
import { scanHtmlTags, type HtmlTag } from "./html-tokens.js";
import { RICH_ALLOWED_TAGS } from "./rich-allowlist.js";

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
  /** Set for `data-caret-md` bindings: the block's path in the rendered body. */
  mdBlockPath?: string;
  /** Set for `data-caret-md` bindings: the block's range in the source body, `start:end`. */
  mdRange?: string;
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

export interface RewriteOptions {
  allowedClasses?: Record<string, readonly string[]>;
  /** The text templates state for their bindings. Defaults to the scan the running site holds; a build passes its own. */
  pageContent?: PageContent;
  /** Called with `collection::id::field` when a template's newer text is kept over a saved value. */
  onTemplateWins?: (binding: string) => void;
}

// --- Body drafts ---

function rangeKey(src: MdSrc | null | undefined): string | undefined {
  return src ? `${src.start}:${src.end}` : undefined;
}

/** What a stamped block shows: a drafted block, a drafted paragraph group (on its first stamp), or nothing (a later stamp of a group). */
type BodyDraftView =
  | { kind: "block"; html: string }
  | { kind: "group"; paragraphs: string[]; sources: Array<{ src: MdSrc; html: string }> }
  | { kind: "consumed" };

/**
 * An entry's body drafts by the source range of the block they replace. A
 * draft is matched to a stamped block by that range, not by the block's path:
 * paths shift when text is added above, and a draft must never show in a
 * different block. Drafts whose block only moved are found again
 * (`reanchorBodyDrafts`); drafts whose text is gone show nothing.
 */
async function bodyDraftViews(adapter: StorageAdapter, collection: string, id: string, raw: unknown): Promise<Map<string, BodyDraftView>> {
  const views = new Map<string, BodyDraftView>();
  if (raw === null || typeof raw !== "object" || typeof adapter.readBodySource !== "function") return views;
  const source = await adapter.readBodySource(collection, id);
  if (source === null) return views;
  const { drafts, lost } = reanchorBodyDrafts(canonicalBody(source).body, raw as Record<string, unknown>);
  for (const [path, value] of Object.entries(drafts)) {
    if (lost.includes(path) || value === null || typeof value !== "object") continue;
    const block = value as Record<string, unknown>;
    const key = rangeKey(block.src as MdSrc | undefined);
    const sources = block.sources;
    if (Array.isArray(block.paragraphs) && block.paragraphs.every(p => typeof p === "string") &&
        Array.isArray(sources) && sources.length > 0 && sources.length <= 128 &&
        sources.every(source => source && typeof source.blockPath === "string" && BLOCK_PATH_RE.test(source.blockPath) && source.src && typeof source.html === "string")) {
      const members = sources as Array<{ src: MdSrc; html: string }>;
      members.forEach((member, index) => views.set(rangeKey(member.src)!, index === 0
        ? { kind: "group", paragraphs: block.paragraphs as string[], sources: members.map(({ src, html }) => ({ src, html })) }
        : { kind: "consumed" }));
    } else if (key && typeof block.html === "string") {
      views.set(key, { kind: "block", html: block.html });
    }
  }
  return views;
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
  options?: RewriteOptions,
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
        const inner = html.slice(frame.tag.end, tag.start);
        frame.binding.hasChildMarkup = frame.binding.mdBlockPath === undefined && hasChildMarkup(inner);
        // Inline formatting the rich allowlist covers (a <code> or <strong>
        // inside a paragraph) is edited and stored as rich text, so render it
        // that way; other child markup stays untouched.
        if (frame.binding.hasChildMarkup && !frame.binding.isRich &&
            [...scanHtmlTags(inner)].every((child) => RICH_ALLOWED_TAGS.has(child.name))) {
          frame.binding.isRich = true;
        }
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
          ...(md ? { mdBlockPath: md.blockPath, mdRange: rangeKey(parseMdSrc(tag.attributes.get("data-caret-md-src")?.value ?? "")) } : {}),
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

  const pageContent = options?.pageContent ?? await loadPageContent();

  // 3. Apply replacements (reverse order to preserve indices)
  const replacements: { binding: Binding; value: string }[] = [];
  const replace = (binding: Binding, value: string): void => { replacements.push({ binding, value }); };
  const sorted = [...bindings].sort((a, b) => b.contentStart - a.contentStart);

  // Body drafts per entry, and each stamped block's path by its source range.
  const bodyDrafts = new Map<string, Map<string, BodyDraftView>>();
  const pathsByRange = new Map<string, Map<string, string>>();
  for (const binding of bindings) {
    if (binding.mdBlockPath === undefined || !binding.mdRange) continue;
    const entryKey = `${binding.collection}::${binding.id}`;
    if (!pathsByRange.has(entryKey)) pathsByRange.set(entryKey, new Map());
    pathsByRange.get(entryKey)!.set(binding.mdRange, binding.mdBlockPath);
  }
  await Promise.all([...pathsByRange.keys()].map(async (entryKey) => {
    const drafts = entries.get(entryKey)?.data[BODY_OVERLAY_KEY];
    if (drafts === undefined) return;
    const [collection, id] = entryKey.split("::");
    bodyDrafts.set(entryKey, await bodyDraftViews(adapter, collection, id, drafts));
  }));

  for (const binding of sorted) {
    const entryKey = `${binding.collection}::${binding.id}`;

    // Markdown body block: swap inner HTML with the drafted block, re-sanitized
    // on the way out (defense in depth — it was sanitized at write time too).
    // Same trust model as the data-caret-rich path below.
    if (binding.mdBlockPath !== undefined) {
      const view = binding.mdRange ? bodyDrafts.get(entryKey)?.get(binding.mdRange) : undefined;
      if (!view) continue;
      // Structural drafts own several original stamps but splice one verified
      // contiguous range. Only their first stamp renders the editable group.
      if (view.kind === "consumed") {
        replace(binding, "");
        continue;
      }
      if (view.kind === "group") {
        // Name each source by the path its block has on this page now.
        const paths = pathsByRange.get(entryKey);
        const sources = view.sources.map(source => ({ blockPath: paths?.get(rangeKey(source.src)!) ?? binding.mdBlockPath!,
          src: formatMdSrc(source.src), html: source.html }));
        const bindingValue = `${binding.collection}::${binding.id}::body::${binding.mdBlockPath}`;
        const paragraphs = view.paragraphs.map(p => `<p>${sanitizeHtml(p, { allowedClasses: options?.allowedClasses }) || "<br>"}</p>`).join("");
        const rendered = `<div data-caret-md="${escapeAttr(bindingValue)}" data-caret-md-src="${escapeAttr(sources[0].src)}" data-caret-md-sources="${escapeAttr(JSON.stringify(sources))}" data-caret-md-draft>${paragraphs || "<p><br></p>"}</div>`;
        replace(binding, rendered);
        continue;
      }
      const draftHtml = view.html;

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
    // The template's text was changed after this value was saved: it stays.
    if (templateWins(entry.data, binding.field, pageContent[binding.collection]?.[binding.id]?.[binding.field])) {
      options?.onTemplateWins?.(`${binding.collection}::${binding.id}::${binding.field}`);
      continue;
    }

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
