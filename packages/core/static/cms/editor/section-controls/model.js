import { normalizeSpacingY, isRecord } from './utils.js';

/** @typedef {{ id: string, key: string, enabled: boolean, spacing_y?: string }} Section */

/** A section kind is the site's own key, such as "home.hero" or "faq". */
const SECTION_KEY_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i;

/** @param {unknown} rawKey @returns {string | null} */
function normalizeSectionKey(rawKey) {
  return typeof rawKey === 'string' && SECTION_KEY_RE.test(rawKey) ? rawKey : null;
}

/**
 * @param {string} preferred
 * @param {string} key
 * @param {number} index
 * @param {Set<string>} usedIds
 * @returns {string}
 */
function uniqueSectionId(preferred, key, index, usedIds) {
  const base = preferred.trim() || `sec-${key.replace(/\./g, '-')}-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix++;
  }
  usedIds.add(id);
  return id;
}

/** @param {unknown} entryData @param {Section[]} fallbackFromDom @returns {Section[]} */
export function normalizeSectionsFromData(entryData, fallbackFromDom) {
  if (!isRecord(entryData)) return fallbackFromDom;
  const layout = isRecord(entryData.layout) ? entryData.layout : {};
  const raw = Array.isArray(layout.sections) ? layout.sections : null;

  if (!raw) return fallbackFromDom;

  const usedIds = new Set();
  const normalized = raw
    .map((item, index) => {
      if (!isRecord(item)) return null;
      const key = normalizeSectionKey(item.key);
      if (!key) return null;

      const preferredId =
        typeof item.id === 'string' && item.id.trim()
          ? item.id.trim()
          : `sec-${key.replace(/\./g, '-')}-${index + 1}`;
      const id = uniqueSectionId(preferredId, key, index, usedIds);

      return {
        id,
        key,
        enabled: item.enabled !== false,
        spacing_y: normalizeSpacingY(item.spacing_y),
      };
    })
    .filter((section) => section !== null);

  if (!normalized.length) return fallbackFromDom;
  return normalized;
}

/** @param {Element[]} sectionNodes @returns {Section[]} */
export function sectionsFromDom(sectionNodes) {
  const usedIds = new Set();
  return sectionNodes
    .map((el, index) => {
      const rawKey = el.getAttribute('data-caret-section');
      const key = normalizeSectionKey(rawKey);
      if (!key) return null;

      const fallbackId = `sec-${key.replace(/\./g, '-')}-${index + 1}`;
      const rawId = el.getAttribute('data-caret-section-id') || fallbackId;
      return {
        id: uniqueSectionId(rawId, key, index, usedIds),
        key,
        enabled: true,
        spacing_y: normalizeSpacingY(el.getAttribute('data-caret-spacing-y')),
      };
    })
    .filter((section) => section !== null);
}

/**
 * @param {{ sections: Section[], sourceId: string, targetId: string, placeAfter: boolean }} options
 * @returns {Section[]}
 */
export function reorderByDrag({ sections, sourceId, targetId, placeAfter }) {
  if (sourceId === targetId) return sections;

  const sourceIndex = sections.findIndex((section) => section.id === sourceId);
  const targetIndex = sections.findIndex((section) => section.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) return sections;

  const next = [...sections];
  const [source] = next.splice(sourceIndex, 1);
  if (!source) return sections;
  const currentTargetIndex = next.findIndex((section) => section.id === targetId);
  const insertIndex = currentTargetIndex + (placeAfter ? 1 : 0);
  next.splice(insertIndex, 0, source);
  return next;
}
