import { t } from './i18n.js';

/**
 * What assistive technology hears about editable content. Editable text
 * inside a heading or link stops counting toward its name, so headings and
 * links would go nameless in edit mode; each gets its visible text as its name
 * instead, kept current as the editor types. Every editable region also
 * points at one shared description of how editing works.
 */

const HINT_ID = 'cms-edit-hint';

function hintId() {
  if (!document.getElementById(HINT_ID)) {
    const hint = document.createElement('span');
    hint.id = HINT_ID;
    hint.hidden = true;
    hint.textContent = t('editor.a11y.hint');
    document.body.appendChild(hint);
  }
  return HINT_ID;
}

/** @param {Element | null} element */
function visibleText(element) {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Give a heading, link or button its visible text as its name. @param {Element} el */
function syncNames(el) {
  const heading = el.closest('h1, h2, h3, h4, h5, h6');
  if (heading) heading.setAttribute('aria-label', visibleText(heading));
  const control = el.closest('a, button');
  if (control && !control.hasAttribute('data-cms-own-label')) control.setAttribute('aria-label', visibleText(control));
}

/** @type {WeakSet<Element>} */
const described = new WeakSet();

/**
 * Describe an editable text region and keep its heading or link named.
 * @param {HTMLElement} el
 */
export function describeEditableText(el) {
  if (described.has(el)) return;
  described.add(el);
  const ids = new Set((el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
  ids.add(hintId());
  el.setAttribute('aria-describedby', [...ids].join(' '));
  syncNames(el);
  el.addEventListener('input', () => syncNames(el));
  el.addEventListener('blur', () => syncNames(el));
}

/**
 * An editable image that takes focus acts as a button that replaces it.
 * Inside a link or button, that control keeps its own role.
 * @param {HTMLImageElement} img
 */
export function describeEditableImage(img) {
  if (img.closest('a, button')) return;
  img.setAttribute('role', 'button');
  img.setAttribute('aria-label', img.alt.trim() ? t('editor.a11y.replaceImage', { alt: img.alt.trim() }) : t('editor.a11y.replaceUndescribed'));
}
