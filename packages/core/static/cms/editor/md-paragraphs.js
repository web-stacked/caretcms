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

export function mountParagraphGroups() {
  document.querySelectorAll('p[data-caret-md-paragraph="true"]').forEach(first => {
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
    const host = document.createElement('div');
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

/** Normalize browser p/div wrappers; inline content goes through the existing
 * sanitizer and serializer, independently for each paragraph. */
/** @param {HTMLElement} root @returns {string[]} */
export function paragraphHtml(root) {
  /** @type {string[]} */
  const result = [];
  let inline = document.createElement('div');
  const flush = () => {
    if (inline.childNodes.length) { result.push(sanitizeHtml(inline.innerHTML)); inline = document.createElement('div'); }
  };
  for (const node of root.childNodes) {
    if (node instanceof HTMLElement && /^(P|DIV)$/.test(node.tagName)) {
      flush();
      if (node.querySelector('p, div')) result.push(...paragraphHtml(node));
      else result.push(sanitizeHtml(node.innerHTML));
    } else inline.append(node.cloneNode(true));
  }
  flush();
  return result.map(html => /^<br\s*\/?\s*>$/i.test(html) ? '' : html);
}

/** @param {ClipboardEvent} event */
export function pasteParagraphText(event) {
  if (!event.clipboardData) return;
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain');
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => `<p>${p.replace(/\n/g, '<br>') || '<br>'}</p>`).join('');
  // Editing command keeps paste in the browser's undo stack.
  document.execCommand('insertHTML', false, html);
}
