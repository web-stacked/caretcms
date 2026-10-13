/**
 * Stega hydration (browser side).
 *
 * Content fetched through the live loaders in draft mode carries its binding key
 * (`collection::id::field`) hidden inside the string as invisible Unicode "tag"
 * characters. This pass walks the rendered DOM, decodes that key from each text
 * node, strips the invisible characters, and PROMOTES the containing element to
 * a normal `data-caret` binding — so the existing text/image editors pick it up
 * with zero changes. This is what makes prop-fed / component / loop content
 * click-to-edit without any author-written attribute.
 *
 * Decode logic mirrors runtime/stega.ts (the editor bundle is hand-authored JS,
 * separate from the TS runtime, so the few lines are intentionally duplicated).
 */
import { parseCaretAttr } from './helpers.js';

const TAG_BASE = 0xe0000;
const TAG_MAX = 0xe007f;
const START = String.fromCodePoint(TAG_BASE + 0x00);
const END = String.fromCodePoint(TAG_BASE + 0x01);
const TAG_RE = /[\u{E0000}-\u{E007F}]/gu;

/** @param {string} b64 @returns {string} */
function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** @param {string} value @returns {unknown} */
export function stegaDecode(value) {
  const start = value.indexOf(START);
  if (start === -1) return undefined;
  const end = value.indexOf(END, start + START.length);
  if (end === -1) return undefined;
  let b64 = '';
  for (const ch of value.slice(start + START.length, end)) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp < TAG_BASE || cp > TAG_MAX) return undefined;
    b64 += String.fromCharCode(cp - TAG_BASE);
  }
  try {
    return JSON.parse(fromBase64(b64));
  } catch {
    return undefined;
  }
}

/** @param {string} value @returns {string} */
export function stegaClean(value) {
  return value.replace(TAG_RE, '');
}

/**
 * Mirrors `contentHash` in runtime/stega-policy.ts: FNV-1a over the
 * whitespace-collapsed text.
 * @param {string} text
 * @returns {string}
 */
export function contentHash(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** How far above a tagged word to look for the element holding the whole value. */
const MAX_ANCESTOR_STEPS = 4;

/**
 * The element to bind and its key. A bare-key payload (`editable()`, live
 * loaders) binds the text's parent. Automatic bindings carry `{ k, h }` and
 * bind the nearest element whose whole visible text hashes to `h`: a value the
 * page split into one span per word binds the heading around the spans, and a
 * value that was truncated or rewritten in code binds nothing.
 * @param {unknown} payload
 * @param {Element} parent
 * @returns {{ el: Element, key: string } | null}
 */
function bindingTarget(payload, parent) {
  if (typeof payload === 'string') return { el: parent, key: payload };
  if (typeof payload !== 'object' || payload === null) return null;
  const { k, h } = /** @type {{ k?: unknown, h?: unknown }} */ (payload);
  if (typeof k !== 'string') return null;
  /** @type {Element | null} */
  let el = parent;
  for (let step = 0; el && el !== document.body && step <= MAX_ANCESTOR_STEPS; step++) {
    if (h === contentHash(stegaClean(el.textContent || ''))) return { el, key: k };
    if (el.hasAttribute('data-caret')) return null;
    el = el.parentElement;
  }
  return null;
}

/**
 * Find every stega-tagged text node under `root`, decode its key, strip the
 * invisible characters, and tag the containing element with `data-caret`.
 * Returns the number of elements newly promoted.
 * @param {Node | null} [root]
 * @returns {number}
 */
export function hydrateStega(root) {
  const scope = root || document.body;
  if (!scope) return 0;

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const tagged = [];
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text && node.nodeValue && node.nodeValue.indexOf(START) !== -1) {
      tagged.push(node);
    }
    node = walker.nextNode();
  }

  // Decode everything first, then strip: the hash check reads an element's
  // whole text, which may span several tagged nodes.
  const decoded = tagged.map((textNode) => {
    const value = textNode.nodeValue || '';
    return { textNode, payload: stegaDecode(value) };
  });
  // Always strip the invisible characters so they never affect layout/copy.
  for (const { textNode } of decoded) textNode.nodeValue = stegaClean(textNode.nodeValue || '');

  let promoted = 0;
  for (const { textNode, payload } of decoded) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest('script, style, template, noscript')) continue;
    const target = bindingTarget(payload, parent);
    if (!target || target.el.hasAttribute('data-caret')) continue; // explicit attr wins
    const { el, key } = target;
    const binding = parseCaretAttr(key);
    if (!binding?.collection || !binding.id) continue;
    el.setAttribute('data-caret', key);
    promoted++;
  }
  return promoted;
}
