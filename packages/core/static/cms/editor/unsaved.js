import { SESSION_RESTORED_EVENT } from './session-recovery.js';
import { t } from './i18n.js';

/**
 * @typedef {{
 *   pending: (options: { message: string, actions: { label: string, primary?: boolean, onClick: () => void | Promise<void> }[] }) => HTMLDivElement,
 *   dismiss: (toast: HTMLDivElement) => void,
 * }} PendingToast
 */

// Changes whose last save failed, each with the function that saves it again.
// The change stays on the page (`.cms-unsaved`), and it is retried when the
// browser comes back online, when the session is restored, or from the
// notice's Retry action. Text fields and images share one notice.
/** @type {Map<Element, () => Promise<void>>} */
const unsaved = new Map();
/** @type {HTMLDivElement | null} */
let notice = null;
/** @type {PendingToast | null} */
let toasts = null;

function retryAll() {
  for (const retry of [...unsaved.values()]) void retry();
}

/** @param {PendingToast} showToast */
export function bindUnsavedChanges(showToast) {
  if (toasts) return;
  toasts = showToast;
  window.addEventListener('online', retryAll);
  window.addEventListener(SESSION_RESTORED_EVENT, retryAll);
}

/** @param {Element} el */
export function isUnsaved(el) {
  return unsaved.has(el);
}

/**
 * Keep a change that couldn't be saved. An expired session has its own
 * sign-in dialog, so it shows no notice.
 * @param {Element} el
 * @param {() => Promise<void>} retry
 * @param {{ quiet?: boolean }} [options]
 */
export function markUnsaved(el, retry, { quiet = false } = {}) {
  unsaved.set(el, retry);
  el.classList.add('cms-unsaved');
  if (quiet || !toasts || (notice && document.body.contains(notice))) return;
  notice = toasts.pending({
    message: navigator.onLine ? t('editor.unsaved.kept') : t('editor.unsaved.offline'),
    actions: [{ label: t('editor.unsaved.retry'), primary: true, onClick: retryAll }],
  });
}

/** @param {Element} el */
export function clearUnsaved(el) {
  unsaved.delete(el);
  el.classList.remove('cms-unsaved');
  if (unsaved.size > 0 || !notice || !toasts) return;
  toasts.dismiss(notice);
  notice = null;
}
