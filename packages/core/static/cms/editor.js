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
import { buildCmsUrl, clearCloudSessionToken, getEditorLoginUrl } from './editor/config.js';
import { parseCaretAttr, flash } from './editor/helpers.js';
import { clientLinkify } from './editor/linkify.js';
import { createSaveField } from './editor/save-queue.js';
import { compressImage, updateEmblaCarousel } from './editor/image-utils.js';
import { createToast } from './editor/toast.js';
import { mountEditorGuards } from './editor/guards.js';
import { mountToolbar, normalizePreviewForDelivery } from './editor/toolbar.js';
import { mountStudioPanel } from './editor/panel.js';
import { mountStudioSync } from './editor/sync.js';
import { mountTextEditors } from './editor/text-edit.js';
import { mountImageEditors } from './editor/image-edit.js';
import { mountSectionControls } from './editor/section-controls.js';
import { mountContentMap } from './editor/content-map.js';
import { mountRichToolbar } from './editor/rich-toolbar.js';
import { mountMdBlockEditors } from './editor/md-block-edit.js';
import { mountLinkFollowAffordances } from './editor/link-follow.js';
import { revealAndFade } from './editor/highlight.js';
import { hydrateStega } from './editor/stega-hydrate.js';

function redirectToEditorLogin() {
  window.location.href = getEditorLoginUrl(window.location.href);
}

function boot() {
  if (normalizePreviewForDelivery()) return;

  /** @type {{ dirtyEls: Set<Element>, linkPopupEl: HTMLElement | null }} */
  const state = {
    // Every element with unsaved edits. A Set (not a single element) so a save
    // completing on field A can't clear the dirty flag for field B the user has
    // since moved to — that would let the beforeunload guard miss B's edits.
    dirtyEls: new Set(),
    linkPopupEl: null,
  };

  // Promote stega-tagged (loader-fed) content into data-caret bindings before
  // any scanner runs, so prop/component/loop content is click-to-edit too.
  hydrateStega();

  mountEditorGuards(state);
  mountLinkFollowAffordances();

  const showToast = createToast();

  const { studioButton, mapButton, editModeButton, previewModeButton, setStatus } = mountToolbar({
    showToast,
    clearDirty: () => {
      state.dirtyEls.clear();
    },
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

  const saveField = createSaveField({
    setStatus,
    onUnauthorized: redirectToEditorLogin,
  });

  const { iframe: studioIframe, placeOpposite } = mountStudioPanel({ studioButton });

  mountStudioSync({
    studioIframe,
    state,
    showToast,
    clientLinkify,
    onInlineSelection: placeOpposite,
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
      onUnauthorized: redirectToEditorLogin,
    });

    mountImageEditors({
      parseCaretAttr,
      flash,
      compressImage,
      updateEmblaCarousel,
      saveField,
      setStatus,
      showToast,
      onUnauthorized: redirectToEditorLogin,
    });
    applyPageMode();
  };

  mountSectionControls({
    parseCaretAttr,
    setStatus,
    showToast,
    onUnauthorized: redirectToEditorLogin,
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
