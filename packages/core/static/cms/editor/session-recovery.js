import { buildCmsUrl, getEditorLoginUrl, isCloudMode } from './config.js';
import { t } from './i18n.js';

/**
 * Recovers an editor session that ends mid-edit without leaving the page, so
 * unsaved work stays where it is. Editors sign in again from a dialog (with a
 * password field when the site uses one, otherwise the sign-in page in a new
 * tab); once the session is back, `cms:sessionRestored` fires and anything
 * waiting to save tries again.
 */
export const SESSION_RESTORED_EVENT = 'cms:sessionRestored';

/**
 * Class names for the dialog's parts, so the page editor and the Studio each
 * draw it in their own style.
 * @typedef {{ backdrop: string, dialog: string, label: string, input: string, error: string, actions: string, secondary: string, link: string, primary: string }} DialogLook
 */

/** @type {DialogLook} */
const EDITOR_LOOK = {
  backdrop: 'cms-dialog-backdrop',
  dialog: 'cms-dialog cms-reauth-dialog',
  label: 'cms-reauth-label',
  input: 'cms-reauth-input',
  error: 'cms-reauth-error',
  actions: 'cms-dialog-actions',
  secondary: '',
  link: 'cms-dialog-link',
  primary: 'cms-dialog-primary',
};

/** @param {(path: string) => string} cmsUrl @returns {Promise<{ authenticated: boolean, passwordLogin: boolean }>} */
async function readSession(cmsUrl) {
  try {
    const response = await fetch(cmsUrl('/auth/session'), { credentials: 'same-origin' });
    const body = response.ok ? await response.json() : null;
    return { authenticated: body?.authenticated === true, passwordLogin: body?.passwordLogin === true };
  } catch {
    return { authenticated: false, passwordLogin: false };
  }
}

/**
 * The defaults are the page editor's; the Studio passes its own paths and look.
 * Its words come from the editor's messages in the site's locale.
 * @param {object} [options]
 * @param {(path: string) => string} [options.cmsUrl]
 * @param {(returnTo: string) => string} [options.loginUrl]
 * @param {boolean} [options.redirectOnly] sign in only on the sign-in page (cloud mode)
 * @param {DialogLook} [options.look]
 * @param {'page' | 'studio'} [options.surface] where the unsaved changes are kept
 * @returns {{ handleExpired: () => void }}
 */
export function createSessionRecovery({
  cmsUrl = buildCmsUrl,
  loginUrl = getEditorLoginUrl,
  redirectOnly = isCloudMode(),
  look = EDITOR_LOOK,
  surface = 'page',
} = {}) {
  /** @type {HTMLElement | null} */
  let backdrop = null;
  let opening = false;

  function restored() {
    close();
    window.dispatchEvent(new CustomEvent(SESSION_RESTORED_EVENT));
  }

  function close() {
    backdrop?.remove();
    backdrop = null;
    window.removeEventListener('focus', checkAfterSignInElsewhere);
  }

  // Signing in from the sign-in page in another tab sets the same cookie.
  async function checkAfterSignInElsewhere() {
    if ((await readSession(cmsUrl)).authenticated) restored();
  }

  /** @param {boolean} passwordLogin */
  function render(passwordLogin) {
    backdrop = document.createElement('div');
    backdrop.className = look.backdrop;
    const dialog = document.createElement('form');
    dialog.className = look.dialog;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'cms-reauth-title');
    dialog.setAttribute('aria-describedby', 'cms-reauth-copy');
    dialog.noValidate = true;

    const title = document.createElement('h2');
    title.id = 'cms-reauth-title';
    title.textContent = t('editor.session.title');
    const copy = document.createElement('p');
    copy.id = 'cms-reauth-copy';
    copy.textContent = surface === 'studio' ? t('editor.session.copy') : t('editor.session.copyPage');
    dialog.append(title, copy);

    /** @type {HTMLInputElement | null} */
    let password = null;
    const error = document.createElement('p');
    error.className = look.error;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    if (passwordLogin) {
      const label = document.createElement('label');
      label.className = look.label;
      label.textContent = t('editor.session.password');
      password = document.createElement('input');
      password.type = 'password';
      password.name = 'password';
      password.autocomplete = 'current-password';
      password.required = true;
      password.className = look.input;
      label.append(password);
      dialog.append(label, error);
    }

    const actions = document.createElement('div');
    actions.className = look.actions;
    const later = document.createElement('button');
    later.type = 'button';
    if (look.secondary) later.className = look.secondary;
    later.textContent = t('editor.session.later');
    const elsewhere = document.createElement('a');
    elsewhere.className = look.link;
    elsewhere.href = loginUrl(window.location.href);
    elsewhere.target = '_blank';
    elsewhere.rel = 'noopener';
    elsewhere.textContent = passwordLogin ? t('editor.session.signInPage') : t('editor.session.openSignInPage');
    actions.append(later, elsewhere);
    if (passwordLogin) {
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = look.primary;
      submit.textContent = t('editor.session.signIn');
      actions.append(submit);
    }
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    later.addEventListener('click', close);
    elsewhere.addEventListener('click', () => window.addEventListener('focus', checkAfterSignInElsewhere));
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('input, button, a[href]')]);
      const index = controls.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
      event.preventDefault();
      controls[next].focus();
    });
    dialog.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!password?.value) { password?.focus(); return; }
      error.hidden = true;
      const response = await fetch(cmsUrl('/auth/login'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: password.value, redirect: window.location.pathname }),
      }).catch(() => null);
      if (response?.ok) { restored(); return; }
      const body = response ? await response.json().catch(() => null) : null;
      error.textContent = response?.status === 401 ? t('editor.session.wrongPassword')
        : typeof body?.error === 'string' ? body.error : t('editor.session.failed');
      error.hidden = false;
      password.select();
    });

    (password ?? elsewhere).focus();
  }

  return {
    handleExpired() {
      // Cloud sign-in happens on the cloud host; keep its existing redirect.
      if (redirectOnly) { window.location.href = loginUrl(window.location.href); return; }
      if (backdrop || opening) return;
      opening = true;
      readSession(cmsUrl).then(({ authenticated, passwordLogin }) => {
        opening = false;
        if (authenticated) { window.dispatchEvent(new CustomEvent(SESSION_RESTORED_EVENT)); return; }
        if (!backdrop) render(passwordLogin);
      });
    },
  };
}
