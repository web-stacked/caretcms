/**
 * Keyboard access to the editor toolbar, following the ARIA toolbar pattern:
 * the bar is one Tab stop, arrow keys (and Home/End) move between its
 * controls, and it remembers the last control used. A skip link at the start
 * of the page jumps straight to it, so it isn't the last thing Tab reaches.
 */

/** Top-level controls only; the Tools menu's items belong to its own popover. */
const CONTROLS = 'button, summary';
const POPOVER = '.cms-tools-popover';

/** @param {HTMLElement} bar */
function controlsOf(bar) {
  return /** @type {HTMLElement[]} */ (Array.from(bar.querySelectorAll(CONTROLS))).filter((control) =>
    !control.closest(POPOVER)
    && !control.closest('[hidden]')
    && !(control instanceof HTMLButtonElement && control.disabled)
    && control.getClientRects().length > 0,
  );
}

/**
 * @param {HTMLElement} bar the element with role="toolbar"
 * @param {{ skipLabel: string }} options
 */
export function mountToolbarKeys(bar, { skipLabel }) {
  /** @type {HTMLElement | null} */
  let current = null;

  /** Make exactly one control tabbable: the current one, else the first. */
  function settle() {
    const controls = controlsOf(bar);
    if (!current || !controls.includes(current)) current = controls[0] ?? null;
    bar.querySelectorAll(CONTROLS).forEach((control) => {
      if (control.closest(POPOVER)) return;
      /** @type {HTMLElement} */ (control).tabIndex = control === current ? 0 : -1;
    });
  }

  bar.addEventListener('focusin', (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest(CONTROLS) : null;
    if (target instanceof HTMLElement && !target.closest(POPOVER) && bar.contains(target)) {
      current = target;
      settle();
    }
  });

  bar.addEventListener('keydown', (event) => {
    if (!(event.target instanceof HTMLElement) || event.target.closest(POPOVER)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const controls = controlsOf(bar);
    const index = current ? controls.indexOf(current) : -1;
    /** @type {number | null} */
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % controls.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + controls.length) % controls.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = controls.length - 1;
    if (next === null || !controls[next]) return;
    event.preventDefault();
    controls[next].focus();
  });

  // Controls appear and disappear (Publish, Retry deploy); keep one tabbable.
  new MutationObserver(settle).observe(bar, { subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
  settle();

  const skip = document.createElement('a');
  skip.className = 'cms-skip-link';
  skip.href = '#';
  skip.textContent = skipLabel;
  skip.addEventListener('click', (event) => {
    event.preventDefault();
    settle();
    current?.focus();
  });
  document.body.prepend(skip);

  return {
    /** The control Tab lands on in the bar. */
    tabStop() {
      settle();
      return current;
    },
  };
}
