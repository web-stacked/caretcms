import { sanitizeHtml } from './sanitize.js';

/**
 * Markdown body text in page history: which paragraphs on the page an earlier
 * version of the body said differently, and what they said.
 *
 * The page marks each editable body block with its range in today's body
 * (`data-caret-md-src`, or one range per paragraph in a paragraph group's
 * `data-caret-md-sources`). Today's blocks and an earlier version's are
 * matched by their text; between two matches, blocks are paired in order.
 * A block only today has is hidden while that version shows, and one only the
 * version had is shown again where it stood.
 */

/** @typedef {{ text: string, start: number }} Block */
/** @typedef {{ el: HTMLElement, start: number, end: number, hash: string }} PageBlock A body block on the page, its range in the body it was rendered from, and that range's hash. */
/** @typedef {{ replace: Map<HTMLElement, string>, hide: HTMLElement[], insert: { after: HTMLElement | null, before: HTMLElement | null, markdown: string }[] }} BodyChanges */

/** A body's blocks: the text between blank lines, with where each starts. @param {string} body @returns {Block[]} */
export function blocksOf(body) {
  /** @type {Block[]} */
  const blocks = [];
  const separator = /\n[ \t]*\n\s*/g;
  let start = 0;
  for (let match = separator.exec(body); ; match = separator.exec(body)) {
    const end = match ? match.index : body.length;
    const text = body.slice(start, end);
    if (text.trim()) blocks.push({ text, start });
    if (!match) break;
    start = match.index + match[0].length;
  }
  return blocks;
}

/**
 * Pairs of indexes of equal blocks, in order (longest common subsequence).
 * @param {string[]} a @param {string[]} b @returns {[number, number][]}
 */
function matches(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  /** @type {[number, number][]} */
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** The editable body blocks of one entry on the page, in page order. @param {string} entry `collection::id` @returns {PageBlock[]} */
export function pageBlocks(entry) {
  /** @type {PageBlock[]} */
  const found = [];
  document.querySelectorAll('[data-caret-md]').forEach((host) => {
    if (!(host instanceof HTMLElement) || !(host.getAttribute('data-caret-md') || '').startsWith(`${entry}::body::`)) return;
    const grouped = host.getAttribute('data-caret-md-sources');
    if (grouped) {
      /** @type {{ src?: string }[]} */
      let sources = [];
      try { sources = JSON.parse(grouped); } catch { return; }
      const paragraphs = [...host.children].filter(child => child instanceof HTMLElement);
      sources.forEach((source, index) => {
        const range = rangeOf(String(source.src ?? ''));
        const el = paragraphs[index];
        if (el instanceof HTMLElement && range) found.push({ el, ...range });
      });
      return;
    }
    const range = rangeOf(host.getAttribute('data-caret-md-src') || '');
    if (range) found.push({ el: host, ...range });
  });
  return found;
}

/** A `start:end:hash` source range. @param {string} src */
function rangeOf(src) {
  const match = /^(\d+):(\d+):([0-9a-f]{8})$/.exec(src);
  return match ? { start: Number(match[1]), end: Number(match[2]), hash: match[3] } : null;
}

/** FNV-1a (32-bit), as the server hashes a block's source (markdown/contracts.ts). @param {string} text */
function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Whether the page was rendered from this body: a production page can show
 * an older build than the file holds, and then its blocks can't be matched.
 * @param {string} body @param {PageBlock[]} onPage
 */
export function pageMatches(body, onPage) {
  return onPage.every(block => fnv1a32(body.slice(block.start, block.end)) === block.hash);
}

/**
 * What showing `then` instead of `now` changes among the blocks on the page.
 * Blocks the page doesn't show as editable (code, tables) are left alone.
 * @param {string} now @param {string} then @param {PageBlock[]} onPage @returns {BodyChanges}
 */
export function bodyChanges(now, then, onPage) {
  /** @type {BodyChanges} */
  const changes = { replace: new Map(), hide: [], insert: [] };
  if (now === then) return changes;
  const today = blocksOf(now);
  const earlier = blocksOf(then);
  // A page element stands for a block only when it covers all of it (a list
  // is one block of several items: those are left alone).
  const shown = new Map(onPage.map(block => [`${block.start}:${block.end}`, block.el]));
  const elementOf = (/** @type {number} */ index) => {
    const block = today[index];
    return block ? shown.get(`${block.start}:${block.start + block.text.trimEnd().length}`) ?? null : null;
  };
  // Anchors: equal blocks, plus a sentinel past the end of both.
  const anchors = [...matches(today.map(block => block.text.trim()), earlier.map(block => block.text.trim())), [today.length, earlier.length]];
  let i = 0;
  let j = 0;
  for (const [nextI, nextJ] of anchors) {
    const gapToday = nextI - i;
    const gapEarlier = nextJ - j;
    const paired = Math.min(gapToday, gapEarlier);
    for (let k = 0; k < paired; k++) {
      const el = elementOf(i + k);
      if (el) changes.replace.set(el, earlier[j + k].text);
    }
    for (let k = paired; k < gapToday; k++) {
      const el = elementOf(i + k);
      if (el) changes.hide.push(el);
    }
    if (gapEarlier > paired) {
      // Shown again after the block before them, or else before the block after them.
      let after = null;
      for (let back = i + gapToday - 1; back >= 0 && !after; back--) after = elementOf(back);
      const before = after ? null : elementOf(nextI);
      if (after || before) {
        for (let k = paired; k < gapEarlier; k++) changes.insert.push({ after, before, markdown: earlier[j + k].text });
      }
    }
    i = nextI + 1;
    j = nextJ + 1;
  }
  return changes;
}

/** @param {string} text */
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A body block's Markdown as the inline HTML the page would show inside an
 * element like `el`: its block marker (a heading's `#`, a list item's `-`, a
 * quote's `>`) dropped, then the inline marks CaretCMS edits (bold, emphasis,
 * code, links, line breaks). Sanitized like everything the editor shows.
 * @param {string} markdown @returns {string}
 */
export function blockHtml(markdown) {
  const text = markdown
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, '')
    .trim();
  /** @type {string[]} */
  const code = [];
  let html = escape(text).replace(/`([^`\n]+)`/g, (_, inner) => `\u0000${code.push(inner) - 1}\u0000`);
  html = html
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '<em>$2</em>')
    .replace(/(?: {2,}|\\)\n/g, '<br>')
    .replace(/\n/g, ' ')
    .replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${code[Number(index)]}</code>`);
  return sanitizeHtml(html);
}
