import { HOME_SECTION_KEYS } from './constants.js';
import { normalizeSpacingY, isRecord } from './utils.js';

const LEGACY_SECTION_KEY_MAP = {
  'home.trust_badges': 'home.logo_bar',
  'home.featured': 'home.features',
};

function normalizeSectionKey(rawKey) {
  if (typeof rawKey !== 'string') return null;
  const mapped = LEGACY_SECTION_KEY_MAP[rawKey] || rawKey;
  return HOME_SECTION_KEYS.includes(mapped) ? mapped : null;
}

export function normalizeSectionsFromData(entryData, fallbackFromDom) {
  const layout = isRecord(entryData.layout) ? entryData.layout : {};
  const raw = Array.isArray(layout.sections) ? layout.sections : null;

  if (!raw) return fallbackFromDom;

  const normalized = raw
    .map((item, index) => {
      if (!isRecord(item)) return null;
      const key = normalizeSectionKey(item.key);
      if (!key) return null;

      const id =
        typeof item.id === 'string' && item.id.trim()
          ? item.id.trim()
          : `sec-${key.replace(/\./g, '-')}-${index + 1}`;

      return {
        id,
        key,
        enabled: item.enabled !== false,
        spacing_y: normalizeSpacingY(item.spacing_y),
      };
    })
    .filter(Boolean);

  if (!normalized.length) return fallbackFromDom;
  return normalized;
}

export function sectionsFromDom(sectionNodes) {
  return sectionNodes
    .map((el, index) => {
      const rawKey = el.getAttribute('data-caret-section') || 'home.hero';
      const key = normalizeSectionKey(rawKey);
      if (!key) return null;

      const fallbackId = `sec-${key.replace(/\./g, '-')}-${index + 1}`;
      return {
        id: el.getAttribute('data-caret-section-id') || fallbackId,
        key,
        enabled: true,
        spacing_y: normalizeSpacingY(el.getAttribute('data-caret-spacing-y')),
      };
    })
    .filter(Boolean);
}

export function reorderByDrag({ sections, sourceId, targetId, placeAfter }) {
  if (sourceId === targetId) return sections;

  const sourceIndex = sections.findIndex((section) => section.id === sourceId);
  const targetIndex = sections.findIndex((section) => section.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) return sections;

  const next = [...sections];
  const [source] = next.splice(sourceIndex, 1);
  const currentTargetIndex = next.findIndex((section) => section.id === targetId);
  const insertIndex = currentTargetIndex + (placeAfter ? 1 : 0);
  next.splice(insertIndex, 0, source);
  return next;
}
