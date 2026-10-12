/**
 * Server-side HTML sanitizer for rich text fields.
 *
 * Token-based (no DOM dependency) — works in Node, Deno, edge runtimes.
 * Allowlist + class matcher live in ./rich-allowlist.ts, shared with the cloud
 * sanitizer; static/cms/editor/sanitize.js mirrors them by hand.
 */

import {
  RICH_ALLOWED_TAGS as ALLOWED_TAGS,
  RICH_ALLOWED_ATTRS as ALLOWED_ATTRS,
  SAFE_HREF_RE,
  filterClasses,
  type AllowedClasses,
} from "./rich-allowlist.js";

import { decodeHtmlEntities } from "./decode-entities.js";
import { scanHtmlTags, type HtmlAttribute } from "./html-tokens.js";

export type { AllowedClasses } from "./rich-allowlist.js";

export interface SanitizeOptions {
  allowedClasses?: AllowedClasses;
}

export function sanitizeHtml(html: string, options?: SanitizeOptions): string {
  if (!html) return "";

  const allowedClasses = options?.allowedClasses;

  let result = "";
  let cursor = 0;
  const appendText = (text: string): void => {
    result += escapeText(decodeHtmlEntities(text.replace(/<!--[\s\S]*?--!?>/g, "")));
  };
  for (const token of scanHtmlTags(html)) {
    appendText(html.slice(cursor, token.start));
    cursor = token.end;
    const tag = token.name;
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (token.closing) { result += `</${tag}>`; continue; }
    let attrs = sanitizeAttributes(token.attributes, ALLOWED_ATTRS[tag], allowedClasses?.[tag]);
    if (tag === "a") attrs = enforceLinkSafety(attrs);
    result += tag === "br" ? `<${tag}${attrs} />` : `<${tag}${attrs}>`;
  }
  appendText(html.slice(cursor));

  return result;
}

/**
 * Sanitize one opening tag's raw attribute text into a ` name="value"…` string.
 * Keeps only attributes in `allowedAttrSet` (with href gated by SAFE_HREF_RE),
 * plus `class` filtered to `classPatterns` (class is gated separately, by the
 * per-tag allowedClasses — never by ALLOWED_ATTRS). Everything else is dropped.
 */
function sanitizeAttributes(
  rawAttrs: Map<string, HtmlAttribute>,
  allowedAttrSet: Set<string> | undefined,
  classPatterns: readonly string[] | undefined,
): string {
  if ((!allowedAttrSet && !classPatterns) || rawAttrs.size === 0) return "";

  let attrs = "";
  for (const [attrName, attribute] of rawAttrs) {
    const attrValue = decodeHtmlEntities(attribute.value, true);

    // class is gated by the per-tag allowlist, not ALLOWED_ATTRS
    if (attrName === "class") {
      if (!classPatterns) continue;
      const kept = filterClasses(attrValue, classPatterns);
      if (kept) attrs += ` class="${escapeAttr(kept)}"`;
      continue;
    }

    if (!allowedAttrSet || !allowedAttrSet.has(attrName)) continue;

    if (attrName === "href") {
      if (!SAFE_HREF_RE.test(attrValue)) continue;
    }

    attrs += ` ${attrName}="${escapeAttr(attrValue)}"`;
  }

  return attrs;
}

/**
 * Force `target="_blank"` + `rel="noopener noreferrer"` onto external (http/https)
 * `<a>` links, without clobbering values the author already set. Relative,
 * mailto:, and tel: links are left untouched.
 */
function enforceLinkSafety(attrs: string): string {
  const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
  if (!href || !/^https?:/i.test(href)) return attrs;
  if (!attrs.includes("target=")) attrs += ` target="_blank"`;
  if (!attrs.includes("rel=")) attrs += ` rel="noopener noreferrer"`;
  return attrs;
}

function escapeText(str: string): string {
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
