import { holdHighlight } from './highlight.js';
import { t } from './i18n.js';

const SEEN_KEY = 'caret:intro:v1';

/** Whether this browser has seen the intro. Blocked storage counts as seen, so it never nags. */
function seen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
}

/**
 * The first time someone signs in to edit in this browser: every editable
 * region stays outlined and one message says how editing works here. "Got it" ends it for
 * good; Tools → How editing works shows it again.
 *
 * @param {{ showToast: import('./toast.js').ToastController, draftMode: boolean }} options
 */
export function createFirstVisit({ showToast, draftMode }) {
  /** @type {HTMLDivElement | null} */
  let open = null;

  function close() {
    holdHighlight(false);
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* shown again next time */ }
    open = null;
  }

  function show() {
    if (open) return;
    holdHighlight(true);
    open = showToast.pending({
      message: t(draftMode ? 'editor.intro.draft' : 'editor.intro.live'),
      actions: [{ label: t('editor.intro.gotIt'), primary: true, onClick: close }],
    });
  }

  return {
    show,
    /**
     * Show it right after signing in through the sign-in form, unless this
     * browser has seen it. That is the moment a new editor arrives; a page
     * opened any other way stays quiet.
     */
    showOnce() {
      let signedIn = false;
      try { signedIn = sessionStorage.getItem('caret:welcome') === '1'; } catch { /* no flag, no intro */ }
      if (signedIn && !seen()) show();
    },
  };
}
