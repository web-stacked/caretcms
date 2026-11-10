import { createTextLinkInteractions } from './text-link-interactions.js';
import { savesDrafts } from './config.js';
import { describeEditableText } from './a11y.js';
import { resolveBinding } from './helpers.js';
import { sanitizeHtml, unsupportedTags } from './sanitize.js';
import { bindUndo, dropEdit, recordEdit, undoLastEdit } from './undo-stack.js';
import { bindUnsavedChanges, clearUnsaved, isUnsaved, markUnsaved } from './unsaved.js';
import { t } from './i18n.js';

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
 *   saved: (options: { message: string, action?: { label: string, onClick: () => void | Promise<void> } }) => HTMLDivElement,
 *   dismiss: (toast: HTMLDivElement) => void,
 * }} ConflictToast
 */

/** Each field's last saved text. @type {WeakMap<HTMLElement, string>} */
const snapshots = new WeakMap();
/** Each field's text when the current edit began. @type {WeakMap<HTMLElement, string>} */
const editStarts = new WeakMap();
let keydownBound = false;

// Text edits save on their own: ~1.2s after typing stops, and on blur.
const AUTOSAVE_DELAY_MS = 1200;

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
  /** @param {string} attr @param {string} value @param {HTMLElement} [except] an element still being typed in */
  const syncBoundText = (attr, value, except) => {
    document.querySelectorAll('[data-caret]').forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.getAttribute('data-caret') !== attr) return;
      if (node instanceof HTMLImageElement || node === except) return;
      applyTextValue(node, value);
    });
  };
  const { onKeydown, showLinkHint, removeLinkHint, showLinkPopup } = createTextLinkInteractions({
    state,
    clientLinkify,
    showToast,
    editStarts,
  });
  bindUndo(showToast);

  if (!keydownBound) {
    document.addEventListener('keydown', onKeydown);
    keydownBound = true;
  }
  bindUnsavedChanges(showToast);

  document.querySelectorAll('[data-caret]').forEach((el) => {
    if (!(el instanceof HTMLElement) || el instanceof HTMLImageElement) return;
    if (el.hasAttribute('data-caret-locked')) return;
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
      if (unsupportedTags(el).length === 0) {
        el.setAttribute('data-caret-rich', '');
      } else {
        el.classList.add('cms-locked');
        el.title = t('editor.text.locked');
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
    describeEditableText(el);
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

    let edit = 0;
    let editSaved = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let autosaveTimer;

    el.addEventListener('focus', () => {
      // An unsaved field keeps the snapshot of its last saved value, so the
      // next blur compares against that and saves the kept text again.
      const keepSnapshot = isUnsaved(el);
      edit += 1;
      editSaved = false;
      if (isRich) {
        // Compared with what a save would store: sanitized markup, so attributes
        // the sanitizer drops never count as a change.
        if (!keepSnapshot) snapshots.set(el, sanitizeHtml(el.innerHTML));
      } else if (isLinkable) {
        const raw = el.getAttribute('data-caret-raw') || '';
        if (!keepSnapshot) snapshots.set(el, raw);
        el.textContent = raw;
        showLinkHint(el);
      } else if (!keepSnapshot) {
        snapshots.set(el, el.textContent || '');
      }
      editStarts.set(el, snapshots.get(el) ?? '');
    });

    el.addEventListener('input', () => {
      const snapshot = snapshots.get(el);
      const current = isRich ? sanitizeHtml(el.innerHTML) : (el.textContent || '');
      if (current !== snapshot) state.dirtyEls.add(el);
      else state.dirtyEls.delete(el);
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        if (document.activeElement === el && state.linkPopupEl !== el) void commit({ fromBlur: true, live: true });
      }, AUTOSAVE_DELAY_MS);
    });

    /** Save `value` over `expected` for undo and redo. @param {string} value @param {string} expected */
    const applyUndo = async (value, expected) => {
      const resolved = resolveBinding(el, parseCaretAttr(attr));
      if (!resolved) return false;
      const result = await saveField(resolved.collection, resolved.id, resolved.field, value, { baseValue: expected });
      if (result.ok) {
        snapshots.set(el, value);
        syncBoundText(attr, value);
        flash(el, true);
        return true;
      }
      showToast(result.reason === 'conflict'
        ? t('editor.edit.undoConflict')
        : t('editor.edit.undoFailed'), 'error');
      return false;
    };

    /** One undo step per edit: the first save of an edit adds it, later ones update it. @param {string} saved */
    const recordUndo = (saved) => {
      recordEdit({ el, edit, before: editStarts.get(el) ?? '', after: saved, apply: applyUndo });
      editSaved = true;
    };

    /** When an edit ends, confirm it once with Undo. @param {boolean} retried */
    const finishEdit = (retried) => {
      if (!editSaved) return;
      editSaved = false;
      // In draft modes a save isn't public yet; say so, as Markdown blocks do.
      showToast.saved({
        message: savesDrafts() ? t('editor.edit.draftSaved')
          : retried ? t('editor.text.changeSaved') : t('editor.edit.saved'),
        action: { label: t('editor.undo.undo'), onClick: undoLastEdit },
      });
    };

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
        message: t('editor.text.conflict'),
        onKeepMine: async () => {
          el.classList.remove('cms-conflict');
          el.classList.add('cms-saving');
          const retry = await saveField(resolved.collection, resolved.id, resolved.field, mine);
          el.classList.remove('cms-saving');
          flash(el, retry.ok);
          if (retry.ok) {
            state.dirtyEls.delete(el);
            syncBoundText(attr, mine);
            showToast(t('editor.text.mineSaved'), 'success');
          } else if (retry.reason === 'conflict') {
            runConflict(resolved, mine, retry.latestValue);
          } else if (retry.reason !== 'unauthorized') {
            showToast(t('editor.text.saveFailed'), 'error');
          }
        },
        onLoadLatest: () => {
          el.classList.remove('cms-conflict');
          state.dirtyEls.delete(el);
          const value = typeof latestValue === 'string' ? latestValue : mine;
          applyTextValue(el, value);
          snapshots.set(el, isRich ? sanitizeHtml(value) : value);
          syncBoundText(attr, value);
          showToast(t('editor.text.loadedLatest'), 'success');
        },
      });
    };

    const markSaved = () => clearUnsaved(el);

    // Save the field's text if it differs from the last saved value. On blur
    // the element holds the text being edited; on a retry it holds the
    // rendered value (for linkable fields the kept text is in data-caret-raw).
    // `live` is an autosave while the editor is still typing: the element's
    // DOM is left alone so the caret doesn't move. `cancel` is an Escape:
    // the edit's starting text is saved back and no undo step is kept.
    /** @param {{ fromBlur?: boolean, live?: boolean, cancel?: boolean }} [options] */
    const commit = async ({ fromBlur = false, live = false, cancel = false } = {}) => {
      // A retry while the editor is typing in this field waits for its blur.
      if (!fromBlur && document.activeElement === el) return;
      if (!live) clearTimeout(autosaveTimer);
      const snapshot = snapshots.get(el) ?? '';
      const wasUnsaved = isUnsaved(el);
      let current;
      if (isRich) {
        current = sanitizeHtml(el.innerHTML);
        if (!live) el.innerHTML = current; // normalize
      } else if (isLinkable && !fromBlur) {
        current = el.getAttribute('data-caret-raw') || '';
      } else {
        current = el.textContent || '';
      }

      if (current === snapshot) {
        markSaved();
        if (isLinkable && !live) {
          el.innerHTML = clientLinkify(current);
        }
        if (cancel) dropUndoForEdit();
        else if (!live) finishEdit(wasUnsaved);
        return;
      }

      const parsed = parseCaretAttr(el.getAttribute('data-caret') || '');
      const resolved = resolveBinding(el, parsed);
      if (!resolved) return;

      // Update raw attribute and re-render before saving
      if (isLinkable) {
        el.setAttribute('data-caret-raw', current);
        if (!live) el.innerHTML = clientLinkify(current);
      }

      el.classList.add('cms-saving');
      const result = await saveField(resolved.collection, resolved.id, resolved.field, current, { baseValue: snapshot });
      el.classList.remove('cms-saving');
      if (!live) flash(el, result.ok);

      if (result.ok) {
        markSaved();
        snapshots.set(el, current);
        const stillTyped = live && (isRich ? sanitizeHtml(el.innerHTML) : (el.textContent || '')) !== current;
        if (!stillTyped) state.dirtyEls.delete(el);
        syncBoundText(attr, current, live ? el : undefined);
        if (cancel) dropUndoForEdit();
        else {
          recordUndo(current);
          if (!live) finishEdit(wasUnsaved);
        }
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
        showToast(t('editor.text.refused', { reason: result.message.replace(/\.$/, '') }), 'error');
      } else {
        // Never throw the editor's text away: keep it, mark the field, and
        // retry on the next blur, when the browser comes back online or the
        // session is restored, or from the notice's Retry action. An expired
        // session has its own sign-in dialog instead of the notice.
        markUnsaved(el, commit, { quiet: result.reason === 'unauthorized' });
        state.dirtyEls.add(el);
      }
    };

    // An Escape after an autosave takes the edit back; it leaves no undo step.
    const dropUndoForEdit = () => {
      dropEdit(el, edit);
      editSaved = false;
    };

    el.addEventListener('blur', async () => {
      removeLinkHint();

      // If link popup is active for this element, defer the save
      if (state.linkPopupEl === el) return;

      // Escape put the edit's starting text back; save it if part of the
      // edit had already autosaved.
      if (editableEl._caretSkipSave) {
        editableEl._caretSkipSave = false;
        state.dirtyEls.delete(el);
        markSaved();
        await commit({ fromBlur: true, cancel: true });
        return;
      }

      await commit({ fromBlur: true });
    });
  });

  return { showLinkPopup };
}
