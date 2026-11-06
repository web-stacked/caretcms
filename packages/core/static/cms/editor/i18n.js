// The editor's words in the site's locale. The asset route builds
// messages.js from the Studio dictionary (`editor.*` keys), so `caret({ locale,
// dictionary })` translates the on-page editor and the Studio alike.
import MESSAGES from './messages.js';

/**
 * The message for `key`, with `{name}` placeholders filled from `vars`.
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, vars = {}) {
  const message = /** @type {Record<string, string>} */ (MESSAGES)[key] ?? key;
  return message.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** @type {Record<string, string>} */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * `t()` escaped for an HTML template (text or a quoted attribute), since a
 * site's `dictionary` can say anything.
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function tHtml(key, vars = {}) {
  return t(key, vars).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Text drawn by the editor's CSS (`content:`) in the site's locale: set as
 * custom properties on <body>, which the stylesheet reads with English
 * fallbacks. A CSS string, so quotes and backslashes are escaped.
 */
export function applyCssMessages() {
  /** @param {string} text */
  const cssString = (text) => `"${text.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')}"`;
  document.body.style.setProperty('--cms-text-draft', cssString(t('editor.md.draftBadge')));
  document.body.style.setProperty('--cms-text-add', cssString(t('editor.text.emptyHint')));
}
