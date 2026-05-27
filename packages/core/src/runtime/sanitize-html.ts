/**
 * Server-side HTML sanitizer for rich text fields.
 *
 * Regex-based (no DOM dependency) — works in Node, Deno, edge runtimes.
 * Same allowlist as the client sanitizer in static/cms/editor/sanitize.js.
 */

const ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "s", "a", "br", "sub", "sup",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
};

const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|\/)/i;

const TOKEN_RE = /<\/?([a-zA-Z][\w-]*)\b([^>]*)\/?>|[^<]+/g;
const ATTR_RE = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;

export function sanitizeHtml(html: string): string {
  if (!html) return "";

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
    let attrs = "";

    if (allowedAttrSet && rawAttrs) {
      ATTR_RE.lastIndex = 0;
      let attrMatch: RegExpExecArray | null;

      while ((attrMatch = ATTR_RE.exec(rawAttrs)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";

        if (!allowedAttrSet.has(attrName)) continue;

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
