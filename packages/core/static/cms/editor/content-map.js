import { buildCmsUrl } from './config.js';
import { readHeaders } from './security.js';
import { parseCaretAttr, resolveBinding, getResolvedKey } from './helpers.js';

/**
 * Content Map dev panel.
 * Lists all data-caret bindings on the current page with override status.
 */

let panel = null;
let isOpen = false;

function createPanel() {
  const el = document.createElement('div');
  el.className = 'cms-content-map';
  el.innerHTML = `
    <div class="cms-content-map-header">
      <span class="cms-content-map-title">Content Map</span>
      <button type="button" class="cms-content-map-close">&times;</button>
    </div>
    <div class="cms-content-map-body"></div>
  `;
  document.body.appendChild(el);

  el.querySelector('.cms-content-map-close')?.addEventListener('click', () => {
    toggle();
  });

  return el;
}

async function loadOverrides(entryKeys) {
  const overrides = new Map();
  for (const key of entryKeys) {
    const [collection, id] = key.split('::');
    try {
      const res = await fetch(buildCmsUrl('/entries', { collection, id }), {
        headers: readHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.entries && data.entries.length > 0) {
          overrides.set(key, data.entries[0].data);
        }
      }
    } catch {
      // Skip failed loads
    }
  }
  return overrides;
}

function getNestedValue(data, path) {
  const keys = path.split('.');
  let current = data;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

async function refresh() {
  if (!panel) return;
  const body = panel.querySelector('.cms-content-map-body');
  if (!body) return;

  const elements = document.querySelectorAll('[data-caret]');
  const bindings = [];
  const entryKeys = new Set();

  elements.forEach((el) => {
    const attr = el.getAttribute('data-caret') || '';
    const parsed = parseCaretAttr(attr);
    const resolved = resolveBinding(el, parsed);
    if (!resolved) return;

    const key = `${resolved.collection}::${resolved.id}`;
    entryKeys.add(key);

    const isScoped = parsed && !parsed.collection;
    bindings.push({
      el,
      resolved,
      fullKey: `${resolved.collection}::${resolved.id}::${resolved.field}`,
      isImg: el instanceof HTMLImageElement,
      isScoped,
    });
  });

  body.innerHTML = `<div class="cms-content-map-loading">Loading...</div>`;

  const overrides = await loadOverrides(entryKeys);

  if (bindings.length === 0) {
    body.innerHTML = `<div class="cms-content-map-empty">No data-caret bindings found on this page.</div>`;
    return;
  }

  // Group by collection::id
  const groups = new Map();
  for (const b of bindings) {
    const key = `${b.resolved.collection}::${b.resolved.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  let html = '';
  for (const [entryKey, fields] of groups) {
    const entryData = overrides.get(entryKey);
    html += `<div class="cms-content-map-group">`;
    html += `<div class="cms-content-map-group-title">${escapeHtml(entryKey)}</div>`;

    for (const f of fields) {
      const hasOverride = entryData
        ? getNestedValue(entryData, f.resolved.field) !== undefined
        : false;

      const statusClass = hasOverride ? 'cms-map-saved' : 'cms-map-default';
      const statusLabel = hasOverride ? 'saved' : 'default';
      const scopeTag = f.isScoped ? '<span class="cms-map-scoped">scoped</span>' : '';
      const typeTag = f.isImg ? '<span class="cms-map-type">img</span>' : '';

      html += `
        <div class="cms-content-map-item" data-caret-map-key="${escapeAttr(f.fullKey)}">
          <span class="cms-content-map-field">${escapeHtml(f.resolved.field)}</span>
          <span class="cms-content-map-tags">
            ${typeTag}${scopeTag}
            <span class="cms-map-status ${statusClass}">${statusLabel}</span>
          </span>
        </div>
      `;
    }

    html += `</div>`;
  }

  body.innerHTML = html;

  // Click to scroll to element
  body.querySelectorAll('.cms-content-map-item').forEach((item) => {
    item.addEventListener('click', () => {
      const key = item.getAttribute('data-caret-map-key');
      const target = bindings.find((b) => b.fullKey === key);
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
  if (isOpen) refresh();
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function mountContentMap({ mapButton }) {
  mapButton?.addEventListener('click', toggle);
}
