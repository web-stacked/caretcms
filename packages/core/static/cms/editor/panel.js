import { STUDIO_PATH } from './config.js';
import { entryRoute, initialPanelRoute, rememberPanelRoute } from './panel-route.js';

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

const FOCUSABLE = 'button:not([disabled]):not([hidden]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** @param {ParentNode} root @returns {HTMLElement[]} */
function focusables(root) {
  return /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(FOCUSABLE)).filter((element) =>
    !element.closest('[hidden], [inert]') && element.getClientRects().length > 0,
  ));
}

/**
 * @param {{
 *   studioButton: Element | null,
 *   toolbar: HTMLElement | null,
 *   toolbarTabStop?: () => HTMLElement | null,
 *   onLayoutChange?: (drawer: { side: 'left' | 'right', width: number } | null) => void,
 *   isStudioDirty?: () => boolean,
 * }} options
 */
export function mountStudioPanel({ studioButton, toolbar, toolbarTabStop = () => null, onLayoutChange, isStudioDirty = () => false }) {
  if (!STUDIO_PATH) {
    studioButton?.setAttribute('hidden', 'hidden');
    studioButton?.setAttribute('aria-hidden', 'true');
    return { iframe: null, closePanel() {}, placeOpposite() {}, openAt() {} };
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
  // Tab from the drawer's last control goes on to the toolbar, and from the
  // toolbar's last back to the drawer, instead of through the page behind it.
  const startGuard = document.createElement('span');
  const endGuard = document.createElement('span');
  for (const guard of [startGuard, endGuard]) {
    guard.className = 'cms-focus-guard';
    guard.tabIndex = 0;
  }
  panel.appendChild(startGuard);
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
  iframe.src = initialPanelRoute();
  iframe.title = 'Content Studio';
  iframe.addEventListener('load', () => {
    loading.setAttribute('hidden', 'hidden');
    try {
      const iframeWindow = iframe.contentWindow;
      if (!iframeWindow) return;
      rememberPanelRoute(`${iframeWindow.location.pathname}${iframeWindow.location.search}`);
      // The Studio keeps its <title> current as the entry's title field changes.
      const showTitle = () => { titleElement.textContent = iframeWindow.document.title.split(' — ')[0]?.trim() || 'Studio'; };
      showTitle();
      const titleNode = iframeWindow.document.querySelector('title');
      if (titleNode) new MutationObserver(showTitle).observe(titleNode, { childList: true, characterData: true, subtree: true });
      backButton.disabled = iframeWindow.location.pathname === studioPath;
      iframeWindow.document.addEventListener('keydown', handleEscape);
      // After navigating inside the drawer, start the next Tab at the new
      // page's heading rather than at the top of the Studio chrome.
      if (panel.classList.contains('open') && document.activeElement === iframe) focusFrameHeading();
    } catch {
      // The configured Studio may be cross-origin, in which case its route is
      // intentionally unavailable to the parent page.
    }
  });
  panel.appendChild(iframe);
  panel.appendChild(endGuard);
  document.body.appendChild(panel);

  /** Focus the Studio page's heading (else its main area), or the frame while it loads. */
  function focusFrameHeading() {
    try {
      const doc = iframe.contentDocument;
      const visible = doc ? Array.from(doc.querySelectorAll('h1, main')).filter((element) => element.getClientRects().length > 0) : [];
      const heading = /** @type {HTMLElement | undefined} */ (visible.find((element) => element.matches('h1')) ?? visible[0]);
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        return;
      }
    } catch {
      // A cross-origin Studio takes focus on its own document.
    }
    iframe.focus({ preventScroll: true });
  }

  function focusDrawerStart() {
    focusables(panelHeader)[0]?.focus();
  }

  function focusDrawerEnd() {
    try {
      const doc = iframe.contentDocument;
      const last = doc ? focusables(doc).at(-1) : null;
      if (last) { last.focus(); return; }
    } catch {
      // A cross-origin Studio keeps its own focus order.
    }
    iframe.focus();
  }

  // The toolbar is a single Tab stop (arrow keys move inside it).
  endGuard.addEventListener('focus', () => (toolbarTabStop() ?? focusables(panelHeader)[0])?.focus());
  startGuard.addEventListener('focus', () => {
    const stop = toolbarTabStop();
    if (stop) stop.focus();
    else focusDrawerEnd();
  });
  toolbar?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !panel.classList.contains('open')) return;
    if (event.target instanceof Element && event.target.closest('.cms-tools-popover')) return;
    event.preventDefault();
    if (event.shiftKey) focusDrawerEnd();
    else focusDrawerStart();
  });

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
    reportLayout();
  }

  function reportLayout() {
    onLayoutChange?.(panel.classList.contains('open') && window.innerWidth > 768
      ? { side: panelSide, width: panel.offsetWidth }
      : null);
  }
  window.addEventListener('resize', reportLayout);

  /** Keep the selected page content beside the drawer without reflowing host layout.
   * @param {Element} element
   */
  function placeOpposite(element) {
    if (!(element instanceof Element) || window.innerWidth <= 768) return;
    const rect = element.getBoundingClientRect();
    setPanelSide(rect.left + rect.width / 2 < window.innerWidth / 2 ? 'right' : 'left');
  }

  setPanelSide(panelSide);

  // Match the drawer chrome to the theme chosen inside the Studio (same origin).
  function syncPanelTheme() {
    let theme = null;
    try { theme = window.localStorage.getItem('caret-studio-theme'); } catch { /* storage blocked */ }
    if (theme === 'light' || theme === 'dark') panel.dataset.theme = theme;
    else delete panel.dataset.theme;
  }
  syncPanelTheme();
  window.addEventListener('storage', (event) => {
    if (event.key === 'caret-studio-theme' || event.key === null) syncPanelTheme();
  });

  // An inline save changes what the drawer's form should show. Reload it now
  // if that can't interrupt anyone (open, untouched, focus on the page), else
  // the next time it's shown.
  let stale = false;

  function framePath() {
    try {
      const location = iframe.contentWindow?.location;
      return location ? `${location.pathname}${location.search}` : '';
    } catch {
      return '';
    }
  }

  /** @param {string} [path] where to land; defaults to where the drawer is */
  function reloadFrame(path) {
    stale = false;
    loading.removeAttribute('hidden');
    try {
      const frameWindow = iframe.contentWindow;
      if (!frameWindow) throw new Error('no frame');
      // Point src at the target first (a same-document move when only the
      // fragment differs), then load it fresh.
      if (path) iframe.src = path;
      frameWindow.location.reload();
    } catch {
      iframe.src = path || iframe.src;
    }
  }

  window.addEventListener('cms:entrySaved', (event) => {
    const detail = /** @type {CustomEvent<{ collection: string, id: string }>} */ (event).detail;
    if (!detail || framePath() !== entryRoute(detail.collection, detail.id) || isStudioDirty()) return;
    if (panel.classList.contains('open') && !panel.contains(document.activeElement)) reloadFrame();
    else stale = true;
  });

  /** @param {boolean} [animate] */
  function openPanel(animate = true) {
    if (stale && !isStudioDirty()) reloadFrame();
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
    reportLayout();
    // Move focus into the drawer so keyboard users aren't left behind the
    // covering panel, at the heading that says what it shows.
    if (animate) focusFrameHeading();
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
    reportLayout();
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

  /** Open the drawer on a Studio route. @param {string} path */
  function openAt(path) {
    rememberPanelRoute(path);
    // Same entry, new fragment: a stale form must load again, not just scroll.
    if (stale && framePath() === path.split('#')[0]) reloadFrame(path);
    else iframe.src = path;
    openPanel();
  }

  return { iframe, closePanel, placeOpposite, openAt };
}
