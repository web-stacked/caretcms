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
import { mountLinkFollowAffordances } from './editor/link-follow.js';
import { revealAndFade } from './editor/highlight.js';
import { hydrateStega } from './editor/stega-hydrate.js';

function redirectToEditorLogin() {
  window.location.href = getEditorLoginUrl(window.location.href);
}

function boot() {
  if (normalizePreviewForDelivery()) return;

  const state = {
    dirtyEl: null,
    linkPopupEl: null,
  };

  // Promote stega-tagged (loader-fed) content into data-caret bindings before
  // any scanner runs, so prop/component/loop content is click-to-edit too.
  hydrateStega();

  mountEditorGuards(state);
  mountLinkFollowAffordances();

  const showToast = createToast();

  const { studioButton, mapButton, setStatus } = mountToolbar({
    showToast,
    clearDirty: () => {
      state.dirtyEl = null;
    },
    onLogout: async () => {
      await fetch(buildCmsUrl('/auth/logout'), { method: 'POST' });
      clearCloudSessionToken();
      window.location.href = '/';
    },
  });

  const saveField = createSaveField({
    setStatus,
    onUnauthorized: redirectToEditorLogin,
  });

  const { iframe: studioIframe } = mountStudioPanel({ studioButton });

  mountStudioSync({
    studioIframe,
    state,
    showToast,
    clientLinkify,
  });

  mountContentMap({ mapButton });

  let richToolbarMounted = false;

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
