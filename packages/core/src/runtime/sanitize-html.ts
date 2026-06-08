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

/**
 * Per-tag class allowlist. Keys are tag names, values are allowed class names.
 * A pattern ending in `*` is a prefix match (`text-*` allows `text-primary`);
 * a lone `*` allows any class on that tag. Anything not matched is dropped.
 * Mirrors the `allowedClasses` option of the `sanitize-html` package, and MUST
 * stay identical to the client matcher in static/cms/editor/sanitize.js.
 */
export type AllowedClasses = Record<string, readonly string[]>;

export interface SanitizeOptions {
  allowedClasses?: AllowedClasses;
}

/** Does `cls` match any pattern in `patterns`? (exact, `prefix-*`, or lone `*`) */
function classAllowed(cls: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === "*") return true;
    if (p.endsWith("*")) {
      if (cls.startsWith(p.slice(0, -1))) return true;
    } else if (cls === p) {
      return true;
    }
  }
  return false;
}

/** Filter a raw class attribute value to the tag's allowed patterns. */
function filterClasses(value: string, patterns: readonly string[]): string {
  return value
    .split(/\s+/)
    .filter((c) => c !== "" && classAllowed(c, patterns))
    .join(" ");
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
