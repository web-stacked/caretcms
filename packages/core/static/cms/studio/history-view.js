import { humanizeKey } from './field-model.js';

/** @typedef {import('../../../src/schema-utils.js').JsonSchemaNode} Schema */
/**
 * @typedef {{ path: string, label: string, before: string, after: string, diff: DiffPart[] | null }} HistoryChange
 * `before`/`after` are short display values; `diff` is a word-level diff of
 * the full text when both sides are text (null for images, lists and the like).
 */
/** @typedef {{ op: '=' | '-' | '+', text: string }} DiffPart */

const IMAGE_PATH = /\.(avif|gif|jpe?g|png|svg|webp)(\?.*)?$/i;
const ENTITIES = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' });

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text a reader sees in a stored value: markup dropped, entities decoded. @param {string} value */
function readableText(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A stored value as one short line for the history list.
 * @param {unknown} value
 * @param {string} empty what to show for an empty value
 */
export function historyValueText(value, empty) {
  if (value === undefined || value === null || value === '') return empty;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // Images are stored as paths; their file name is what an editor recognizes.
    if (IMAGE_PATH.test(value) && !/\s/.test(value)) return value.split('?')[0].split('/').pop() || value;
    const text = readableText(value);
    if (!text) return empty;
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  }
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  return '…';
}

/**
 * The form's label for a field path, e.g. "Team › #2 › Name".
 * @param {string} path
 * @param {Schema | null | undefined} schema
 */
export function historyFieldLabel(path, schema) {
  /** @type {Schema | null | undefined} */
  let node = schema;
  return path.split('.').map((part) => {
    if (/^\d+$/.test(part)) {
      node = node?.items && !Array.isArray(node.items) ? node.items : null;
      return `#${Number(part) + 1}`;
    }
    const child = node?.properties?.[part];
    node = child;
    return typeof child?.title === 'string' && child.title ? child.title : humanizeKey(part);
  }).join(' › ');
}

/**
 * Every leaf field that differs between two versions of an entry, in field
 * order, labeled as the form labels them.
 * @param {unknown} before
 * @param {unknown} after
 * @param {Schema | null | undefined} schema
 * @param {string} empty
 * @returns {HistoryChange[]}
 */
export function historyChanges(before, after, schema, empty) {
  /** @type {HistoryChange[]} */
  const changes = [];
  /** @param {unknown} a @param {unknown} b @param {string} path */
  function walk(a, b, path) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    // A group added or removed compares field by field against nothing.
    const bothRecords = (isRecord(a) || a == null) && (isRecord(b) || b == null) && (isRecord(a) || isRecord(b));
    const bothArrays = Array.isArray(a) && Array.isArray(b) && a.length === b.length;
    if (bothRecords || bothArrays) {
      const keys = bothArrays
        ? a.map((_, index) => String(index))
        : Array.from(new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]));
      for (const key of keys) {
        if (key.startsWith('__')) continue;
        walk(/** @type {Record<string, unknown>} */ (a ?? {})[key], /** @type {Record<string, unknown>} */ (b ?? {})[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (!path) return;
    const beforeText = typeof a === 'string' && !IMAGE_PATH.test(a) ? readableText(a) : null;
    const afterText = typeof b === 'string' && !IMAGE_PATH.test(b) ? readableText(b) : null;
    changes.push({
      path,
      label: historyFieldLabel(path, schema),
      before: historyValueText(a, empty),
      after: historyValueText(b, empty),
      diff: beforeText && afterText ? wordDiff(beforeText, afterText) : null,
    });
  }
  walk(before ?? {}, after ?? {}, '');
  return changes;
}

/**
 * "just now", "5 minutes ago", "yesterday"; older than a week, the date.
 * @param {number} ts
 * @param {number} now
 * @param {string | undefined} locale
 */
export function relativeTime(ts, now, locale) {
  const seconds = Math.round((ts - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(seconds) < 45) return format.format(0, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return format.format(days, 'day');
  return new Date(ts).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Longest-common-subsequence work above which a diff isn't worth computing. */
const DIFF_LIMIT = 160000;
/** Unchanged words kept on each side of a change. */
const CONTEXT_WORDS = 5;

/**
 * Words removed and added between two texts, with unchanged stretches
 * shortened to a few words of context around each change. Null when the
 * texts share nothing worth showing (a rewrite reads better as before → after)
 * or are too long to compare.
 * @param {string} before @param {string} after
 * @returns {DiffPart[] | null}
 */
export function wordDiff(before, after) {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length * b.length > DIFF_LIMIT) return null;
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  /** @type {DiffPart[]} */
  const parts = [];
  /** @param {DiffPart['op']} op @param {string} text */
  const push = (op, text) => {
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.text += text;
    else parts.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push('=', a[i]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('-', a[i++]);
    else push('+', b[j++]);
  }
  while (i < a.length) push('-', a[i++]);
  while (j < b.length) push('+', b[j++]);

  const shared = parts.filter((part) => part.op === '=' && part.text.trim()).reduce((count, part) => count + part.text.trim().split(/\s+/).length, 0);
  const words = Math.max(a.filter((t) => t.trim()).length, b.filter((t) => t.trim()).length);
  if (shared === 0 || shared < words / 3) return null;

  // Keep a little context around each change; elide the rest.
  return parts.map((part, index) => {
    if (part.op !== '=') return part;
    const tokens = part.text.split(/(\s+)/).filter(Boolean);
    const wordCount = tokens.filter((t) => t.trim()).length;
    const first = index === 0;
    const last = index === parts.length - 1;
    const keep = first || last ? CONTEXT_WORDS : CONTEXT_WORDS * 2;
    if (wordCount <= keep) return part;
    /** @param {number} n */
    const headWords = (n) => { let seen = 0; const out = []; for (const t of tokens) { if (t.trim() && seen === n) break; out.push(t); if (t.trim()) seen++; } return out.join(''); };
    /** @param {number} n */
    const tailWords = (n) => { let seen = 0; const out = []; for (let k = tokens.length - 1; k >= 0; k--) { const t = tokens[k]; if (t.trim() && seen === n) break; out.unshift(t); if (t.trim()) seen++; } return out.join(''); };
    const text = first ? `…${tailWords(CONTEXT_WORDS).trimStart()}`
      : last ? `${headWords(CONTEXT_WORDS).trimEnd()}…`
        : `${headWords(CONTEXT_WORDS).trimEnd()} … ${tailWords(CONTEXT_WORDS).trimStart()}`;
    return { op: '=', text };
  });
}
