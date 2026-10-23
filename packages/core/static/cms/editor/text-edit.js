import { createTextLinkInteractions } from './text-link-interactions.js';
import { resolveBinding } from './helpers.js';
import { ALLOWED_TAGS, sanitizeHtml } from './sanitize.js';
import { SESSION_RESTORED_EVENT } from './session-recovery.js';

/** @typedef {HTMLElement & { _caretSkipSave?: boolean }} EditableElement */
/** @typedef {{ collection: string, id: string, field: string }} ResolvedCaretBinding */
/** @typedef {{ collection: string | null, id: string | null, field: string }} ParsedCaretBinding */
/** @typedef {{ dirtyEls: Set<Element>, linkPopupEl: HTMLElement | null }} TextEditorState */
/** @typedef {{ ok: true, revision?: number } | { ok: false, reason: 'conflict' | 'unauthorized' | 'error', latestValue?: unknown } | { ok: false, reason: 'invalid', message: string }} SaveResult */
/**
 * @typedef {((message: string, kind: 'success' | 'error') => unknown) & {
 *   conflict: (options: {
 *     message: string,
 *     onKeepMine: () => void | Promise<void>,
 *     onLoadLatest: () => void,
 *   }) => unknown,
 *   pending: (options: { message: string, actions: { label: string, primary?: boolean, onClick: () => void | Promise<void> }[] }) => HTMLDivElement,
 *   dismiss: (toast: HTMLDivElement) => void,
 * }} ConflictToast
 */

/** @type {WeakMap<HTMLElement, string>} */
const snapshots = new WeakMap();
let keydownBound = false;

// Fields whose last save failed, each with the function that saves it again.
// Their text stays on the page and their snapshot stays at the last saved
// value, so leaving the field or coming back online retries the same change.
/** @type {Map<HTMLElement, () => Promise<void>>} */
const unsavedFields = new Map();
/** @type {HTMLDivElement | null} */
let unsavedToast = null;
let onlineRetryBound = false;

function retryUnsavedFields() {
  for (const save of [...unsavedFields.values()]) void save();
}

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

/**
 * @param {object} options
 * @param {TextEditorState} options.state
 * @param {(attr: string) => ParsedCaretBinding | null} options.parseCaretAttr
 * @param {(text: string) => string} options.clientLinkify
 * @param {(collection: string, id: string, field: string, value: string, options?: { baseValue?: string }) => Promise<SaveResult>} options.saveField
 * @param {(element: Element, success: boolean) => void} options.flash
 * @param {ConflictToast} options.showToast
 */
export function mountTextEditors({
  state,
  parseCaretAttr,
  clientLinkify,
  saveField,
  flash,
  showToast,
}) {
  /** @param {HTMLElement} target @param {string} value */
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
  /** @param {string} attr @param {string} value */
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
  if (!onlineRetryBound) {
    window.addEventListener('online', retryUnsavedFields);
    window.addEventListener(SESSION_RESTORED_EVENT, retryUnsavedFields);
    onlineRetryBound = true;
  }

  function showUnsavedNotice() {
    if (unsavedToast && document.body.contains(unsavedToast)) return;
    unsavedToast = showToast.pending({
      message: navigator.onLine
        ? "Couldn't save your change. It's kept on the page."
        : "You're offline. Your change is kept and saves when you reconnect.",
      actions: [{ label: 'Retry now', primary: true, onClick: retryUnsavedFields }],
    });
  }

  function clearUnsavedNotice() {
    if (unsavedFields.size > 0 || !unsavedToast) return;
    showToast.dismiss(unsavedToast);
    unsavedToast = null;
  }

  document.querySelectorAll('[data-caret]').forEach((el) => {
    if (!(el instanceof HTMLElement) || el instanceof HTMLImageElement) return;
    const editableEl = /** @type {EditableElement} */ (el);
    if (el.dataset.caretTextMounted === 'true') return;
    el.dataset.caretTextMounted = 'true';

    const attr = el.getAttribute('data-caret');
    if (!attr) return;
    // A plain binding with formatting inside: when the rich allowlist covers
    // every tag, edit it as rich text (the server renders it the same way);
    // otherwise saving would flatten markup the page never shows, so keep it
    // read-only and say why.
    if (!el.hasAttribute('data-caret-rich') && !el.hasAttribute('data-caret-raw') && el.children.length > 0) {
      const tags = [...el.querySelectorAll('*')].map((child) => child.tagName.toLowerCase());
      if (tags.every((tag) => ALLOWED_TAGS.has(tag))) {
        el.setAttribute('data-caret-rich', '');
      } else {
        el.classList.add('cms-locked');
        el.title = "This text includes layout that can't be edited on the page.";
        return;
      }
    }
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
      // An unsaved field keeps the snapshot of its last saved value, so the
      // next blur compares against that and saves the kept text again.
      const keepSnapshot = unsavedFields.has(el);
      if (isRich) {
        if (!keepSnapshot) snapshots.set(el, el.innerHTML);
      } else if (isLinkable) {
        const raw = el.getAttribute('data-caret-raw') || '';
        if (!keepSnapshot) snapshots.set(el, raw);
        el.textContent = raw;
        showLinkHint(el);
      } else if (!keepSnapshot) {
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
    /**
     * @param {ResolvedCaretBinding} resolved
     * @param {string} mine
     * @param {unknown} latestValue
     */
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

    const markSaved = () => {
      unsavedFields.delete(el);
      el.classList.remove('cms-unsaved');
      clearUnsavedNotice();
    };

    // Save the field's text if it differs from the last saved value. On blur
    // the element holds the text being edited; on a retry it holds the
    // rendered value (for linkable fields the kept text is in data-caret-raw).
    /** @param {{ fromBlur?: boolean }} [options] */
    const commit = async ({ fromBlur = false } = {}) => {
      // A retry while the editor is typing in this field waits for its blur.
      if (!fromBlur && document.activeElement === el) return;
      const snapshot = snapshots.get(el) ?? '';
      let current;
      if (isRich) {
        current = sanitizeHtml(el.innerHTML);
        el.innerHTML = current; // normalize
      } else if (isLinkable && !fromBlur) {
        current = el.getAttribute('data-caret-raw') || '';
      } else {
        current = el.textContent || '';
      }

      if (current === snapshot) {
        markSaved();
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
      const result = await saveField(resolved.collection, resolved.id, resolved.field, current, { baseValue: snapshot });
      el.classList.remove('cms-saving');
      flash(el, result.ok);

      if (result.ok) {
        const wasUnsaved = unsavedFields.has(el);
        markSaved();
        snapshots.set(el, current);
        state.dirtyEls.delete(el);
        syncBoundText(attr, current);
        showToast(wasUnsaved ? 'Your change is saved' : 'Content saved', 'success');
      } else if (result.reason === 'conflict') {
        markSaved();
        // Preserve the user's edit and let them choose — don't overwrite it.
        runConflict(resolved, current, result.latestValue);
      } else if (result.reason === 'invalid') {
        // The server refused the value (an emptied required field, say), so a
        // retry can't help: put the saved text back and say why.
        markSaved();
        state.dirtyEls.delete(el);
        syncBoundText(attr, snapshot);
        showToast(`${result.message.replace(/\.$/, '')}. The previous text is back.`, 'error');
      } else {
        // Never throw the editor's text away: keep it, mark the field, and
        // retry on the next blur, when the browser comes back online or the
        // session is restored, or from the notice's Retry action. An expired
        // session has its own sign-in dialog instead of the notice.
        unsavedFields.set(el, commit);
        el.classList.add('cms-unsaved');
        state.dirtyEls.add(el);
        if (result.reason !== 'unauthorized') showUnsavedNotice();
      }
    };

    el.addEventListener('blur', async () => {
      removeLinkHint();

      // If link popup is active for this element, defer the save
      if (state.linkPopupEl === el) return;

      // Skip save if Escape was pressed
      if (editableEl._caretSkipSave) {
        editableEl._caretSkipSave = false;
        state.dirtyEls.delete(el);
        markSaved();
        if (isRich) {
          el.innerHTML = snapshots.get(el) || '';
        } else if (isLinkable) {
          const raw = el.getAttribute('data-caret-raw') || '';
          el.innerHTML = clientLinkify(raw);
        }
        return;
      }

      await commit({ fromBlur: true });
    });
  });

  return { showLinkPopup };
}
