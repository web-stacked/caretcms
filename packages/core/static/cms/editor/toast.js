const SUCCESS_SVG =
  '<svg class="cms-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const ERROR_SVG =
  '<svg class="cms-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
const WARNING_SVG =
  '<svg class="cms-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

/** @typedef {'success' | 'error' | 'warning'} ToastType */
/** @typedef {{ label: string, primary?: boolean, onClick: () => void | Promise<void> }} ToastAction */
/** @typedef {{ message: string, sticky?: boolean, actions?: ToastAction[], role?: string }} ToastOptions */
/** @typedef {{ message: string, onKeepMine: () => void | Promise<void>, onLoadLatest: () => void | Promise<void>, keepLabel?: string, latestLabel?: string }} ConflictOptions */
/** @typedef {((message: string, type?: 'success' | 'error') => HTMLDivElement) & { conflict: (options: ConflictOptions) => HTMLDivElement }} ToastController */

/** @param {ToastType} type @returns {string} */
function iconFor(type) {
  if (type === 'success') return SUCCESS_SVG;
  if (type === 'warning') return WARNING_SVG;
  return ERROR_SVG;
}

/**
 * Toast controller. Returns a `showToast(message, type)` function with a
 * `.conflict()` method for the two-choice save-conflict prompt.
 *
 * Design notes:
 *  - Toasts stack (a container region) instead of one replacing the next, so a
 *    burst of saves or an error + a later success don't clobber each other.
 *  - Errors and conflict prompts are STICKY and dismissible — a 2.5s auto-hide
 *    would let a failure or a data-loss choice vanish before it's read.
 *  - The message is always set via textContent, never innerHTML, so a
 *    server-provided error string can't inject markup into the editor chrome.
 *  - The container is an aria-live region; errors/conflicts are role="alert".
 */
/** @returns {ToastController} */
export function createToast() {
  /** @type {HTMLDivElement | null} */
  let container = null;
  const dismissed = new WeakSet();

  /** @returns {HTMLDivElement} */
  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.className = 'cms-toast-stack';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    return container;
  }

  /** @param {HTMLDivElement} toast */
  function dismiss(toast) {
    if (dismissed.has(toast)) return;
    dismissed.add(toast);
    toast.classList.add('cms-toast-out');
    setTimeout(() => toast.remove(), 300);
  }

  /** @param {ToastType} type @param {ToastOptions} options @returns {HTMLDivElement} */
  function render(type, { message, sticky, actions, role }) {
    const stack = ensureContainer();

    const toast = document.createElement('div');
    toast.className = `cms-toast cms-toast-${type}`;
    if (role) toast.setAttribute('role', role);
    if (sticky || (actions && actions.length)) toast.classList.add('cms-toast-interactive');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'cms-toast-icon-wrap';
    iconWrap.setAttribute('aria-hidden', 'true');
    iconWrap.innerHTML = iconFor(type); // trusted constant SVG only
    toast.appendChild(iconWrap);

    const msg = document.createElement('span');
    msg.className = 'cms-toast-msg';
    msg.textContent = message; // never innerHTML — message may carry server text
    toast.appendChild(msg);

    if (actions && actions.length) {
      const group = document.createElement('div');
      group.className = 'cms-toast-actions';
      for (const action of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `cms-toast-btn${action.primary ? ' cms-toast-btn-primary' : ''}`;
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
          dismiss(toast);
          Promise.resolve()
            .then(() => action.onClick())
            .catch(() => {
              /* action errors shouldn't break the toast */
            });
        });
        group.appendChild(btn);
      }
      toast.appendChild(group);
    } else if (sticky) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'cms-toast-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', () => dismiss(toast));
      toast.appendChild(close);
    }

    stack.appendChild(toast);
    if (!sticky) setTimeout(() => dismiss(toast), 2500);
    return toast;
  }

  /** @type {ToastController} */
  const showToast = (message, type) => {
    const t = type === 'error' ? 'error' : type || 'success';
    return render(t, {
      message,
      sticky: t === 'error',
      role: t === 'error' ? 'alert' : undefined,
    });
  };

  // Two-choice save-conflict prompt. Sticky so the user's edit is never silently
  // discarded — they explicitly choose to keep theirs or load the latest.
  showToast.conflict = ({
    message,
    onKeepMine,
    onLoadLatest,
    keepLabel = 'Keep mine',
    latestLabel = 'Load latest',
  }) =>
    render('warning', {
      message,
      sticky: true,
      role: 'alert',
      actions: [
        { label: keepLabel, primary: true, onClick: onKeepMine },
        { label: latestLabel, onClick: onLoadLatest },
      ],
    });

  return showToast;
}
