import { humanizeKey } from './field-model.js';

/** @typedef {import('../../../src/schema-utils.js').JsonSchemaNode} Schema */
/** @typedef {{ path: string, label: string, before: string, after: string }} HistoryChange */

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
    changes.push({
      path,
      label: historyFieldLabel(path, schema),
      before: historyValueText(a, empty),
      after: historyValueText(b, empty),
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
