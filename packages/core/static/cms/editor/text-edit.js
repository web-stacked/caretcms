import { createTextLinkInteractions } from './text-link-interactions.js';
import { resolveBinding } from './helpers.js';
import { sanitizeHtml } from './sanitize.js';

const snapshots = new WeakMap();
let keydownBound = false;

export function mountTextEditors({
  state,
  parseCaretAttr,
  clientLinkify,
  saveField,
  flash,
  showToast,
}) {
  const applyTextValue = (target, value) => {
    if (target.hasAttribute('data-caret-rich')) {
      target.innerHTML = sanitizeHtml(value);
    } else if (target.hasAttribute('data-caret-raw')) {
      target.setAttribute('data-caret-raw', value);
      target.innerHTML = clientLinkify(value);
    } else {
      target.textContent = value;
    }
  };
  const syncBoundText = (attr, value) => {
    document.querySelectorAll('[data-caret]').forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.getAttribute('data-caret') !== attr) return;
      if (node instanceof HTMLImageElement) return;
      applyTextValue(node, value);
    });
  };
  const { onKeydown, showLinkHint, removeLinkHint, showLinkPopup } = createTextLinkInteractions({
    state,
    clientLinkify,
    showToast,
    snapshots,
  });

  if (!keydownBound) {
    document.addEventListener('keydown', onKeydown);
    keydownBound = true;
  }

  document.querySelectorAll('[data-caret]').forEach((el) => {
    if (el instanceof HTMLImageElement) return;
    if (el.dataset.caretTextMounted === 'true') return;
    el.dataset.caretTextMounted = 'true';

    const attr = el.getAttribute('data-caret');
    const isRich = el.hasAttribute('data-caret-rich');
    const isLinkable = !isRich && el.hasAttribute('data-caret-raw');

    el.setAttribute('contenteditable', isRich ? 'true' : 'plaintext-only');
    el.classList.add('cms-editable');
    if (isRich) el.classList.add('cms-rich');
    if (isLinkable) el.classList.add('cms-linkable');

    // Plain-text fields render with HTML whitespace collapsing, but a
    // contenteditable element exposes the raw source whitespace (newlines +
    // indentation) verbatim. A paragraph authored across several indented
    // source lines then shows large gaps in the editor that aren't in the
    // final page — and, if edited, the raw whitespace leaks into the saved
    // value. Collapse it once on mount so the editable text matches the
    // rendered text and the snapshot/saved value stays clean. Rich fields are
    // left alone — their whitespace is governed by their own HTML.
    if (!isRich) {
      if (isLinkable) {
        const rawAttr = el.getAttribute('data-caret-raw') || '';
        const collapsed = rawAttr.replace(/\s+/g, ' ').trim();
        if (rawAttr !== collapsed) {
          el.setAttribute('data-caret-raw', collapsed);
          el.innerHTML = clientLinkify(collapsed);
        }
      } else {
        const collapsed = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (el.textContent !== collapsed) el.textContent = collapsed;
      }
    }

    el.addEventListener('focus', () => {
      if (isRich) {
        snapshots.set(el, el.innerHTML);
      } else if (isLinkable) {
        const raw = el.getAttribute('data-caret-raw') || '';
        snapshots.set(el, raw);
        el.textContent = raw;
        showLinkHint(el);
      } else {
        snapshots.set(el, el.textContent || '');
      }
    });

    el.addEventListener('input', () => {
      const snapshot = snapshots.get(el);
      const current = isRich ? el.innerHTML : (el.textContent || '');
      state.dirtyEl = current !== snapshot ? el : null;
    });

    el.addEventListener('blur', async () => {
      removeLinkHint();

      // If link popup is active for this element, defer the save
      if (state.linkPopupEl === el) return;

      // Skip save if Escape was pressed
      if (el._caretSkipSave) {
        el._caretSkipSave = false;
        state.dirtyEl = null;
        if (isRich) {
          el.innerHTML = snapshots.get(el) || '';
        } else if (isLinkable) {
          const raw = el.getAttribute('data-caret-raw') || '';
          el.innerHTML = clientLinkify(raw);
        }
        return;
      }

      const snapshot = snapshots.get(el) ?? '';
      let current;
      if (isRich) {
        current = sanitizeHtml(el.innerHTML);
        el.innerHTML = current; // normalize
      } else {
        current = el.textContent || '';
      }

      if (current === snapshot) {
        if (isLinkable) {
          el.innerHTML = clientLinkify(current);
        }
        return;
      }

      const parsed = parseCaretAttr(el.getAttribute('data-caret') || '');
      const resolved = resolveBinding(el, parsed);
      if (!resolved) return;

      // Update raw attribute and re-render before saving
      if (isLinkable) {
        el.setAttribute('data-caret-raw', current);
        el.innerHTML = clientLinkify(current);
      }

      el.classList.add('cms-saving');
      const result = await saveField(resolved.collection, resolved.id, resolved.field, current);
      el.classList.remove('cms-saving');
      flash(el, result.ok);
      state.dirtyEl = null;

      // Sync all duplicated text bindings
      if (result.ok) {
        syncBoundText(attr, current);
        showToast('Content saved', 'success');
      } else {
        const rollbackValue =
          result.reason === 'conflict' && typeof result.latestValue === 'string'
            ? result.latestValue
            : snapshot;
        syncBoundText(attr, rollbackValue);

        if (result.reason === 'conflict') {
          showToast('Content changed elsewhere. Loaded latest value.', 'error');
        } else if (result.reason !== 'unauthorized') {
          showToast('Failed to save. Changes reverted.', 'error');
        }
      }
    });
  });

  return { showLinkPopup };
}
