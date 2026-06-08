/**
 * Server-side HTML sanitizer for rich text fields.
 *
 * Regex-based (no DOM dependency) — works in Node, Deno, edge runtimes.
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

export type { AllowedClasses } from "./rich-allowlist.js";

const TOKEN_RE = /<\/?([a-zA-Z][\w-]*)\b([^>]*)\/?>|[^<]+/g;
const ATTR_RE = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;

export interface SanitizeOptions {
  allowedClasses?: AllowedClasses;
}

export function sanitizeHtml(html: string, options?: SanitizeOptions): string {
  if (!html) return "";

  const allowedClasses = options?.allowedClasses;

  let result = "";
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(html)) !== null) {
    const [full, tagName, rawAttrs] = match;

    // Text node — escape any stray < that the regex didn't capture
    if (!tagName) {
      result += escapeText(full);
      continue;
    }

    const tag = tagName.toLowerCase();
    const isClosing = full.startsWith("</");
    const isSelfClosing = full.endsWith("/>") || tag === "br";

    if (!ALLOWED_TAGS.has(tag)) continue;

    if (isClosing) {
      result += `</${tag}>`;
      continue;
    }

    // Build sanitized opening tag
    const allowedAttrSet = ALLOWED_ATTRS[tag];
    const classPatterns = allowedClasses?.[tag];
    let attrs = "";

    if ((allowedAttrSet || classPatterns) && rawAttrs) {
      ATTR_RE.lastIndex = 0;
      let attrMatch: RegExpExecArray | null;

      while ((attrMatch = ATTR_RE.exec(rawAttrs)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";

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
    }

    // Force security attrs on external <a> links
    if (tag === "a") {
      const hrefMatch = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs);
      const href = hrefMatch?.[1] ?? "";
      if (href && /^https?:/i.test(href)) {
        if (!attrs.includes("target=")) {
          attrs += ` target="_blank"`;
        }
        if (!attrs.includes("rel=")) {
          attrs += ` rel="noopener noreferrer"`;
        }
      }
    }

    result += isSelfClosing ? `<${tag}${attrs} />` : `<${tag}${attrs}>`;
  }

  return result;
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
