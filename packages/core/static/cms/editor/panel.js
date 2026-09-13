import { STUDIO_PATH } from './config.js';

/** @param {string} key @returns {string | null} */
function readSessionValue(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function writeSessionValue(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Session storage is optional.
  }
}

/** @param {{ studioButton: Element | null }} options */
export function mountStudioPanel({ studioButton }) {
  if (!STUDIO_PATH) {
    studioButton?.setAttribute('hidden', 'hidden');
    studioButton?.setAttribute('aria-hidden', 'true');
    return { iframe: null, closePanel() {} };
  }

  const panel = document.createElement('div');
  panel.className = 'cms-studio-panel';
  // A dialog-like region so AT users understand the drawer context.
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Content Studio');
  panel.setAttribute('aria-hidden', 'true');
  panel.id = 'cms-studio-panel';
  studioButton?.setAttribute('aria-controls', panel.id);
  studioButton?.setAttribute('aria-haspopup', 'dialog');
  studioButton?.setAttribute('aria-expanded', 'false');

  // Loading skeleton shown until the iframe reports load — the iframe is blank
  // until then, which reads as "broken".
  const loading = document.createElement('div');
  loading.className = 'cms-studio-panel-loading';
  loading.innerHTML =
    '<span class="cms-studio-panel-spinner" aria-hidden="true"></span>' +
    '<span class="cms-studio-panel-loading-text">Loading Studio…</span>';
  panel.appendChild(loading);

  const iframe = document.createElement('iframe');
  let rememberedPath = '';
  const storedPath = readSessionValue('cms-panel-path') || '';
  if (storedPath === STUDIO_PATH || storedPath.startsWith(`${STUDIO_PATH}/`)) {
    rememberedPath = storedPath;
  }
  iframe.src = rememberedPath || STUDIO_PATH;
  iframe.title = 'Content Studio';
  iframe.addEventListener('load', () => {
    loading.setAttribute('hidden', 'hidden');
    try {
      const iframeWindow = iframe.contentWindow;
      if (!iframeWindow) return;
      const currentPath = `${iframeWindow.location.pathname}${iframeWindow.location.search}`;
      if (currentPath === STUDIO_PATH || currentPath.startsWith(`${STUDIO_PATH}/`)) {
        writeSessionValue('cms-panel-path', currentPath);
      }
      iframeWindow.document.addEventListener('keydown', handleEscape);
    } catch {
      // The configured Studio may be cross-origin, in which case its route is
      // intentionally unavailable to the parent page.
    }
  });
  panel.appendChild(iframe);
  document.body.appendChild(panel);

  // Remember what had focus so we can restore it on close.
  /** @type {HTMLElement | null} */
  let lastFocused = null;

  /** @param {boolean} [animate] */
  function openPanel(animate = true) {
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!animate) {
      panel.classList.add('no-transition');
      document.body.classList.add('no-transition');
    }
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('cms-panel-open');
    studioButton?.classList.add('active');
    studioButton?.setAttribute('aria-expanded', 'true');
    writeSessionValue('cms-panel-open', '1');
    // Move focus into the drawer so keyboard users aren't left behind the
    // covering panel. The iframe is focusable and hands focus to its own content.
    if (animate) {
      try {
        iframe.focus({ preventScroll: true });
      } catch (e) {}
    }
    if (!animate) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          panel.classList.remove('no-transition');
          document.body.classList.remove('no-transition');
        });
      });
    }
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('cms-panel-open');
    studioButton?.classList.remove('active');
    studioButton?.setAttribute('aria-expanded', 'false');
    writeSessionValue('cms-panel-open', '0');
    // Return focus to the trigger (or wherever it was) so it isn't lost.
    const restore = lastFocused || studioButton;
    if (restore instanceof HTMLElement) {
      try {
        restore.focus({ preventScroll: true });
      } catch (e) {}
    }
    lastFocused = null;
  }

  function togglePanel() {
    if (panel.classList.contains('open')) {
      closePanel();
    } else {
      openPanel();
    }
  }

  studioButton?.addEventListener('click', togglePanel);

  // Restore panel state from sessionStorage (without animation)
  if (readSessionValue('cms-panel-open') === '1') {
    openPanel(false);
  }

  /** @param {KeyboardEvent} e */
  function handleEscape(e) {
    if (e.key !== 'Escape' || !panel.classList.contains('open')) return;
    const focused = document.activeElement;
    if (!focused || !focused.matches('[data-caret]')) {
      closePanel();
    }
  }

  // Listen in both the page and same-origin Studio document. Keyboard events
  // do not cross an iframe boundary after focus moves into the Studio.
  document.addEventListener('keydown', handleEscape);

  return { iframe, closePanel };
}
