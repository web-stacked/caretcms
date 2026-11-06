import { STUDIO_PATH } from './config.js';
import { t, tHtml } from './i18n.js';
import { entryRoute, initialPanelRoute, isStudioRoute, rememberPanelRoute } from './panel-route.js';

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

// A Studio link opened in a tab of its own arrives here as this fragment
// (see studioOverSite on the server) and opens over the page, expanded.
const HANDOFF = '#caret-studio=';

/** The Studio route handed to this page, removed from the address. @returns {string | null} */
function takeHandoff() {
  if (!window.location.hash.startsWith(HANDOFF)) return null;
  let route = '';
  try { route = decodeURIComponent(window.location.hash.slice(HANDOFF.length)); } catch { /* malformed */ }
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
  return isStudioRoute(route) ? route : null;
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
  panel.setAttribute('aria-label', t('editor.panel.label'));
  panel.setAttribute('aria-hidden', 'true');
  panel.id = 'cms-studio-panel';
  studioButton?.setAttribute('aria-controls', panel.id);
  studioButton?.setAttribute('aria-haspopup', 'dialog');
  studioButton?.setAttribute('aria-expanded', 'false');

  const panelHeader = document.createElement('div');
  panelHeader.className = 'cms-studio-panel-header';
  panelHeader.innerHTML =
    `<button type="button" class="cms-panel-back">${tHtml('editor.panel.back')}</button>` +
    `<strong class="cms-panel-title">${tHtml('editor.panel.title')}</strong>` +
    '<div class="cms-panel-actions">' +
      `<button type="button" class="cms-panel-move">${tHtml('editor.panel.moveRight')}</button>` +
      `<button type="button" class="cms-panel-expand">${tHtml('editor.panel.expand')}</button>` +
      `<button type="button" class="cms-panel-close">${tHtml('editor.panel.close')}</button>` +
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
    `<span class="cms-studio-panel-loading-text">${tHtml('editor.panel.loading')}</span>`;
  panel.appendChild(loading);

  const iframe = document.createElement('iframe');
  /** @type {'left' | 'right'} */
  let panelSide = readSessionValue('cms-panel-side') === 'right' ? 'right' : 'left';
  const handoff = takeHandoff();
  if (handoff) rememberPanelRoute(handoff);
  iframe.src = handoff ?? initialPanelRoute();
  iframe.title = t('editor.panel.label');
  // The Studio pages this drawer has shown, so Back steps through the drawer's
  // own pages: the frame shares the tab's history, and at the drawer's first
  // page history.back() would leave the site.
  /** @type {string[]} */
  const visited = [];
  iframe.addEventListener('load', () => {
    loading.setAttribute('hidden', 'hidden');
    try {
      const iframeWindow = iframe.contentWindow;
      if (!iframeWindow) return;
      const here = `${iframeWindow.location.pathname}${iframeWindow.location.search}`;
      if (visited.at(-2) === here) visited.pop();
      else if (visited.at(-1) !== here) visited.push(here);
      rememberPanelRoute(here);
      // The Studio keeps its <title> current as the entry's title field changes.
      const showTitle = () => { titleElement.textContent = iframeWindow.document.title.split(' — ')[0]?.trim() || t('editor.panel.title'); };
      showTitle();
      const titleNode = iframeWindow.document.querySelector('title');
      if (titleNode) new MutationObserver(showTitle).observe(titleNode, { childList: true, characterData: true, subtree: true });
      backButton.disabled = visited.length < 2 && iframeWindow.location.pathname === studioPath;
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

  // The toolbar is a single Tab stop (arrow keys move inside it). It's hidden
  // while the Studio is expanded, so Tab then stays in the Studio.
  const tabStop = () => (panel.classList.contains('expanded') ? null : toolbarTabStop());
  endGuard.addEventListener('focus', () => (tabStop() ?? focusables(panelHeader)[0])?.focus());
  startGuard.addEventListener('focus', () => {
    const stop = tabStop();
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
    moveButton.textContent = onRight ? t('editor.panel.moveLeft') : t('editor.panel.moveRight');
    moveButton.setAttribute('aria-label', onRight ? t('editor.panel.moveLeftLabel') : t('editor.panel.moveRightLabel'));
    writeSessionValue('cms-panel-side', side);
    updatePush();
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

  // Fixed bars (headers, nav and cookie bars) don't move with the padding
  // push, so the drawer would cover their start. While it pushes, each one is
  // moved into the space beside the drawer with inline styles; its own inline
  // values are kept and put back exactly when the push ends.
  const SHIFTED_PROPS = ['left', 'right', 'width', 'transform'];
  /** @type {Map<HTMLElement, Record<string, [string, string]>>} */
  const shiftedBars = new Map();
  /** Shifted bars that had no style attribute of their own. @type {Set<HTMLElement>} */
  const bareBars = new Set();

  function restoreFixedBars() {
    for (const [el, saved] of shiftedBars) {
      for (const [prop, [value, priority]] of Object.entries(saved)) {
        if (value) el.style.setProperty(prop, value, priority);
        else el.style.removeProperty(prop);
      }
      if (!bareBars.has(el) || el.style.length) continue;
      // Reading the attribute first settles the browser's lazily written
      // inline style, which would otherwise come back as style="".
      el.getAttribute('style');
      el.removeAttribute('style');
    }
    shiftedBars.clear();
    bareBars.clear();
  }

  /** Visible fixed elements across most of the width, at the top or bottom edge. */
  function findFixedBars() {
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = window.innerHeight;
    /** @type {HTMLElement[]} */
    const bars = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const el = /** @type {HTMLElement} */ (node);
        // CaretCMS's own UI sits in body-level `cms-*` containers.
        if (el.parentElement === document.body && [...el.classList].some((name) => name.startsWith('cms-')) && !el.hasAttribute('data-caret')) {
          return NodeFilter.FILTER_REJECT;
        }
        const style = getComputedStyle(el);
        if (style.display === 'none') return NodeFilter.FILTER_REJECT;
        if (style.position !== 'fixed') return NodeFilter.FILTER_SKIP;
        const rect = el.getBoundingClientRect();
        const atEdge = rect.top <= 4 || rect.bottom >= viewHeight - 4;
        const bar = style.visibility !== 'hidden' && rect.height > 0 && rect.height < viewHeight / 2 &&
          rect.width >= viewWidth * 0.6 && atEdge;
        if (bar) bars.push(el);
        // A fixed element's descendants move with it.
        return NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) { /* collected in acceptNode */ }
    return bars;
  }

  function shiftFixedBars() {
    restoreFixedBars();
    const viewWidth = document.documentElement.clientWidth;
    // The drawer's own width while pushing (not the width it animates from).
    const drawer = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cms-panel-width')) || 380;
    const room = viewWidth - drawer;
    if (room <= 0) return;
    const scale = room / viewWidth;
    const offset = panelSide === 'right' ? 0 : drawer;
    for (const el of findFixedBars()) {
      const rect = el.getBoundingClientRect();
      /** @type {Record<string, [string, string]>} */
      const saved = {};
      for (const prop of SHIFTED_PROPS) saved[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
      shiftedBars.set(el, saved);
      if (!el.hasAttribute('style')) bareBars.add(el);
      // The bar keeps its place and share of the width, now within the room
      // beside the drawer. A sideways translate (centering) is folded in.
      const transform = getComputedStyle(el).transform;
      const translate = /^matrix\(1, 0, 0, 1, (-?[\d.e-]+), (-?[\d.e-]+)\)$/.exec(transform);
      if (translate && Number(translate[1]) !== 0) el.style.setProperty('transform', `translateY(${translate[2]}px)`, 'important');
      el.style.setProperty('left', `${offset + rect.left * scale}px`, 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('width', `${rect.width * scale}px`, 'important');
    }
  }

  /** @type {number | undefined} */
  let barsFrame;
  window.addEventListener('resize', () => {
    if (barsFrame !== undefined) cancelAnimationFrame(barsFrame);
    barsFrame = requestAnimationFrame(() => {
      barsFrame = undefined;
      updatePush();
    });
  });

  setPanelSide(panelSide);

  // The drawer pushes the page aside; expanded, or on a site that opts out
  // with `caret-studio-overlay`, it covers the page instead.
  document.documentElement.classList.add('cms-studio-pushable');
  function updatePush() {
    const root = document.documentElement;
    const optedOut = root.classList.contains('caret-studio-overlay') || document.body.classList.contains('caret-studio-overlay');
    const pushing = panel.classList.contains('open') && !panel.classList.contains('expanded') && !optedOut;
    root.classList.toggle('cms-studio-push', pushing);
    root.classList.toggle('cms-studio-push-right', panelSide === 'right');
    if (pushing && window.innerWidth > 768) shiftFixedBars();
    else restoreFixedBars();
  }

  // Expanded, the Studio covers two thirds of the page and the live page stays
  // beside it; the drawer and the page underneath are the same either way.
  /** @param {boolean} expanded */
  function setExpanded(expanded) {
    panel.classList.toggle('expanded', expanded);
    document.body.classList.toggle('cms-panel-expanded', expanded);
    expandButton.textContent = expanded ? t('editor.panel.shrink') : t('editor.panel.expand');
    expandButton.setAttribute('aria-label', expanded ? t('editor.panel.shrinkLabel') : t('editor.panel.expandLabel'));
    expandButton.setAttribute('aria-pressed', String(expanded));
    writeSessionValue('cms-panel-size', expanded ? 'expanded' : 'drawer');
    updatePush();
    reportLayout();
  }
  setExpanded(Boolean(handoff) || readSessionValue('cms-panel-size') === 'expanded');
  panel.addEventListener('transitionend', (event) => {
    if (event.target === panel && event.propertyName === 'width') reportLayout();
  });

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
      document.documentElement.classList.add('no-transition');
    }
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('cms-panel-open');
    updatePush();
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
          document.documentElement.classList.remove('no-transition');
        });
      });
    }
  }

  function closePanel() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('cms-panel-open');
    updatePush();
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
    // Within the drawer's own pages, step back; from its first page, go to
    // the Studio home rather than out of the site.
    if (visited.length > 1) {
      try {
        iframe.contentWindow?.history.back();
        return;
      } catch {
        // A cross-origin Studio: fall through to its home.
      }
    }
    visited.length = 0;
    iframe.src = studioPath;
  });
  moveButton.addEventListener('click', () => setPanelSide(panelSide === 'left' ? 'right' : 'left'));
  expandButton.addEventListener('click', () => setExpanded(!panel.classList.contains('expanded')));
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
  if (handoff || readSessionValue('cms-panel-open') === '1') {
    openPanel(false);
    // Opened from a Studio address, the Studio is what the editor came for:
    // keyboard focus starts in it, not on the page it covers.
    if (handoff) focusFrameHeading();
  }

  // The Studio asks to close (its View site) or to show an entry's page,
  // keeping itself open on the same route over that page.
  window.addEventListener('message', (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'cms:close-studio') {
      closePanel();
      return;
    }
    if (data.type === 'cms:show-page' && typeof data.path === 'string' && data.path.startsWith('/') && !data.path.startsWith('//')) {
      const target = new URL(data.path, window.location.origin);
      if (target.pathname === window.location.pathname) return;
      const route = framePath();
      if (route) rememberPanelRoute(route, target.pathname);
      writeSessionValue('cms-panel-open', '1');
      window.location.href = `${target.pathname}${target.search}${target.hash}`;
    }
  });

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
