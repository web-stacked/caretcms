import { sanitizeHtml } from './sanitize.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';
import { STUDIO_PATH } from './config.js';

const SYNC_CHANNEL = 'caretcms:content';
const PENDING_SELECTION_KEY = 'caretcms:pending-preview-selection';

/** @typedef {{ dirtyEls: Set<Element> }} InlineEditorState */
/**
 * @typedef {object} SelectionMessage
 * @property {'cms:field-selected'} type
 * @property {string} collection
 * @property {string} id
 * @property {string} field
 * @property {string} [previewPath]
 * @property {boolean} [embedded]
 * @property {string} [source]
 */
/**
 * @typedef {object} EntryReadyMessage
 * @property {'cms:entry-ready'} type
 * @property {string} collection
 * @property {string} id
 * @property {boolean} [embedded]
 */
/**
 * @typedef {object} ChangeMessage
 * @property {'cms:preview' | 'cms:saved' | 'cms:created' | 'cms:deleted'} type
 * @property {string} collection
 * @property {string} id
 * @property {Record<string, unknown> | null} [data]
 * @property {string} [studioPath]
 * @property {boolean} [embedded]
 */
/** @typedef {SelectionMessage | EntryReadyMessage | ChangeMessage} SyncMessage */
/**
 * @typedef {object} PendingSelection
 * @property {string} collection
 * @property {string} id
 * @property {string} field
 * @property {number} savedAt
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Normalize messages before they reach selectors, navigation, or DOM updates.
 * @param {unknown} value
 * @returns {SyncMessage | null}
 */
export function normalizeSyncMessage(value) {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (!isNonEmptyString(value.collection) || !isNonEmptyString(value.id)) return null;

  const common = {
    collection: value.collection,
    id: value.id,
    ...(value.embedded === true ? { embedded: true } : {}),
  };
  if (value.type === 'cms:field-selected') {
    if (!isNonEmptyString(value.field)) return null;
    return {
      ...common,
      type: value.type,
      field: value.field,
      ...(typeof value.previewPath === 'string' ? { previewPath: value.previewPath } : {}),
      ...(typeof value.source === 'string' ? { source: value.source } : {}),
    };
  }
  if (value.type === 'cms:entry-ready') return { ...common, type: value.type };
  if (!['cms:preview', 'cms:saved', 'cms:created', 'cms:deleted'].includes(value.type)) return null;
  if (value.data !== undefined && value.data !== null && !isRecord(value.data)) return null;
  return {
    ...common,
    type: /** @type {ChangeMessage['type']} */ (value.type),
    ...(value.data !== undefined ? { data: value.data } : {}),
    ...(typeof value.studioPath === 'string' ? { studioPath: value.studioPath } : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {PendingSelection | null}
 */
export function normalizePendingSelection(value) {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.collection)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.field)
    || typeof value.savedAt !== 'number'
    || !Number.isFinite(value.savedAt)
  ) return null;
  return {
    collection: value.collection,
    id: value.id,
    field: value.field,
    savedAt: value.savedAt,
  };
}

/**
 * @param {object} options
 * @param {HTMLIFrameElement | null} options.studioIframe
 * @param {InlineEditorState} options.state
 * @param {(message: string, kind: 'success' | 'error') => void} options.showToast
 * @param {(text: string) => string} options.clientLinkify
 */
export function mountStudioSync({ studioIframe, state, showToast, clientLinkify }) {
  let refreshTimer = 0;
  /** @type {Element | null} */
  let selectedInlineEl = null;
  let linkedSelectionTimer = 0;
  /** @type {SelectionMessage | null} */
  let pendingStudioSelection = null;
  /** @type {SelectionMessage | null} */
  let activeStudioSelection = null;

  /**
   * @param {string} collection
   * @param {string} id
   * @param {string} field
   * @returns {Element[]}
   */
  function matchingElements(collection, id, field) {
    const fullKey = `${collection}::${id}::${field}`;
    const matches = Array.from(document.querySelectorAll(`[data-caret="${CSS.escape(fullKey)}"]`));
    document.querySelectorAll(`[data-caret="${CSS.escape(field)}"]`).forEach((el) => {
      const scope = el.closest('[data-caret-scope]')?.getAttribute('data-caret-scope');
      if (scope === `${collection}::${id}` && !matches.includes(el)) matches.push(el);
    });
    return matches;
  }

  /**
   * @param {string} collection
   * @param {string} id
   * @param {string} field
   * @param {boolean} shouldScroll
   */
  function selectInlineField(collection, id, field, shouldScroll) {
    const target = matchingElements(collection, id, field)[0];
    if (!target) return false;

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
    return true;
  }

  /** @param {unknown} path */
  function previewTarget(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
    try {
      const target = new URL(path, window.location.origin);
      return target.origin === window.location.origin ? target : null;
    } catch {
      return null;
    }
  }

  /** @param {SelectionMessage} message */
  function selectOrNavigate(message) {
    if (selectInlineField(message.collection, message.id, message.field, true)) return;

    const target = previewTarget(message.previewPath);
    if (!target || target.href === window.location.href) return;
    if (state.dirtyEls.size > 0) {
      showToast('Finish or cancel your inline edit before opening another page', 'error');
      return;
    }

    try {
      sessionStorage.setItem(PENDING_SELECTION_KEY, JSON.stringify({
        collection: message.collection,
        id: message.id,
        field: message.field,
        savedAt: Date.now(),
      }));
    } catch {
      // Navigation still works without the post-load highlight handoff.
    }
    window.location.assign(target.href);
  }

  /** @param {SelectionMessage} message */
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

  /** @param {SelectionMessage} message */
  function studioEntryPath(message) {
    if (!STUDIO_PATH) return null;
    return `${STUDIO_PATH}/${encodeURIComponent(message.collection)}/${encodeURIComponent(message.id)}`;
  }

  /** @param {SelectionMessage} message */
  function postEmbeddedSelection(message) {
    if (!studioIframe?.contentWindow) return;
    try {
      studioIframe.contentWindow.postMessage({ ...message, embedded: true }, window.location.origin);
    } catch {
      // Embedded field linking is a progressive enhancement.
    }
  }

  /** @param {SelectionMessage} message */
  function deliverEmbeddedSelection(message) {
    if (!studioIframe?.contentWindow) return;
    const targetPath = studioEntryPath(message);
    if (!targetPath) return;

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

  /** @param {Element} el */
  function selectStudioField(el) {
    const resolved = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
    if (!resolved) return;

    selectInlineField(resolved.collection, resolved.id, resolved.field, false);
    /** @type {SelectionMessage} */
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

  /** @param {SyncMessage} msg */
  function rememberStudioPath(msg) {
    if (!('studioPath' in msg) || typeof msg.studioPath !== 'string') return;
    try {
      sessionStorage.setItem('cms-panel-path', msg.studioPath);
    } catch {
      // Remembering the current Studio route is a progressive enhancement.
    }
  }

  /** @param {SyncMessage} msg */
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

  /** @param {ChangeMessage} msg */
  function applySavedMessage(msg) {
    const { collection, id, data } = msg;
    if (!data || typeof data !== 'object') return 0;

    let updated = 0;

    /**
     * @param {string} selector
     * @param {string} path
     * @returns {Element[]}
     */
    function boundElements(selector, path) {
      const matches = Array.from(document.querySelectorAll(`[data-caret="${CSS.escape(selector)}"]`));
      document.querySelectorAll(`[data-caret="${CSS.escape(path)}"]`).forEach((el) => {
        const scope = el.closest('[data-caret-scope]')?.getAttribute('data-caret-scope');
        if (scope === `${collection}::${id}` && !matches.includes(el)) matches.push(el);
      });
      return matches;
    }

    /**
     * @param {Record<string, unknown>} obj
     * @param {string} prefix
     */
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
        } else if (isRecord(value)) {
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
    const msg = normalizeSyncMessage(e.data);
    if (!msg) return;

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
      selectOrNavigate(msg);
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
        const msg = normalizeSyncMessage(event.data);
        if (!msg || msg.embedded === true) return;

        if (msg.type === 'cms:field-selected') {
          selectOrNavigate(msg);
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

  try {
    const rawPending = sessionStorage.getItem(PENDING_SELECTION_KEY);
    if (rawPending) {
      sessionStorage.removeItem(PENDING_SELECTION_KEY);
      const pending = normalizePendingSelection(JSON.parse(rawPending));
      if (pending && Date.now() - pending.savedAt < 30_000) {
        window.requestAnimationFrame(() => {
          selectInlineField(pending.collection, pending.id, pending.field, true);
        });
      }
    }
  } catch {
    // Pending selection recovery is a progressive enhancement.
  }
}
