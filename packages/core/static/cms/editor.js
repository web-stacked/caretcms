/**
 * CMS Inline Editor runtime entry.
 *
 * This file is intentionally thin and wires independent controllers:
 * - guards
 * - toolbar
 * - studio panel + iframe sync
 * - text editing
 * - image editing
 * - content map
 */
import { STUDIO_PATH, buildCmsUrl, clearCloudSessionToken } from './editor/config.js';
import { parseCaretAttr, resolveBinding, flash } from './editor/helpers.js';
import { clientLinkify } from './editor/linkify.js';
import { createSaveField } from './editor/save-queue.js';
import { compressImage, updateEmblaCarousel } from './editor/image-utils.js';
import { createToast } from './editor/toast.js';
import { mountEditorGuards } from './editor/guards.js';
import { mountToolbar, normalizePreviewForDelivery } from './editor/toolbar.js';
import { mountStudioPanel } from './editor/panel.js';
import { mountStudioSync } from './editor/sync.js';
import { mountTextEditors } from './editor/text-edit.js';
import { canUndoLastEdit, undoLastEdit } from './editor/undo-stack.js';
import { mountImageEditors } from './editor/image-edit.js';
import { mountSectionControls } from './editor/section-controls.js';
import { mountContentMap } from './editor/content-map.js';
import { mountRichToolbar } from './editor/rich-toolbar.js';
import { mountMdBlockEditors } from './editor/md-block-edit.js';
import { mountLinkFollowAffordances } from './editor/link-follow.js';
import { revealAndFade } from './editor/highlight.js';
import { hydrateStega } from './editor/stega-hydrate.js';
import { createSessionRecovery } from './editor/session-recovery.js';

/**
 * A Set that reports its size after every change.
 * @template T
 * @param {(size: number) => void} onChange
 * @returns {Set<T>}
 */
function createObservedSet(onChange) {
  /** @type {Set<T>} */
  const set = new Set();
  const add = set.add.bind(set);
  const remove = set.delete.bind(set);
  const clear = set.clear.bind(set);
  set.add = (value) => { add(value); onChange(set.size); return set; };
  set.delete = (value) => { const removed = remove(value); onChange(set.size); return removed; };
  set.clear = () => { clear(); onChange(set.size); };
  return set;
}

function boot() {
  if (normalizePreviewForDelivery()) return;

  /** @type {(unsaved: boolean) => void} */
  let reportUnsaved = () => {};
  // Unsaved text on the page or in the Studio drawer both show on the status.
  let inlineUnsaved = false;
  let studioUnsaved = false;

  /** @type {{ dirtyEls: Set<Element>, linkPopupEl: HTMLElement | null }} */
  const state = {
    // Every element with unsaved edits. A Set (not a single element) so a save
    // completing on field A can't clear the dirty flag for field B the user has
    // since moved to — that would let the beforeunload guard miss B's edits.
    // Every change is reported so the toolbar can show "Unsaved changes".
    dirtyEls: createObservedSet(size => { inlineUnsaved = size > 0; reportUnsaved(inlineUnsaved || studioUnsaved); }),
    linkPopupEl: null,
  };

  // Promote stega-tagged (loader-fed) content into data-caret bindings before
  // any scanner runs, so prop/component/loop content is click-to-edit too.
  hydrateStega();

  const sessionRecovery = createSessionRecovery();
  const onUnauthorized = () => sessionRecovery.handleExpired();

  mountEditorGuards(state);
  mountLinkFollowAffordances();

  const showToast = createToast();

  const { studioButton, mapButton, editModeButton, previewModeButton, setStatus, setUnsaved, reportProblem } = mountToolbar({
    showToast,
    clearDirty: () => {
      state.dirtyEls.clear();
    },
    hasUnsavedEdits: () => state.dirtyEls.size > 0,
    undo: { available: canUndoLastEdit, run: undoLastEdit },
    onOpenHistory: () => openHistory(),
    onLogout: async () => {
      const response = await fetch(buildCmsUrl('/auth/logout'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect: '/' }),
      });
      const result = response.ok ? await response.json().catch(() => null) : null;
      clearCloudSessionToken();
      window.location.href = typeof result?.redirect === 'string' ? result.redirect : '/';
    },
  });

  reportUnsaved = setUnsaved;
  showToast.onProblem = reportProblem;

  const saveField = createSaveField({
    setStatus,
    onUnauthorized,
  });

  const { iframe: studioIframe, placeOpposite, openAt } = mountStudioPanel({ studioButton });

  // History for the entry this page shows: the one the drawer last had open,
  // else the page's first editable binding.
  function openHistory() {
    if (!STUDIO_PATH) return;
    let entryPath = '';
    try {
      const remembered = (sessionStorage.getItem('cms-panel-path') || '').split(/[?#]/)[0];
      if (remembered.startsWith(`${STUDIO_PATH}/`) && /^\/[^/]+\/[^/]+$/.test(remembered.slice(STUDIO_PATH.length))) {
        entryPath = remembered;
      }
    } catch { /* no remembered drawer route */ }
    if (!entryPath) {
      for (const element of document.querySelectorAll('[data-caret]')) {
        const resolved = resolveBinding(element, parseCaretAttr(element.getAttribute('data-caret') || ''));
        if (resolved) { entryPath = `${STUDIO_PATH}/${encodeURIComponent(resolved.collection)}/${encodeURIComponent(resolved.id)}`; break; }
      }
    }
    if (entryPath) openAt(`${entryPath}#history`);
  }

  mountStudioSync({
    studioIframe,
    state,
    showToast,
    clientLinkify,
    onInlineSelection: placeOpposite,
    onStudioDirty: (dirty) => { studioUnsaved = dirty; reportUnsaved(inlineUnsaved || studioUnsaved); },
  });

  mountContentMap({ mapButton });

  let richToolbarMounted = false;
  /** @type {'edit' | 'preview'} */
  let pageMode = 'edit';

  function applyPageMode() {
    const previewing = pageMode === 'preview';
    document.body.classList.toggle('cms-preview-mode', previewing);
    editModeButton?.setAttribute('aria-pressed', String(!previewing));
    previewModeButton?.setAttribute('aria-pressed', String(previewing));
    document.querySelectorAll('[data-caret][contenteditable], [data-caret-md][contenteditable]').forEach((element) => {
      if (!(element instanceof HTMLElement)) return;
      if (previewing) {
        if (!element.dataset.caretEditContenteditable) {
          element.dataset.caretEditContenteditable = element.getAttribute('contenteditable') || 'true';
        }
        element.setAttribute('contenteditable', 'false');
      } else if (element.dataset.caretEditContenteditable) {
        element.setAttribute('contenteditable', element.dataset.caretEditContenteditable);
        delete element.dataset.caretEditContenteditable;
      }
    });
  }

  /** @param {'edit' | 'preview'} mode */
  function setPageMode(mode) {
    pageMode = mode;
    try { sessionStorage.setItem('cms-page-mode', mode); } catch {}
    applyPageMode();
  }

  try {
    if (sessionStorage.getItem('cms-page-mode') === 'preview') pageMode = 'preview';
  } catch {}

  editModeButton?.addEventListener('click', () => setPageMode('edit'));
  previewModeButton?.addEventListener('click', () => setPageMode('preview'));

  const mountInlineEditors = () => {
    const { showLinkPopup } = mountTextEditors({
      state,
      parseCaretAttr,
      clientLinkify,
      saveField,
      flash,
      showToast,
    });

    if (!richToolbarMounted) {
      mountRichToolbar({ state, showToast, showLinkPopup });
      richToolbarMounted = true;
    }

    mountMdBlockEditors({
      state,
      flash,
      showToast,
      onUnauthorized,
    });

    mountImageEditors({
      parseCaretAttr,
      flash,
      compressImage,
      updateEmblaCarousel,
      saveField,
      setStatus,
      showToast,
      onUnauthorized,
    });
    applyPageMode();
    primeRenderedRevisions();
  };

  // Each entry's revision as of page load is the base its inline edits are
  // checked against; see `saveField.prime`.
  function primeRenderedRevisions() {
    const seen = new Set();
    document.querySelectorAll('[data-caret]').forEach((element) => {
      const resolved = resolveBinding(element, parseCaretAttr(element.getAttribute('data-caret') || ''));
      if (!resolved) return;
      const key = `${resolved.collection}::${resolved.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      saveField.prime(resolved.collection, resolved.id);
    });
  }

  mountSectionControls({
    parseCaretAttr,
    setStatus,
    showToast,
    onUnauthorized,
    onCanvasStructureChanged: mountInlineEditors,
  });

  mountInlineEditors();

  // First load after login: flash every editable region once, then fade out.
  // The flag is set by the login form just before it redirects here.
  try {
    if (sessionStorage.getItem('caret:welcome')) {
      sessionStorage.removeItem('caret:welcome');
      revealAndFade(2500);
    }
  } catch (e) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
