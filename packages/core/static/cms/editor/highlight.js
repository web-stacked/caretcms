/**
 * Owns the `cms-highlight-all` body class — the single source of truth for
 * "show every editable region". Two callers share it:
 * - the toolbar "Show editable areas" button, via the persistent toggle
 * - the post-login welcome reveal, via the ephemeral `revealAndFade`
 *
 * Keeping `highlightActive` here (rather than in the toolbar closure) lets the
 * ephemeral reveal defer to an active manual toggle instead of clobbering it.
 *
 * The fade itself is pure CSS: `[data-caret].cms-editable` already transitions
 * its outline, so adding/removing the class animates for free. Motion is
 * suppressed for `prefers-reduced-motion` in toolbar.css, not here.
 */

let highlightActive = false;

/** @param {Element} highlightBtn @param {(message: string, type: 'success' | 'error') => void} showToast */
export function toggleHighlight(highlightBtn, showToast) {
  highlightActive = !highlightActive;
  document.body.classList.toggle('cms-highlight-all', highlightActive);
  highlightBtn.classList.toggle('cms-highlight-btn-active', highlightActive);
  highlightBtn.setAttribute('aria-pressed', String(highlightActive));

  const label = highlightBtn.querySelector('.cms-highlight-label');

  if (highlightActive) {
    if (label) label.textContent = 'Hide editable areas';
    highlightBtn.setAttribute('aria-label', 'Hide editable areas');
    showToast('Editable areas are visible', 'success');
  } else {
    if (label) label.textContent = 'Show editable areas';
    highlightBtn.setAttribute('aria-label', 'Show editable areas');
  }
}

/**
 * One-time reveal: flash every editable region, then fade out after `durationMs`.
 * No-op if the user has already turned highlighting on manually, so it never
 * desyncs the toolbar button's state.
 */
export function revealAndFade(durationMs = 2500) {
  if (highlightActive) return;
  document.body.classList.add('cms-highlight-all');
  setTimeout(() => {
    if (highlightActive) return;
    document.body.classList.remove('cms-highlight-all');
  }, durationMs);
}
