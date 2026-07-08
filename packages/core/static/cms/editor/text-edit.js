import { createTextLinkInteractions } from './text-link-interactions.js';
import { resolveBinding } from './helpers.js';
import { sanitizeHtml } from './sanitize.js';

const snapshots = new WeakMap();
let keydownBound = false;

// `contenteditable="plaintext-only"` isn't supported in older Firefox (pre-136);
// setting it there leaves the element non-editable. Feature-detect once and fall
// back to "true" (rich contenteditable) — the blur handler saves via textContent
// for non-rich fields, so the stored value stays plain-text regardless.
const PLAINTEXT_ONLY_SUPPORTED = (() => {
  try {
    const probe = document.createElement('div');
    probe.setAttribute('contenteditable', 'plaintext-only');
    return probe.contentEditable === 'plaintext-only';
  } catch (e) {
    return false;
  }
})();

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

    el.setAttribute(
      'contenteditable',
      isRich || !PLAINTEXT_ONLY_SUPPORTED ? 'true' : 'plaintext-only',
    );
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
      if (current !== snapshot) state.dirtyEls.add(el);
      else state.dirtyEls.delete(el);
    });

    // Save-conflict resolution: never silently discard the user's edit. Keep
    // their text in the field and offer an explicit choice. "Keep mine" re-saves
    // (the save queue refreshed the cached revision on the 409, so the retry
    // targets the current revision and overwrites); "Load latest" replaces the
    // field with the server value. The element stays dirty until resolved.
    const runConflict = (resolved, mine, latestValue) => {
      state.dirtyEls.add(el);
      el.classList.add('cms-conflict');
      showToast.conflict({
        message: 'This content changed elsewhere while you were editing.',
        onKeepMine: async () => {
          el.classList.remove('cms-conflict');
          el.classList.add('cms-saving');
          const retry = await saveField(resolved.collection, resolved.id, resolved.field, mine);
          el.classList.remove('cms-saving');
          flash(el, retry.ok);
          if (retry.ok) {
            state.dirtyEls.delete(el);
            syncBoundText(attr, mine);
            showToast('Your version saved', 'success');
          } else if (retry.reason === 'conflict') {
            runConflict(resolved, mine, retry.latestValue);
          } else if (retry.reason !== 'unauthorized') {
            showToast('Failed to save. Try again.', 'error');
          }
        },
        onLoadLatest: () => {
          el.classList.remove('cms-conflict');
          state.dirtyEls.delete(el);
          const value = typeof latestValue === 'string' ? latestValue : mine;
          applyTextValue(el, value);
          snapshots.set(el, isRich ? sanitizeHtml(value) : value);
          syncBoundText(attr, value);
          showToast('Loaded latest version', 'success');
        },
      });
    };

    el.addEventListener('blur', async () => {
      removeLinkHint();

      // If link popup is active for this element, defer the save
      if (state.linkPopupEl === el) return;

      // Skip save if Escape was pressed
      if (el._caretSkipSave) {
        el._caretSkipSave = false;
        state.dirtyEls.delete(el);
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

      if (result.ok) {
        state.dirtyEls.delete(el);
        syncBoundText(attr, current);
        showToast('Content saved', 'success');
      } else if (result.reason === 'conflict') {
        // Preserve the user's edit and let them choose — don't overwrite it.
        runConflict(resolved, current, result.latestValue);
      } else if (result.reason !== 'unauthorized') {
        // Genuine failure (not an auth redirect): revert to the pre-edit snapshot.
        state.dirtyEls.delete(el);
        syncBoundText(attr, snapshot);
        showToast('Failed to save. Changes reverted.', 'error');
      }
    });
  });

  return { showLinkPopup };
}
