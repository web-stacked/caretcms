import { STUDIO_PATH } from './config.js';

export function mountStudioPanel({ studioButton }) {
  if (!STUDIO_PATH) {
    studioButton?.setAttribute('hidden', 'hidden');
    studioButton?.setAttribute('aria-hidden', 'true');
    return { iframe: null, closePanel() {} };
  }

  const panel = document.createElement('div');
  panel.className = 'cms-studio-panel';

  const iframe = document.createElement('iframe');
  iframe.src = STUDIO_PATH;
  iframe.title = 'Content Studio';
  panel.appendChild(iframe);
  document.body.appendChild(panel);

  function openPanel(animate = true) {
    if (!animate) {
      panel.classList.add('no-transition');
      document.body.classList.add('no-transition');
    }
    panel.classList.add('open');
    document.body.classList.add('cms-panel-open');
    studioButton?.classList.add('active');
    sessionStorage.setItem('cms-panel-open', '1');
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
    document.body.classList.remove('cms-panel-open');
    studioButton?.classList.remove('active');
    sessionStorage.setItem('cms-panel-open', '0');
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
