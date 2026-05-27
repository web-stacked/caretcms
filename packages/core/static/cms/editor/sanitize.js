/**
 * Client-side HTML sanitizer for rich text fields.
 *
 * Uses DOMParser + TreeWalker to sanitize HTML against an allowlist.
 * Only inline formatting elements are permitted — no block-level tags.
 */

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'sub', 'sup',
]);

const ALLOWED_ATTRS = {
  a: new Set(['href', 'target', 'rel']),
};

const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|\/)/i;

/**
 * Sanitize an HTML string, keeping only allowed inline tags and attributes.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (!html) return '';

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

/**
 * Recursively sanitize a DOM node in place.
 * @param {Node} parent
 */
function sanitizeNode(parent) {
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
      sanitizeNode(parent);
      return;
    }

    // Strip disallowed attributes
    const allowed = ALLOWED_ATTRS[tag];
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
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
    sanitizeNode(el);
  }
}
