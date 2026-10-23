import { buildCmsUrl, getEditorLoginUrl, isCloudMode } from './config.js';

/**
 * Recovers an editor session that ends mid-edit without leaving the page, so
 * unsaved work stays where it is. Editors sign in again from a dialog (with a
 * password field when the site uses one, otherwise the sign-in page in a new
 * tab); once the session is back, `cms:sessionRestored` fires and anything
 * waiting to save tries again.
 */
export const SESSION_RESTORED_EVENT = 'cms:sessionRestored';

/** @returns {Promise<{ authenticated: boolean, passwordLogin: boolean }>} */
async function readSession() {
  try {
    const response = await fetch(buildCmsUrl('/auth/session'), { credentials: 'same-origin' });
    const body = response.ok ? await response.json() : null;
    return { authenticated: body?.authenticated === true, passwordLogin: body?.passwordLogin === true };
  } catch {
    return { authenticated: false, passwordLogin: false };
  }
}

/** @returns {{ handleExpired: () => void }} */
export function createSessionRecovery() {
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
    if ((await readSession()).authenticated) restored();
  }

  /** @param {boolean} passwordLogin */
  function render(passwordLogin) {
    backdrop = document.createElement('div');
    backdrop.className = 'cms-dialog-backdrop';
    const dialog = document.createElement('form');
    dialog.className = 'cms-dialog cms-reauth-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'cms-reauth-title');
    dialog.setAttribute('aria-describedby', 'cms-reauth-copy');
    dialog.noValidate = true;

    const title = document.createElement('h2');
    title.id = 'cms-reauth-title';
    title.textContent = 'Sign in again';
    const copy = document.createElement('p');
    copy.id = 'cms-reauth-copy';
    copy.textContent = 'Your session ended. Your changes are kept on this page and save once you sign in.';
    dialog.append(title, copy);

    /** @type {HTMLInputElement | null} */
    let password = null;
    const error = document.createElement('p');
    error.className = 'cms-reauth-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    if (passwordLogin) {
      const label = document.createElement('label');
      label.className = 'cms-reauth-label';
      label.textContent = 'Password';
      password = document.createElement('input');
      password.type = 'password';
      password.name = 'password';
      password.autocomplete = 'current-password';
      password.required = true;
      password.className = 'cms-reauth-input';
      label.append(password);
      dialog.append(label, error);
    }

    const actions = document.createElement('div');
    actions.className = 'cms-dialog-actions';
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Not now';
    const elsewhere = document.createElement('a');
    elsewhere.className = 'cms-dialog-link';
    elsewhere.href = getEditorLoginUrl(window.location.href);
    elsewhere.target = '_blank';
    elsewhere.rel = 'noopener';
    elsewhere.textContent = passwordLogin ? 'Use the sign-in page' : 'Open the sign-in page';
    actions.append(later, elsewhere);
    if (passwordLogin) {
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'cms-dialog-primary';
      submit.textContent = 'Sign in';
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
      const response = await fetch(buildCmsUrl('/auth/login'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: password.value, redirect: window.location.pathname }),
      }).catch(() => null);
      if (response?.ok) { restored(); return; }
      const body = response ? await response.json().catch(() => null) : null;
      error.textContent = response?.status === 401 ? "That password isn't right."
        : typeof body?.error === 'string' ? body.error : "Couldn't sign in. Check your connection and try again.";
      error.hidden = false;
      password.select();
    });

    (password ?? elsewhere).focus();
  }

  return {
    handleExpired() {
      // Cloud sign-in happens on the cloud host; keep its existing redirect.
      if (isCloudMode()) { window.location.href = getEditorLoginUrl(window.location.href); return; }
      if (backdrop || opening) return;
      opening = true;
      readSession().then(({ authenticated, passwordLogin }) => {
        opening = false;
        if (authenticated) { window.dispatchEvent(new CustomEvent(SESSION_RESTORED_EVENT)); return; }
        if (!backdrop) render(passwordLogin);
      });
    },
  };
}
