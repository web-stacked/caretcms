/**
 * Client-side HTML sanitizer for rich text fields.
 *
 * Uses DOMParser + TreeWalker to sanitize HTML against an allowlist.
 * Only inline formatting elements are permitted — no block-level tags.
 */

// NOTE: these three constants + classAllowed() below are a HAND MIRROR of
// src/runtime/rich-allowlist.ts (this file ships as raw unbundled JS and can't
// import it). They are `export`ed so tests/unit/sanitizer-parity.test.ts can
// assert they never drift from the source of truth — CI fails on divergence.
export const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'sub', 'sup', 'span',
]);

export const ALLOWED_ATTRS = {
  a: new Set(['href', 'target', 'rel']),
};

export const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|\/)/i;

/**
 * Does `cls` match any pattern? (exact, `prefix-*`, or lone `*`)
 * MUST stay identical to classAllowed() in src/runtime/sanitize-html.ts.
 * @param {string} cls
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
export function classAllowed(cls, patterns) {
  for (const p of patterns) {
    if (p === '*') return true;
    if (p.endsWith('*')) {
      if (cls.startsWith(p.slice(0, -1))) return true;
    } else if (cls === p) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitize an HTML string, keeping only allowed inline tags and attributes.
 * Per-tag class allowlist comes from `options.allowedClasses`, falling back to
 * `window.__CARET__.allowedClasses` so the client matches the server config.
 * @param {string} html
 * @param {{ allowedClasses?: Record<string, readonly string[]> }} [options]
 * @returns {string}
 */
export function sanitizeHtml(html, options) {
  if (!html) return '';

  const allowedClasses =
    options?.allowedClasses ??
    (typeof window !== 'undefined' ? window.__CARET__?.allowedClasses : undefined) ??
    null;

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  sanitizeNode(doc.body, allowedClasses);
  return doc.body.innerHTML;
}

/**
 * Recursively sanitize a DOM node in place.
 * @param {Node} parent
 * @param {Record<string, readonly string[]> | null} allowedClasses
 */
function sanitizeNode(parent, allowedClasses) {
  const children = Array.from(parent.childNodes);

  for (const node of children) {
    if (node.nodeType === Node.TEXT_NODE) continue;

    if (node.nodeType === Node.COMMENT_NODE) {
      parent.removeChild(node);
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      parent.removeChild(node);
      continue;
    }

    const el = /** @type {Element} */ (node);
    const tag = el.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: keep children, remove the disallowed element
      const frag = document.createDocumentFragment();
      while (el.firstChild) frag.appendChild(el.firstChild);
      parent.replaceChild(frag, el);
      // Re-sanitize the newly promoted children
      sanitizeNode(parent, allowedClasses);
      return;
    }

    // Strip disallowed attributes
    const allowed = ALLOWED_ATTRS[tag];
    const classPatterns = allowedClasses ? allowedClasses[tag] : undefined;
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      // class is gated by the per-tag allowlist, not ALLOWED_ATTRS
      if (attr.name === 'class') {
        if (!classPatterns) {
          el.removeAttribute('class');
          continue;
        }
        const kept = attr.value
          .split(/\s+/)
          .filter((c) => c !== '' && classAllowed(c, classPatterns))
          .join(' ');
        if (kept) el.setAttribute('class', kept);
        else el.removeAttribute('class');
        continue;
      }
      if (!allowed || !allowed.has(attr.name)) {
        el.removeAttribute(attr.name);
      }
    }

    // Validate href on <a>
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (!SAFE_HREF_RE.test(href)) {
        el.removeAttribute('href');
      }
      // Force security attrs on external links
      if (href && /^https?:/i.test(href)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }

    // Recurse into children
    sanitizeNode(el, allowedClasses);
  }
}
