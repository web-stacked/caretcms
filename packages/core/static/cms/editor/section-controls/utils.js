import { SPACING_Y_VALUES } from './constants.js';
import { humanizeKey } from '../../studio/field-model.js';

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

/** @param {unknown} value @returns {string} */
export function spacingButtonLabel(value) {
  const token = spacingToken(value);
  return token === 'default' ? 'Spacing' : `Spacing: ${token}`;
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
