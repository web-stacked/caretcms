import { STUDIO_PATH } from './config.js';

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
  try {
    const storedPath = sessionStorage.getItem('cms-panel-path') || '';
    if (storedPath === STUDIO_PATH || storedPath.startsWith(`${STUDIO_PATH}/`)) {
      rememberedPath = storedPath;
    }
  } catch {
    // Session storage is optional; the Studio root remains a safe fallback.
  }
  iframe.src = rememberedPath || STUDIO_PATH;
  iframe.title = 'Content Studio';
  iframe.addEventListener('load', () => {
    loading.setAttribute('hidden', 'hidden');
    try {
      const currentPath = `${iframe.contentWindow.location.pathname}${iframe.contentWindow.location.search}`;
      if (currentPath === STUDIO_PATH || currentPath.startsWith(`${STUDIO_PATH}/`)) {
        sessionStorage.setItem('cms-panel-path', currentPath);
      }
    } catch {
      // The configured Studio may be cross-origin, in which case its route is
      // intentionally unavailable to the parent page.
    }
  });
  panel.appendChild(iframe);
  document.body.appendChild(panel);

  // Remember what had focus so we can restore it on close.
  let lastFocused = null;

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
    sessionStorage.setItem('cms-panel-open', '1');
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
    sessionStorage.setItem('cms-panel-open', '0');
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
  if (sessionStorage.getItem('cms-panel-open') === '1') {
    openPanel(false);
  }

  // Escape key closes panel (only when no CMS element is focused)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panel.classList.contains('open')) return;
    const focused = document.activeElement;
    if (!focused || !focused.matches('[data-caret]')) {
      closePanel();
    }
  });

  return { iframe, closePanel };
}
