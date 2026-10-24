import { buildCmsUrl } from './config.js';
import { historyFieldLabel } from '../studio/history-view.js';
import { readHeaders } from './security.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';

/**
 * Content map: every editable binding on the page, grouped by entry, named
 * the way the Studio form names it, with the value the page shows now.
 */

/** @typedef {{ collection: string, id: string, field: string }} ResolvedBinding */
/** @typedef {{ el: Element, resolved: ResolvedBinding, index: number }} MapBinding */

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
      <span class="cms-content-map-title">Content map</span>
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

/** The display title the entries API sends, or null. @param {unknown} payload */
export function readEntryTitle(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.entries)) return null;
  const entry = payload.entries[0];
  return isRecord(entry) && typeof entry.title === 'string' && entry.title ? entry.title : null;
}

/** "01-mara" -> "01 mara": the fallback when the server can't be asked. @param {string} id */
function readableId(id) {
  const text = id.replace(/[-_]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** @param {string} path @returns {Promise<unknown>} */
async function getJson(path) {
  try {
    const res = await fetch(path, { headers: readHeaders() });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** What the page shows for a binding, as one short line. @param {Element} el */
function shownValue(el) {
  if (el instanceof HTMLImageElement) {
    const file = (el.getAttribute('src') || '').split('?')[0].split('/').pop() || '';
    return el.alt.trim() || file;
  }
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

async function refresh() {
  if (!panel) return;
  const generation = ++refreshGeneration;
  const body = panel.querySelector('.cms-content-map-body');
  if (!body) return;

  /** @type {MapBinding[]} */
  const bindings = [];
  document.querySelectorAll('[data-caret]').forEach((el) => {
    const resolved = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
    if (resolved) bindings.push({ el, resolved, index: bindings.length });
  });

  if (bindings.length === 0) {
    body.innerHTML = '<div class="cms-content-map-empty">Nothing on this page is editable yet.</div>';
    return;
  }
  body.innerHTML = '<div class="cms-content-map-loading">Loading…</div>';

  /** @type {Map<string, MapBinding[]>} */
  const groups = new Map();
  for (const binding of bindings) {
    const key = `${binding.resolved.collection}::${binding.resolved.id}`;
    groups.set(key, [...(groups.get(key) ?? []), binding]);
  }
  const collections = [...new Set(bindings.map((binding) => binding.resolved.collection))];
  const [schemas, titles] = await Promise.all([
    Promise.all(collections.map((collection) => getJson(buildCmsUrl('/schema', { collection })))),
    Promise.all([...groups.keys()].map((key) => {
      const [collection, id] = key.split('::');
      return getJson(buildCmsUrl('/entries', { collection, id })).then(readEntryTitle);
    })),
  ]);
  if (!isOpen || generation !== refreshGeneration) return;

  /** @type {Map<string, { schema: unknown, label: string | null }>} */
  const collectionInfo = new Map(collections.map((collection, index) => {
    const payload = schemas[index];
    const metadata = isRecord(payload) && isRecord(payload.metadata) ? payload.metadata : null;
    return [collection, {
      schema: isRecord(payload) ? payload.schema : null,
      label: metadata && typeof metadata.label === 'string' ? metadata.label : null,
    }];
  }));

  body.innerHTML = '';
  [...groups.entries()].forEach(([key, fields], groupIndex) => {
    const [collection, id] = key.split('::');
    const info = collectionInfo.get(collection);
    const group = document.createElement('div');
    group.className = 'cms-content-map-group';
    const heading = document.createElement('div');
    heading.className = 'cms-content-map-group-title';
    const name = document.createElement('span');
    name.textContent = titles[groupIndex] ?? readableId(id);
    heading.appendChild(name);
    if (info?.label && info.label !== name.textContent) {
      const kind = document.createElement('span');
      kind.className = 'cms-content-map-kind';
      kind.textContent = info.label;
      heading.appendChild(kind);
    }
    group.appendChild(heading);

    for (const binding of fields) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'cms-content-map-item';
      const label = document.createElement('span');
      label.className = 'cms-content-map-field';
      label.textContent = historyFieldLabel(binding.resolved.field, /** @type {any} */ (info?.schema));
      const value = document.createElement('span');
      value.className = 'cms-content-map-value';
      value.textContent = shownValue(binding.el) || 'Empty';
      item.append(label, value);
      item.addEventListener('click', () => {
        binding.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        binding.el.classList.add('cms-map-highlight');
        setTimeout(() => binding.el.classList.remove('cms-map-highlight'), 2000);
      });
      group.appendChild(item);
    }
    body.appendChild(group);
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

/** @param {{ mapButton: Element | null }} options */
export function mountContentMap({ mapButton }) {
  if (!mapButton || mountedButtons.has(mapButton)) return;
  mountedButtons.add(mapButton);
  mapButton.addEventListener('click', toggle);
}
