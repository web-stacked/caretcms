const PREVIEW_COOKIE = 'caret_preview';

/**
 * @typedef {object} PreviewModeOptions
 * @property {() => boolean} isStaticDelivery
 * @property {() => boolean} isPolicyDraftMode
 * @property {Pick<Document, 'cookie'>} documentRef
 * @property {() => void} reload
 */

/**
 * Keep the preview cookie aligned with the active delivery mode.
 *
 * @param {PreviewModeOptions} options
 */
export function createPreviewModeController(options) {
  const { isStaticDelivery, isPolicyDraftMode, documentRef, reload } = options;

  function previewActive() {
    return documentRef.cookie
      .split('; ')
      .some(cookie => cookie === `${PREVIEW_COOKIE}=1`);
  }

  /** Static delivery always drafts, so enable preview before mounting the editor. */
  function ensureStaticPreviewMode() {
    if (!isStaticDelivery() || previewActive()) return false;
    documentRef.cookie = `${PREVIEW_COOKIE}=1; path=/; SameSite=Lax`;
    reload();
    return true;
  }

  function normalizePreviewForDelivery() {
    if (isPolicyDraftMode()) return false;
    if (isStaticDelivery()) return ensureStaticPreviewMode();
    if (!previewActive()) return false;

    documentRef.cookie = `${PREVIEW_COOKIE}=; path=/; Max-Age=0; SameSite=Lax`;
    reload();
    return true;
  }

  return { ensureStaticPreviewMode, normalizePreviewForDelivery };
}
