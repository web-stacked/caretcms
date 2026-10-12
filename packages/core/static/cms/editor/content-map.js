import { buildCmsUrl } from './config.js';
import { readHeaders } from './security.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';

/** @param {string} value */
function readable(value) {
  const text = String(value || '').replace(/[-_]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : value;
}

/** "hero.cta_label" -> "Hero › Cta label"; list indexes become 1-based. @param {string} field */
function readableField(field) {
  return String(field).split('.').map((part) => (/^\d+$/.test(part) ? `#${Number(part) + 1}` : readable(part))).join(' › ');
}

/**
 * Content Map dev panel.
 * Lists all data-caret bindings on the current page with override status.
 */

/** @typedef {{ collection: string, id: string, field: string }} ResolvedBinding */
/** @typedef {{ el: Element, resolved: ResolvedBinding, isImg: boolean, isScoped: boolean, index: number }} MapBinding */

/** @type {HTMLElement | null} */
let panel = null;
let isOpen = false;
let refreshGeneration = 0;
/** @type {WeakSet<Element>} */
const mountedButtons = new WeakSet();

/** @returns {HTMLElement} */
function createPanel() {
  const el = document.createElement('div');
  el.className = 'cms-content-map';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Content map');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="cms-content-map-header">
      <span class="cms-content-map-title">Content Map</span>
      <button type="button" class="cms-content-map-close" aria-label="Close content map">&times;</button>
    </div>
    <div class="cms-content-map-body"></div>
  `;
  document.body.appendChild(el);

  el.querySelector('.cms-content-map-close')?.addEventListener('click', () => {
    toggle();
  });

  return el;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} payload @returns {Record<string, unknown> | null} */
export function readOverrideData(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.entries)) return null;
  const entry = payload.entries[0];
  return isRecord(entry) && isRecord(entry.data) ? entry.data : null;
}

/** @param {Iterable<string>} entryKeys @returns {Promise<Map<string, Record<string, unknown>>>} */
async function loadOverrides(entryKeys) {
  /** @type {Map<string, Record<string, unknown>>} */
  const overrides = new Map();
  for (const key of entryKeys) {
    const [collection, id] = key.split('::');
    if (!collection || !id) continue;
    try {
      const res = await fetch(buildCmsUrl('/entries', { collection, id }), {
        headers: readHeaders(),
      });
      if (res.ok) {
        const data = readOverrideData(await res.json());
        if (data) overrides.set(key, data);
      }
    } catch {
      // Skip failed loads
    }
  }
  return overrides;
}

/** @param {unknown} data @param {string} path @returns {unknown} */
function getNestedValue(data, path) {
  const keys = path.split('.');
  /** @type {unknown} */
  let current = data;
  for (const key of keys) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (isRecord(current)) {
      if (!Object.hasOwn(current, key)) return undefined;
      current = current[key];
    } else return undefined;
  }
  return current;
}

async function refresh() {
  if (!panel) return;
  const generation = ++refreshGeneration;
  const body = panel.querySelector('.cms-content-map-body');
  if (!body) return;

  const elements = document.querySelectorAll('[data-caret]');
  /** @type {MapBinding[]} */
  const bindings = [];
  /** @type {Set<string>} */
  const entryKeys = new Set();

  elements.forEach((el) => {
    const attr = el.getAttribute('data-caret') || '';
    const parsed = parseCaretAttr(attr);
    const resolved = resolveBinding(el, parsed);
    if (!resolved) return;

    const key = `${resolved.collection}::${resolved.id}`;
    entryKeys.add(key);

    const isScoped = parsed?.collection === null;
    bindings.push({
      el,
      resolved,
      isImg: el instanceof HTMLImageElement,
      isScoped,
      index: bindings.length,
    });
  });

  body.innerHTML = `<div class="cms-content-map-loading">Loading...</div>`;

  const overrides = await loadOverrides(entryKeys);
  if (!isOpen || generation !== refreshGeneration) return;

  if (bindings.length === 0) {
    body.innerHTML = `<div class="cms-content-map-empty">No data-caret bindings found on this page.</div>`;
    return;
  }

  // Group by collection::id
  /** @type {Map<string, MapBinding[]>} */
  const groups = new Map();
  for (const b of bindings) {
    const groupKey = `${b.resolved.collection}::${b.resolved.id}`;
    const group = groups.get(groupKey) ?? [];
    group.push(b);
    groups.set(groupKey, group);
  }

  let html = '';
  for (const [entryKey, fields] of groups) {
    const entryData = overrides.get(entryKey);
    html += `<div class="cms-content-map-group">`;
    const [collection, id] = entryKey.split('::');
    html += `<div class="cms-content-map-group-title"><span>${escapeHtml(readable(collection))} · ${escapeHtml(readable(id))}</span><code>${escapeHtml(entryKey)}</code></div>`;

    for (const f of fields) {
      const hasOverride = entryData
        ? getNestedValue(entryData, f.resolved.field) !== undefined
        : false;

      // Only unusual states get a tag: images, and fields never saved (template default).
      const typeTag = f.isImg ? '<span class="cms-map-type">Image</span>' : '';
      const statusTag = hasOverride ? '' : '<span class="cms-map-status cms-map-default">Default</span>';
      const key = `${entryKey}::${f.resolved.field}${f.isScoped ? ' (scoped)' : ''}`;

      html += `
        <button type="button" class="cms-content-map-item" data-caret-map-index="${f.index}" title="${escapeHtml(key)}">
          <span class="cms-content-map-field">${escapeHtml(readableField(f.resolved.field))}</span>
          <span class="cms-content-map-tags">${typeTag}${statusTag}</span>
        </button>
      `;
    }

    html += `</div>`;
  }

  body.innerHTML = html;

  // Click to scroll to element
  body.querySelectorAll('.cms-content-map-item').forEach((item) => {
    item.addEventListener('click', () => {
      const rawIndex = item.getAttribute('data-caret-map-index');
      const index = rawIndex !== null && /^\d+$/.test(rawIndex) ? Number(rawIndex) : -1;
      const target = bindings[index];
      if (target?.el) {
        target.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.el.classList.add('cms-map-highlight');
        setTimeout(() => target.el.classList.remove('cms-map-highlight'), 2000);
      }
    });
  });
}

function toggle() {
  if (!panel) panel = createPanel();
  isOpen = !isOpen;
  panel.classList.toggle('cms-content-map-open', isOpen);
  panel.setAttribute('aria-hidden', String(!isOpen));
  if (isOpen) refresh();
  else refreshGeneration++;
}

/** @param {string} str @returns {string} */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {{ mapButton: Element | null }} options */
export function mountContentMap({ mapButton }) {
  if (!mapButton || mountedButtons.has(mapButton)) return;
  mountedButtons.add(mapButton);
  mapButton.addEventListener('click', toggle);
}
