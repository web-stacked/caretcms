import { buildCmsUrl } from './config.js';
import { readHeaders } from './security.js';
import { bindingKey, parseCaretAttr, resolveBinding } from './helpers.js';
import { t, tHtml } from './i18n.js';

/**
 * After an image is replaced on the page, ask for its description (alt text)
 * when the entry has a field for it. The field is found by convention next to
 * the image's own: "images.0.src" → "images.0.alt", "cover" → "cover_alt" or
 * "coverAlt", and only used when the collection's schema has it.
 */

/** @typedef {{ collection: string, id: string, field: string }} Binding */
/** @typedef {{ properties?: Record<string, Schema>, items?: Schema, type?: unknown }} Schema */
/** @typedef {(collection: string, id: string, field: string, value: string) => Promise<{ ok: boolean }>} SaveField */

/** @type {Map<string, Promise<Schema | null>>} */
const schemas = new Map();

/** @param {string} collection */
function schemaFor(collection) {
  if (!schemas.has(collection)) {
    schemas.set(collection, fetch(buildCmsUrl('/schema', { collection }), { headers: readHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (body && typeof body.schema === 'object' ? /** @type {Schema} */ (body.schema) : null))
      .catch(() => null));
  }
  return /** @type {Promise<Schema | null>} */ (schemas.get(collection));
}

/** Whether the schema has a string field at this dotted path. @param {Schema | null} schema @param {string} path */
function hasTextField(schema, path) {
  /** @type {Schema | null | undefined} */
  let node = schema;
  for (const part of path.split('.')) {
    if (!node) return false;
    node = /^\d+$/.test(part) ? node.items : node.properties?.[part];
  }
  return Boolean(node) && (/** @type {Schema} */ (node).type === 'string');
}

/** The entry's alt-text field for an image field, or null. @param {Binding} image */
export async function altFieldFor(image) {
  const parts = image.field.split('.');
  const last = parts[parts.length - 1];
  const parent = parts.slice(0, -1);
  const candidates = [
    ...(last === 'src' ? [[...parent, 'alt'].join('.')] : []),
    [...parent, `${last}_alt`].join('.'),
    [...parent, `${last}Alt`].join('.'),
  ];
  const schema = await schemaFor(image.collection);
  return candidates.find((path) => hasTextField(schema, path)) ?? null;
}

/**
 * @param {{ saveField: SaveField, showToast: (message: string, kind: 'success' | 'error') => unknown }} options
 */
export function createAltPrompt({ saveField, showToast }) {
  /** @type {HTMLElement | null} */
  let backdrop = null;

  function build() {
    const el = document.createElement('div');
    el.className = 'cms-dialog-backdrop cms-alt-dialog';
    el.hidden = true;
    el.innerHTML = `
      <form class="cms-dialog" role="dialog" aria-modal="true" aria-labelledby="cms-alt-title" aria-describedby="cms-alt-copy">
        <h2 id="cms-alt-title">${tHtml('editor.alt.title')}</h2>
        <p id="cms-alt-copy">${tHtml('editor.alt.copy')}</p>
        <input class="cms-alt-input" type="text" aria-labelledby="cms-alt-title" autocomplete="off" />
        <div class="cms-dialog-actions">
          <button type="button" class="cms-alt-skip">${tHtml('editor.alt.skip')}</button>
          <button type="submit" class="cms-alt-save">${tHtml('editor.alt.save')}</button>
        </div>
      </form>`;
    document.body.appendChild(el);
    return el;
  }

  /**
   * Ask for the replaced image's description and save it to the alt field.
   * @param {HTMLImageElement} img @param {Binding} image
   */
  async function ask(img, image) {
    const field = await altFieldFor(image);
    if (!field) return;
    backdrop ??= build();
    const dialog = backdrop;
    const form = /** @type {HTMLFormElement} */ (dialog.querySelector('form'));
    const input = /** @type {HTMLInputElement} */ (dialog.querySelector('.cms-alt-input'));
    const skip = /** @type {HTMLButtonElement} */ (dialog.querySelector('.cms-alt-skip'));
    input.value = img.alt;
    dialog.hidden = false;
    input.focus();
    input.select();

    /** @type {string | null} */
    const answer = await new Promise((resolve) => {
      /** @param {string | null} value */
      function done(value) {
        dialog.hidden = true;
        form.removeEventListener('submit', submit);
        skip.removeEventListener('click', cancel);
        dialog.removeEventListener('keydown', keydown);
        if (img.isConnected) img.focus({ preventScroll: true });
        resolve(value);
      }
      /** @param {SubmitEvent} event */
      function submit(event) { event.preventDefault(); done(input.value.trim()); }
      function cancel() { done(null); }
      /** @param {KeyboardEvent} event */
      function keydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(null); }
        if (event.key !== 'Tab') return;
        const controls = [input, skip, /** @type {HTMLButtonElement} */ (dialog.querySelector('.cms-alt-save'))];
        const index = controls.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
        event.preventDefault();
        controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length].focus();
      }
      form.addEventListener('submit', submit);
      skip.addEventListener('click', cancel);
      dialog.addEventListener('keydown', keydown);
    });
    if (answer === null || answer === img.alt) return;

    const result = await saveField(image.collection, image.id, field, answer);
    if (!result.ok) return;
    // Every copy of the image gets it, and so does text bound to the field
    // (a caption showing the same description).
    document.querySelectorAll('img[data-caret]').forEach((node) => {
      if (bindingKey(node) === bindingKey(img)) /** @type {HTMLImageElement} */ (node).alt = answer;
    });
    document.querySelectorAll('[data-caret]').forEach((node) => {
      if (node instanceof HTMLImageElement) return;
      const bound = resolveBinding(node, parseCaretAttr(node.getAttribute('data-caret') || ''));
      if (bound && bound.collection === image.collection && bound.id === image.id && bound.field === field) node.textContent = answer;
    });
    showToast(t('editor.alt.saved'), 'success');
  }

  return { ask };
}
