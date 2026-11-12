import { t } from './i18n.js';

const SUCCESS_SVG =
  '<svg class="cms-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const ERROR_SVG =
  '<svg class="cms-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
const WARNING_SVG =
  '<svg class="cms-toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

/** @typedef {'success' | 'error' | 'warning'} ToastType */
/** @typedef {{ label: string, primary?: boolean, onClick: () => void | Promise<void> }} ToastAction */
/** @typedef {{ message: string, sticky?: boolean, actions?: ToastAction[], role?: string, inline?: boolean, duration?: number }} ToastOptions */
/** @typedef {{ message: string, action?: ToastAction }} SavedOptions */
/** @typedef {{ message: string, onKeepMine: () => void | Promise<void>, onLoadLatest: () => void | Promise<void>, keepLabel?: string, latestLabel?: string }} ConflictOptions */
/** @typedef {{ message: string, actions: ToastAction[] }} PendingOptions */
/**
 * @typedef {((message: string, type?: 'success' | 'error') => HTMLDivElement) & {
 *   conflict: (options: ConflictOptions) => HTMLDivElement,
 *   pending: (options: PendingOptions) => HTMLDivElement,
 *   saved: (options: SavedOptions) => HTMLDivElement,
 *   onProblem?: (message: string) => void,
 *   dismiss: (toast: HTMLDivElement) => void,
 * }} ToastController
 */

/** Space between the toolbar and the newest toast, and between a toast and the viewport's edge. */
const GAP = 10;
const EDGE = 12;
/** How long a toast lingers after the pointer leaves it. */
const GRACE_MS = 1200;

/** @param {ToastType} type @returns {string} */
function iconFor(type) {
  if (type === 'success') return SUCCESS_SVG;
  if (type === 'warning') return WARNING_SVG;
  return ERROR_SVG;
}

/**
 * Toast controller. Returns a `showToast(message, type)` function with a
 * `.conflict()` method for the two-choice save-conflict prompt, `.pending()`
 * for work that is kept but not yet saved, and `.dismiss()`.
 *
 * Design notes:
 *  - Toasts rise from the toolbar: the stack is centred on it and follows it.
 *  - Toasts stack (a container region) instead of one replacing the next, so a
 *    burst of saves or an error + a later success don't clobber each other.
 *  - Conflict prompts and pending-work notices are STICKY — a data-loss choice
 *    must not vanish unread. Errors stay 10s with a close button and are kept
 *    in the status pill's panel, so they don't pile up over the toolbar.
 *  - The message is always set via textContent, never innerHTML, so a
 *    server-provided error string can't inject markup into the editor chrome.
 *  - The container is an aria-live region; errors/conflicts are role="alert".
 */
/** @returns {ToastController} */
export function createToast() {
  /** @type {HTMLDivElement | null} */
  let container = null;
  const dismissed = new WeakSet();

  let frame = 0;

  /**
   * Centre the stack on the toolbar, just above it. The toolbar sits above
   * Astro's dev toolbar and moves aside for the Studio drawer, so its place
   * is read rather than assumed.
   */
  function place() {
    if (!container) return;
    const bar = document.querySelector('.cms-toolbar');
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const half = container.offsetWidth / 2;
    const viewport = document.documentElement.clientWidth;
    const centre = Math.min(Math.max(rect.left + rect.width / 2, half + EDGE), Math.max(half + EDGE, viewport - half - EDGE));
    container.style.left = `${Math.round(centre)}px`;
    container.style.bottom = `${Math.max(16, Math.round(window.innerHeight - rect.top + GAP))}px`;
  }

  /** Keep the stack on the toolbar for as long as a toast is showing. */
  function follow() {
    if (frame) return;
    const tick = () => {
      if (!container || !container.childElementCount) {
        frame = 0;
        return;
      }
      place();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  /** @returns {HTMLDivElement} */
  function ensureContainer() {
    if (!container || !document.body.contains(container)) {
      container = document.createElement('div');
      container.className = 'cms-toast-stack';
      container.setAttribute('aria-live', 'polite');
      document.body.appendChild(container);
    }
    return container;
  }

  /** @param {HTMLDivElement} toast */
  function dismiss(toast) {
    if (dismissed.has(toast)) return;
    dismissed.add(toast);
    toast.classList.add('cms-toast-out');
    setTimeout(() => toast.remove(), 300);
  }

  /**
   * Close a toast after `duration`, but not while the pointer is on it: someone
   * reaching for Undo shouldn't lose it. Leaving gives a short grace period.
   * @param {HTMLDivElement} toast @param {number} duration
   */
  function autoDismiss(toast, duration) {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer = setTimeout(() => dismiss(toast), duration);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => {
      timer = setTimeout(() => dismiss(toast), GRACE_MS);
    });
  }

  /** @param {ToastType} type @param {ToastOptions} options @returns {HTMLDivElement} */
  function render(type, { message, sticky, actions, role, inline, duration = 2500 }) {
    const stack = ensureContainer();

    const toast = document.createElement('div');
    toast.className = `cms-toast cms-toast-${type}`;
    if (role) toast.setAttribute('role', role);
    if (sticky || (actions && actions.length)) toast.classList.add('cms-toast-interactive');
    if (inline) toast.classList.add('cms-toast-inline');

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
    } else if (sticky || type === 'error') {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'cms-toast-close';
      close.setAttribute('aria-label', t('editor.toast.dismiss'));
      close.textContent = '×';
      close.addEventListener('click', () => dismiss(toast));
      toast.appendChild(close);
    }

    stack.appendChild(toast);
    place();
    follow();
    if (!sticky) autoDismiss(toast, duration);
    return toast;
  }

  // Errors close on their own after a while instead of piling up; the last
  // one stays listed in the status pill's panel (`onProblem`).
  /** @type {ToastController} */
  const showToast = (message, type) => {
    const kind = type === 'error' ? 'error' : type || 'success';
    if (kind === 'error') showToast.onProblem?.(message);
    // A new confirmation is about newer work; the earlier "Saved" is stale.
    if (kind === 'success' && savedToast) dismiss(savedToast);
    return render(kind, {
      message,
      role: kind === 'error' ? 'alert' : undefined,
      duration: kind === 'error' ? 10000 : 2500,
    });
  };

  // Two-choice save-conflict prompt. Sticky so the user's edit is never silently
  // discarded — they explicitly choose to keep theirs or load the latest.
  showToast.conflict = ({
    message,
    onKeepMine,
    onLoadLatest,
    keepLabel = t('editor.toast.keepMine'),
    latestLabel = t('editor.toast.loadLatest'),
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

  // Work that is kept but not saved yet (offline, server error). Sticky and a
  // warning rather than an error: nothing is lost, and the caller retries.
  showToast.pending = ({ message, actions }) =>
    render('warning', { message, sticky: true, role: 'alert', actions });

  // A finished save, usually with Undo. One at a time, and long enough to
  // reach the button.
  /** @type {HTMLDivElement | null} */
  let savedToast = null;
  showToast.saved = ({ message, action }) => {
    if (savedToast) dismiss(savedToast);
    savedToast = render('success', { message, actions: action ? [action] : undefined, inline: true, duration: 3500 });
    return savedToast;
  };

  showToast.dismiss = dismiss;

  return showToast;
}
