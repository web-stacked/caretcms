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
    return { iframe: null, closePanel() {}, placeOpposite() {} };
  }
  const studioPath = STUDIO_PATH;

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

  const panelHeader = document.createElement('div');
  panelHeader.className = 'cms-studio-panel-header';
  panelHeader.innerHTML =
    '<button type="button" class="cms-panel-back">Back</button>' +
    '<strong class="cms-panel-title">Studio</strong>' +
    '<div class="cms-panel-actions">' +
      '<button type="button" class="cms-panel-move">Move right</button>' +
      '<button type="button" class="cms-panel-expand">Expand</button>' +
      '<button type="button" class="cms-panel-close">Close</button>' +
    '</div>';
  panel.appendChild(panelHeader);

  const backButton = /** @type {HTMLButtonElement} */ (panelHeader.querySelector('.cms-panel-back'));
  const titleElement = /** @type {HTMLElement} */ (panelHeader.querySelector('.cms-panel-title'));
  const moveButton = /** @type {HTMLButtonElement} */ (panelHeader.querySelector('.cms-panel-move'));
  const expandButton = /** @type {HTMLButtonElement} */ (panelHeader.querySelector('.cms-panel-expand'));
  const closeButton = /** @type {HTMLButtonElement} */ (panelHeader.querySelector('.cms-panel-close'));

  // Loading skeleton shown until the iframe reports load — the iframe is blank
  // until then, which reads as "broken".
  const loading = document.createElement('div');
  loading.className = 'cms-studio-panel-loading';
  loading.innerHTML =
    '<span class="cms-studio-panel-spinner" aria-hidden="true"></span>' +
    '<span class="cms-studio-panel-loading-text">Loading Studio…</span>';
  panel.appendChild(loading);

  const iframe = document.createElement('iframe');
  /** @type {'left' | 'right'} */
  let panelSide = readSessionValue('cms-panel-side') === 'right' ? 'right' : 'left';
  let rememberedPath = '';
  const storedPath = readSessionValue('cms-panel-path') || '';
  if (storedPath === studioPath || storedPath.startsWith(`${studioPath}/`)) {
    rememberedPath = storedPath;
  }
  iframe.src = rememberedPath || studioPath;
  iframe.title = 'Content Studio';
  iframe.addEventListener('load', () => {
    loading.setAttribute('hidden', 'hidden');
    try {
      const iframeWindow = iframe.contentWindow;
      if (!iframeWindow) return;
      const currentPath = `${iframeWindow.location.pathname}${iframeWindow.location.search}`;
      if (currentPath === studioPath || currentPath.startsWith(`${studioPath}/`)) {
        writeSessionValue('cms-panel-path', currentPath);
      }
      const documentTitle = iframeWindow.document.title.split(' — ')[0]?.trim();
      titleElement.textContent = documentTitle || 'Studio';
      backButton.disabled = currentPath === studioPath;
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

  /** @param {'left' | 'right'} side */
  function setPanelSide(side) {
    panelSide = side;
    const onRight = side === 'right';
    panel.classList.toggle('side-right', onRight);
    document.body.classList.toggle('cms-panel-right', onRight);
    moveButton.textContent = onRight ? 'Move left' : 'Move right';
    moveButton.setAttribute('aria-label', onRight ? 'Move Studio panel left' : 'Move Studio panel right');
    writeSessionValue('cms-panel-side', side);
  }

  /** Keep the selected page content beside the drawer without reflowing host layout.
   * @param {Element} element
   */
  function placeOpposite(element) {
    if (!(element instanceof Element) || window.innerWidth <= 768) return;
    const rect = element.getBoundingClientRect();
    setPanelSide(rect.left + rect.width / 2 < window.innerWidth / 2 ? 'right' : 'left');
  }

  setPanelSide(panelSide);

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

  backButton.addEventListener('click', () => {
    try {
      iframe.contentWindow?.history.back();
    } catch {
      iframe.src = studioPath;
    }
  });
  moveButton.addEventListener('click', () => setPanelSide(panelSide === 'left' ? 'right' : 'left'));
  expandButton.addEventListener('click', () => {
    try {
      const href = iframe.contentWindow?.location.href;
      window.location.href = href || studioPath;
    } catch {
      window.location.href = studioPath;
    }
  });
  closeButton.addEventListener('click', closePanel);

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

  return { iframe, closePanel, placeOpposite };
}
