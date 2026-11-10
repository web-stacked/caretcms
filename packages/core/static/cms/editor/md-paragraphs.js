/** Native contenteditable provides paragraph split/merge, selection deletion,
 * IME and undo. Each host owns only consecutive stamped top-level paragraphs. */
import { sanitizeHtml } from './sanitize.js';

/** @typedef {{ binding: string, prefix: string, blockPath: string, src: string }} ParagraphBinding */
/** @typedef {{ blockPath: string, src: string, html: string }} ParagraphSource */

/** @param {Element | null} element @returns {element is HTMLElement} */
function isParagraphCandidate(element) {
  return element instanceof HTMLElement && element.matches('p[data-caret-md-paragraph="true"]') &&
    [...element.querySelectorAll('*')].every(child => /^(B|STRONG|I|EM|A|BR|CODE)$/.test(child.tagName));
}

/** @param {HTMLElement} element @returns {ParagraphBinding | null} */
function readParagraphBinding(element) {
  const binding = element.getAttribute('data-caret-md');
  const src = element.getAttribute('data-caret-md-src');
  if (!binding || !src) return null;
  const parts = binding.split('::');
  if (parts.length !== 4 || parts[2] !== 'body' || !/^\d+$/.test(parts[3])) return null;
  if (!/^[a-z][a-z0-9_-]*$/.test(parts[0]) || !/^[a-z0-9][a-z0-9_-]*$/.test(parts[1])) return null;
  if (!/^\d+:\d+:[0-9a-f]{8}$/.test(src)) return null;
  const [start, end] = src.split(':').map(Number);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return null;
  return { binding, prefix: parts.slice(0, 3).join('::'), blockPath: parts[3], src };
}

/** @param {Document} [root] the live page, or a freshly fetched copy of it */
export function mountParagraphGroups(root = document) {
  root.querySelectorAll('p[data-caret-md-paragraph="true"]').forEach(first => {
    if (!isParagraphCandidate(first) || !first.isConnected || first.closest('li, blockquote, [data-caret-md-sources]')) return;
    const firstBinding = readParagraphBinding(first);
    if (!firstBinding) return;
    const firstIndex = Number(firstBinding.blockPath);
    /** @type {ParagraphSource[]} */
    const sources = [];
    /** @type {HTMLElement[]} */
    const paragraphs = [];
    /** @type {HTMLElement | null} */
    let next = first;
    let size = 0;
    while (isParagraphCandidate(next)) {
      const binding = readParagraphBinding(next);
      if (!binding || binding.prefix !== firstBinding.prefix || Number(binding.blockPath) !== firstIndex + sources.length) break;
      const html = next.getAttribute('data-caret-md-original') ?? next.innerHTML;
      if (sources.length >= 128 || size + html.length * 2 > 48 * 1024) break;
      size += html.length * 2;
      sources.push({ blockPath: binding.blockPath, src: binding.src, html });
      paragraphs.push(next);
      // Only whitespace between adjacent elements may be crossed.
      /** @type {ChildNode | null} */
      let sibling = next.nextSibling;
      while (sibling?.nodeType === Node.TEXT_NODE && !(sibling.textContent ?? '').trim()) sibling = sibling.nextSibling;
      next = sibling instanceof HTMLElement ? sibling : null;
    }
    if (!sources.length) return;
    const host = root.createElement('div');
    host.setAttribute('data-caret-md', firstBinding.binding);
    host.setAttribute('data-caret-md-src', sources[0].src);
    host.setAttribute('data-caret-md-sources', JSON.stringify(sources));
    first.before(host);
    for (const paragraph of paragraphs) {
      for (const attr of [...paragraph.attributes]) if (attr.name.startsWith('data-caret-md')) paragraph.removeAttribute(attr.name);
      host.append(paragraph);
    }
  });
}

/** Sanitize a Markdown block's inline HTML and unwrap `<span>`s. Markdown
 * source can't produce a span, so one can only be a wrapper the browser added
 * while typing or pasting; its text is all that matters, and the serializer
 * (client and server) rejects spans.
 * @param {string} html @returns {string} */
export function markdownBlockHtml(html) {
  const clean = sanitizeHtml(html);
  if (!/<span\b/i.test(clean)) return clean;
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
  for (const span of [...doc.body.querySelectorAll('span')].reverse()) span.replaceWith(...span.childNodes);
  return doc.body.innerHTML;
}

/** Normalize browser p/div wrappers; inline content goes through the existing
 * sanitizer and serializer, independently for each paragraph. */
/** @param {HTMLElement} root @returns {string[]} */
export function paragraphHtml(root) {
  /** @type {string[]} */
  const result = [];
  let inline = document.createElement('div');
  const flush = () => {
    if (inline.childNodes.length) { result.push(markdownBlockHtml(inline.innerHTML)); inline = document.createElement('div'); }
  };
  for (const node of root.childNodes) {
    if (node instanceof HTMLElement && /^(P|DIV)$/.test(node.tagName)) {
      flush();
      if (node.querySelector('p, div')) result.push(...paragraphHtml(node));
      else result.push(markdownBlockHtml(node.innerHTML));
    } else inline.append(node.cloneNode(true));
  }
  flush();
  return result.map(html => /^<br\s*\/?\s*>$/i.test(html) ? '' : html);
}

// Inline marks a Markdown paragraph can store; everything else pasted is
// reduced to its text so the block always saves.
const MARKDOWN_INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'A', 'CODE', 'BR']);
const PASTE_BLOCK = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE|TR|UL|OL|TABLE|THEAD|TBODY|SECTION|ARTICLE|HEADER|FOOTER|FIGURE|FIGCAPTION|DD|DT|DL)$/;

/** @param {string} text @returns {string} */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {string} html @returns {string} */
function markdownInlineHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${sanitizeHtml(html)}</body>`, 'text/html');
  for (const element of [...doc.body.querySelectorAll('*')].reverse()) {
    const keep = MARKDOWN_INLINE.has(element.tagName) && (element.tagName !== 'A' || element.hasAttribute('href'));
    if (!keep) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attr of [...element.attributes]) {
      if (!(element.tagName === 'A' && attr.name === 'href')) element.removeAttribute(attr.name);
    }
  }
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    node.textContent = (node.textContent || '').replace(/[\t\n\r ]+/g, ' ');
  }
  return doc.body.innerHTML.trim();
}

/** Split clipboard HTML (web pages, Word, Docs) into paragraphs of supported marks.
 * @param {string} html @returns {string[]} */
export function pastedHtmlParagraphs(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('style, script, template, noscript, title, meta, link, head').forEach(node => node.remove());
  /** @type {string[]} */
  const paragraphs = [];
  let inline = '';
  const flush = () => {
    const paragraph = markdownInlineHtml(inline).replace(/^(<br>)+|(<br>)+$/g, '').trim();
    if (paragraph) paragraphs.push(paragraph);
    inline = '';
  };
  /** @param {Node} parent */
  const walk = (parent) => {
    for (const child of parent.childNodes) {
      if (child instanceof Element && PASTE_BLOCK.test(child.tagName)) {
        flush();
        walk(child);
        flush();
      } else if (child instanceof Element) {
        inline += child.outerHTML;
      } else if (child.nodeType === Node.TEXT_NODE) {
        inline += escapeHtml(child.textContent || '');
      }
    }
  };
  walk(doc.body);
  flush();
  return paragraphs;
}

/** Split plain clipboard text into paragraphs; single newlines become breaks.
 * @param {string} text @returns {string[]} */
export function pastedTextParagraphs(text) {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
    .map(paragraph => escapeHtml(paragraph.trim()).replace(/\n/g, '<br>'))
    .filter(Boolean);
}

/** @param {ClipboardEvent} event */
export function pasteParagraphText(event) {
  if (!event.clipboardData) return;
  event.preventDefault();
  const html = event.clipboardData.getData('text/html');
  const fromHtml = html ? pastedHtmlParagraphs(html) : [];
  const paragraphs = fromHtml.length ? fromHtml : pastedTextParagraphs(event.clipboardData.getData('text/plain'));
  if (!paragraphs.length) return;
  // Editing command keeps paste in the browser's undo stack.
  document.execCommand('insertHTML', false, paragraphs.map(paragraph => `<p>${paragraph}</p>`).join(''));
}
