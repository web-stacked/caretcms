import { SPACING_Y_VALUES } from './constants.js';
import { humanizeKey } from '../../studio/field-model.js';
import { t } from '../i18n.js';

/** A section kind's name when its template gives none: "home.how_it_works" → "How it works". @param {string} key */
export function humanizeSectionKey(key) {
  return humanizeKey(key.split('.').pop() || key);
}

/** @param {unknown} value @returns {string | undefined} */
export function normalizeSpacingY(value) {
  if (typeof value !== 'string') return undefined;
  return SPACING_Y_VALUES.includes(value) && value !== 'default' ? value : undefined;
}

/** @param {unknown} value @returns {string} */
export function spacingToken(value) {
  return normalizeSpacingY(value) || 'default';
}

/** @param {unknown} value @returns {number} */
export function spacingIndex(value) {
  const idx = SPACING_Y_VALUES.indexOf(spacingToken(value));
  return idx === -1 ? 0 : idx;
}

/** A spacing value's name inside a sentence ("compact"). @param {unknown} value @returns {string} */
export function spacingName(value) {
  const token = spacingToken(value);
  if (token === 'compact') return t('editor.sections.spacingNameCompact');
  if (token === 'comfortable') return t('editor.sections.spacingNameComfortable');
  if (token === 'spacious') return t('editor.sections.spacingNameSpacious');
  if (token === 'cinematic') return t('editor.sections.spacingNameCinematic');
  return t('editor.sections.spacingNameDefault');
}

/** @param {unknown} value @returns {string} */
export function spacingButtonLabel(value) {
  return spacingToken(value) === 'default'
    ? t('editor.sections.spacing')
    : t('editor.sections.spacingIs', { spacing: spacingName(value) });
}

/** The spacing handle's label: "Default spacing", "compact spacing". @param {unknown} value @returns {string} */
export function spacingHandleLabel(value) {
  return spacingToken(value) === 'default'
    ? t('editor.sections.defaultSpacing')
    : t('editor.sections.namedSpacing', { spacing: spacingName(value) });
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} key @returns {string} */
export function generateSectionId(key) {
  return `sec-${key.replace(/\./g, '-')}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
