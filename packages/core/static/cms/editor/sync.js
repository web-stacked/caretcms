import { sanitizeHtml } from './sanitize.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';
import { STUDIO_PATH } from './config.js';

const SYNC_CHANNEL = 'caretcms:content';

export function mountStudioSync({ studioIframe, state, showToast, clientLinkify }) {
  let refreshTimer = 0;
  let selectedInlineEl = null;
  let linkedSelectionTimer = 0;
  let pendingStudioSelection = null;
  let activeStudioSelection = null;

  function matchingElements(collection, id, field) {
    const fullKey = `${collection}::${id}::${field}`;
    const matches = Array.from(document.querySelectorAll(`[data-caret="${CSS.escape(fullKey)}"]`));
    document.querySelectorAll(`[data-caret="${CSS.escape(field)}"]`).forEach((el) => {
      const scope = el.closest('[data-caret-scope]')?.getAttribute('data-caret-scope');
      if (scope === `${collection}::${id}` && !matches.includes(el)) matches.push(el);
    });
    return matches;
  }

  function selectInlineField(collection, id, field, shouldScroll) {
    if (typeof collection !== 'string' || typeof id !== 'string' || typeof field !== 'string') return;
    const target = matchingElements(collection, id, field)[0];
    if (!target) return;

    window.clearTimeout(linkedSelectionTimer);
    if (selectedInlineEl && selectedInlineEl !== target) {
      selectedInlineEl.classList.remove('cms-linked-selection');
    }
    selectedInlineEl = target;
    target.classList.add('cms-linked-selection');
    if (shouldScroll) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }

    // Blue confirms that the paired field was located. Green remains the
    // distinct confirmation that an edit was actually saved.
    linkedSelectionTimer = window.setTimeout(() => {
      if (selectedInlineEl !== target) return;
      target.classList.remove('cms-linked-selection');
      selectedInlineEl = null;
    }, 1500);
  }

  function publishSelection(message) {
    if (!('BroadcastChannel' in window)) return;
    try {
      const channel = new BroadcastChannel(SYNC_CHANNEL);
      channel.postMessage(message);
      window.setTimeout(() => channel.close(), 0);
    } catch {
      // Cross-tab selection linking is a progressive enhancement.
    }
  }

  function studioEntryPath(message) {
    return `${STUDIO_PATH}/${encodeURIComponent(message.collection)}/${encodeURIComponent(message.id)}`;
  }

  function postEmbeddedSelection(message) {
    if (!studioIframe?.contentWindow) return;
    try {
      studioIframe.contentWindow.postMessage({ ...message, embedded: true }, window.location.origin);
    } catch {
      // Embedded field linking is a progressive enhancement.
    }
  }

  function deliverEmbeddedSelection(message) {
    if (!studioIframe?.contentWindow) return;
    const targetPath = studioEntryPath(message);

    // A normal mouse interaction can emit pointerdown, focusin, and click.
    // Keep the latest field without restarting the same iframe navigation for
    // each event in that sequence.
    if (pendingStudioSelection && studioIframe.getAttribute('src') === targetPath) {
      pendingStudioSelection = message;
      return;
    }

    try {
      if (studioIframe.contentWindow.location.pathname !== targetPath) {
        pendingStudioSelection = message;
        studioIframe.src = targetPath;
        try {
          sessionStorage.setItem('cms-panel-path', targetPath);
        } catch {
          // Remembering the route is optional; the current navigation is not.
        }
        return;
      }
    } catch {
      // Cross-origin Studio panels cannot be inspected or navigated safely;
      // preserve the existing postMessage-only behavior for those setups.
    }

    postEmbeddedSelection(message);
  }

  studioIframe?.addEventListener('load', () => {
    if (!pendingStudioSelection) return;
    const message = pendingStudioSelection;
    pendingStudioSelection = null;
    window.requestAnimationFrame(() => postEmbeddedSelection(message));
  });

  function selectStudioField(el) {
    const resolved = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
    if (!resolved) return;

    selectInlineField(resolved.collection, resolved.id, resolved.field, false);
    const message = {
      type: 'cms:field-selected',
      collection: resolved.collection,
      id: resolved.id,
      field: resolved.field,
      source: 'inline',
    };

    activeStudioSelection = message;
    deliverEmbeddedSelection(message);
    publishSelection(message);
  }

  // Pointerdown covers image-like bindings; focusin covers keyboard navigation
  // and text editing. Click catches non-focusable bound elements.
  document.addEventListener('pointerdown', (event) => {
    const el = event.target instanceof Element ? event.target.closest('[data-caret]') : null;
    if (el) selectStudioField(el);
  });
  document.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target.closest('[data-caret]') : null;
    if (el) selectStudioField(el);
  });
  document.addEventListener('focusin', (event) => {
    const el = event.target instanceof Element ? event.target.closest('[data-caret]') : null;
    if (el) selectStudioField(el);
  });

  function rememberStudioPath(msg) {
    if (typeof msg.studioPath !== 'string') return;
    try {
      sessionStorage.setItem('cms-panel-path', msg.studioPath);
    } catch {
      // Remembering the current Studio route is a progressive enhancement.
    }
  }

  function scheduleEmbeddedRefresh(msg) {
    rememberStudioPath(msg);

    if (state.dirtyEls.size > 0) {
      showToast('Saved in Studio — finish your inline edit before refreshing', 'success');
      return;
    }

    showToast('Saved — refreshing visual preview…', 'success');
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => window.location.reload(), 280);
  }

  function applySavedMessage(msg) {
    const { collection, id, data } = msg;
    if (!data || typeof data !== 'object') return 0;

    let updated = 0;

    function boundElements(selector, path) {
      const matches = Array.from(document.querySelectorAll(`[data-caret="${CSS.escape(selector)}"]`));
      document.querySelectorAll(`[data-caret="${CSS.escape(path)}"]`).forEach((el) => {
        const scope = el.closest('[data-caret-scope]')?.getAttribute('data-caret-scope');
        if (scope === `${collection}::${id}` && !matches.includes(el)) matches.push(el);
      });
      return matches;
    }

    function walkData(obj, prefix) {
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const selector = `${collection}::${id}::${path}`;

        if (typeof value === 'string') {
          const els = boundElements(selector, path);
          els.forEach((el) => {
            // Skip elements being actively edited to prevent overwriting unsaved work
            if (state.dirtyEls.has(el) || el === document.activeElement) return;

            if (el instanceof HTMLImageElement) {
              if (el.src !== value && el.getAttribute('src') !== value) {
                el.src = value;
                updated++;
              }
            } else if (el.hasAttribute('data-caret-rich')) {
              const sanitized = sanitizeHtml(value);
              if (el.innerHTML !== sanitized) {
                el.innerHTML = sanitized;
                updated++;
              }
            } else if (el.hasAttribute('data-caret-raw')) {
              if (el.getAttribute('data-caret-raw') !== value) {
                el.setAttribute('data-caret-raw', value);
                el.innerHTML = clientLinkify(value);
                updated++;
              }
            } else if (el.textContent !== value) {
              el.textContent = value;
              updated++;
            }
          });
        } else if (typeof value === 'object' && value !== null) {
          walkData(value, path);
        }
      }
    }

    walkData(data, '');
    return updated;
  }

  window.addEventListener('message', (e) => {
    // Only accept messages from our iframe
    if (!studioIframe || e.source !== studioIframe.contentWindow) return;
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;

    if (
      msg.type === 'cms:entry-ready'
      && activeStudioSelection
      && msg.collection === activeStudioSelection.collection
      && msg.id === activeStudioSelection.id
    ) {
      postEmbeddedSelection(activeStudioSelection);
      return;
    }

    if (msg.type === 'cms:preview') {
      applySavedMessage(msg);
      return;
    }

    if (msg.type === 'cms:field-selected') {
      selectInlineField(msg.collection, msg.id, msg.field, true);
      return;
    }

    if (msg.type === 'cms:saved') {
      applySavedMessage(msg);
      scheduleEmbeddedRefresh(msg);
    }

    if (msg.type === 'cms:created' || msg.type === 'cms:deleted') {
      scheduleEmbeddedRefresh(msg);
    }
  });

  // Standalone Studio pages live in a separate tab, so postMessage cannot
  // reach the site preview. BroadcastChannel provides a same-origin bridge.
  // Reload only after a confirmed mutation. The server remains the source of
  // truth for lists, routing, and derived UI; sites can make the refresh feel
  // continuous with their own cross-document view transitions.
  if ('BroadcastChannel' in window) {
    try {
      const channel = new BroadcastChannel(SYNC_CHANNEL);
      channel.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string' || msg.embedded === true) return;

        if (msg.type === 'cms:field-selected') {
          selectInlineField(msg.collection, msg.id, msg.field, true);
          return;
        }
        if (!['cms:saved', 'cms:created', 'cms:deleted'].includes(msg.type)) return;

        if (state.dirtyEls.size > 0) {
          showToast('Saved in Studio — finish your inline edit before refreshing', 'success');
          return;
        }

        if (msg.type === 'cms:saved') applySavedMessage(msg);
        showToast('Saved — refreshing preview…', 'success');
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => window.location.reload(), 280);
      });
      window.addEventListener('pagehide', () => channel.close(), { once: true });
    } catch {
      // Cross-tab preview sync is progressive enhancement; iframe sync above
      // remains available in browsers without BroadcastChannel.
    }
  }
}
