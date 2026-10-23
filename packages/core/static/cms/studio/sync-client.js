import { deepClone } from './field-model.js';

const SYNC_CHANNEL = 'caretcms:content';

/** @typedef {{ postMessage: (message: unknown) => void, addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void, close: () => void }} Channel */

/**
 * @param {{
 *   collection: string,
 *   id: string,
 *   previewPath: string | null,
 *   origin: string,
 *   isEmbedded: boolean,
 *   studioPath: () => string,
 *   postToParent: (message: unknown) => void,
 *   onSelection: (message: Record<string, unknown>) => void,
 *   addWindowMessageListener: (listener: (event: MessageEvent) => void) => void,
 *   addPagehideListener: (listener: () => void) => void,
 *   openChannel?: (name: string) => Channel,
 *   schedule?: (callback: () => void, delay: number) => number,
 *   cancel?: (timer: number) => void,
 *   now?: () => number,
 * }} options
 */
export function createStudioSync(options) {
  const {
    collection, id, previewPath, origin, isEmbedded, studioPath,
    postToParent, onSelection, addWindowMessageListener, addPagehideListener,
    openChannel, schedule = (callback, delay) => window.setTimeout(callback, delay),
    cancel = timer => window.clearTimeout(timer), now = Date.now,
  } = options;
  let previewTimer = 0;
  /** @type {Channel | null} */
  let channel = null;

  if (openChannel) {
    try {
      channel = openChannel(SYNC_CHANNEL);
      channel.addEventListener('message', event => {
        const message = event.data;
        if (message && typeof message === 'object' && message.type === 'cms:field-selected') {
          onSelection(message);
        }
      });
      addPagehideListener(() => channel?.close());
    } catch {
      channel = null;
    }
  }

  addWindowMessageListener(event => {
    const message = event.data;
    if (event.origin === origin && message && typeof message === 'object'
      && message.type === 'cms:field-selected') {
      onSelection(message);
    }
  });

  /** @param {unknown} data */
  function queuePreview(data) {
    if (!isEmbedded || !data) return;
    if (previewTimer) cancel(previewTimer);
    previewTimer = schedule(() => {
      try {
        postToParent({
          type: 'cms:preview', collection, id, data: deepClone(data),
          embedded: true, studioPath: studioPath(),
        });
      } catch {
        // Visual preview is a progressive enhancement.
      }
    }, 80);
  }

  /**
   * @param {string} type @param {unknown} data
   * @param {{ structural?: boolean }} [options] `structural`: the change goes
   *   beyond text the page can update in place, so the page needs a refresh.
   */
  function announceChange(type, data, options = {}) {
    const message = {
      type, collection, id, data: data ? deepClone(data) : null,
      embedded: isEmbedded, studioPath: studioPath(), savedAt: now(),
      ...(typeof options.structural === 'boolean' ? { structural: options.structural } : {}),
    };
    if (isEmbedded) {
      try { postToParent(message); } catch { /* Progressive enhancement. */ }
    }
    try { channel?.postMessage(message); } catch { /* Progressive enhancement. */ }
  }

  /** @param {string} path */
  function announceFieldSelection(path) {
    const message = {
      type: 'cms:field-selected', collection, id, field: path,
      source: 'studio', previewPath,
    };
    if (isEmbedded) {
      try { postToParent({ ...message, embedded: true }); } catch { /* Progressive enhancement. */ }
      return;
    }
    try { channel?.postMessage(message); } catch { /* Progressive enhancement. */ }
  }

  function announceReady() {
    if (!isEmbedded) return;
    try { postToParent({ type: 'cms:entry-ready', collection, id, embedded: true }); }
    catch { /* Progressive enhancement. */ }
  }

  // Lets the page behind the drawer show unsaved drawer changes on its status.
  let lastDirty = false;
  /** @param {boolean} dirty */
  function announceStatus(dirty) {
    if (!isEmbedded || dirty === lastDirty) return;
    lastDirty = dirty;
    try { postToParent({ type: 'cms:status', collection, id, dirty, embedded: true }); }
    catch { /* Progressive enhancement. */ }
  }

  return { queuePreview, announceChange, announceFieldSelection, announceReady, announceStatus };
}
