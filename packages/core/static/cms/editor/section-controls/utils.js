import { SPACING_Y_VALUES } from './constants.js';

export function humanizeSectionKey(key) {
  const short = key.startsWith('home.') ? key.slice('home.'.length) : key;
  return short.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function normalizeSpacingY(value) {
  if (typeof value !== 'string') return undefined;
  return SPACING_Y_VALUES.includes(value) && value !== 'default' ? value : undefined;
}

export function spacingToken(value) {
  return normalizeSpacingY(value) || 'default';
}

export function spacingIndex(value) {
  const idx = SPACING_Y_VALUES.indexOf(spacingToken(value));
  return idx === -1 ? 0 : idx;
}

export function spacingButtonLabel(value) {
  const token = spacingToken(value);
  return token === 'default' ? 'Space' : `Space:${token}`;
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function generateSectionId(key) {
  return `sec-${key.replace(/\./g, '-')}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
