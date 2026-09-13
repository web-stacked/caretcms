import { mountParagraphGroups, paragraphHtml, pasteParagraphText } from './md-paragraphs.js';
/**
 * Inline editing for markdown body blocks (`data-caret-md`).
 *
 * A stamped block (paragraph / heading / list item, bound by the render-time
 * mdast plugin) becomes contenteditable; the floating rich toolbar provides
 * bold/italic/link. On blur the block's sanitized inner HTML is sent as an
 * `md_block` mutation — the server derives the markdown, verifies the source
 * range hash, and stores the draft in the editor's overlay. The `.md` file is
 * only touched at Publish.
 *
 * No `expectedRevision` is sent: body drafts live in a PER-EDITOR overlay, so
 * there is no cross-editor race on the draft itself — the source-range hash in
 * `data-caret-md-src` is the staleness guard that matters, and a 409 here
 * means the underlying file changed (publish, external edit) and the page must
 * be reloaded to pick up fresh stamps.
 */

import { serializeBlock, domToSNodes, SerializeError } from './md-serialize.js';
import { sanitizeHtml } from './sanitize.js';
import { buildCmsUrl } from './config.js';
import { mutateHeaders } from './security.js';

/** @typedef {HTMLElement & { _caretSkipSave?: boolean }} MdEditableElement */
/** @typedef {{ collection: string, id: string, blockPath: string }} MdBinding */
/** @typedef {{ blockPath: string, src: string, html: string }} ParagraphSource */
/** @typedef {{ sources: ParagraphSource[], paragraphs: string[] }} ParagraphGroup */
/** @typedef {{ dirtyEls: Set<Element>, linkPopupEl: HTMLElement | null }} MdEditorState */
/** @typedef {{ ok: true, skipped?: boolean } | { ok: false, reason: 'unauthorized' | 'stale' | 'error' }} MdSaveResult */
/** @typedef {{ block: 'heading', level: number } | { block: 'paragraph', nested: boolean }} MdBlockContext */

/** @type {WeakMap<HTMLElement, string>} */
const snapshots = new WeakMap();

// All md-block saves are chained through one queue (same pattern as
// save-queue.js): two fast blur-saves of the same block can otherwise race on
// the network and land out of order — both return ok, and the older content
// silently wins. A per-element generation counter additionally drops a queued
// save that a newer blur has superseded.
/** @type {Promise<unknown>} */
let saveChain = Promise.resolve();
/** @type {WeakMap<HTMLElement, number>} */
const generations = new WeakMap();

/** @param {() => Promise<MdSaveResult> | MdSaveResult} task @returns {Promise<MdSaveResult>} */
function enqueueSave(task) {
  const run = saveChain.then(task, task);
  saveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Parse `collection::id::body::blockPath`, or null. */
/** @param {string | null} raw @returns {MdBinding | null} */
function parseMdBinding(raw) {
  const parts = (raw || '').split('::');
  if (parts.length !== 4 || parts[2] !== 'body') return null;
  if (!/^[a-z][a-z0-9_-]*$/.test(parts[0]) || !/^[a-z0-9][a-z0-9_-]*$/.test(parts[1])) return null;
  if (!/^\d+(\.\d+)*$/.test(parts[3])) return null;
  return { collection: parts[0], id: parts[1], blockPath: parts[3] };
}

/**
 * Parse the server-authored structural paragraph source list. Attribute data
 * is still a browser input boundary: extensions or page scripts can alter it,
 * so malformed data must leave the group read-only instead of crashing mount
 * or being echoed into a mutation.
 * @param {string | null} raw
 * @returns {ParagraphSource[] | null}
 */
export function parseParagraphSources(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.length < 1 || value.length > 128) return null;
    /** @type {ParagraphSource[]} */
    const sources = [];
    for (const source of value) {
      if (typeof source !== 'object' || source === null ||
          typeof source.blockPath !== 'string' || !/^\d+$/.test(source.blockPath) ||
          typeof source.src !== 'string' || !/^\d+:\d+:[0-9a-f]{8}$/.test(source.src) ||
          typeof source.html !== 'string') return null;
      const [start, end] = source.src.split(':').map(Number);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return null;
      const previous = sources[sources.length - 1];
      if (previous) {
        const previousEnd = Number(previous.src.split(':')[1]);
        if (Number(source.blockPath) !== Number(previous.blockPath) + 1 || start <= previousEnd) return null;
      }
      sources.push({ blockPath: source.blockPath, src: source.src, html: source.html });
    }
    return sources;
  } catch {
    return null;
  }
}

/** Serialization context from the DOM — mirrors the server's derivation. */
/** @param {HTMLElement} el @returns {MdBlockContext} */
function blockContextOf(el) {
  const heading = /^h([1-6])$/.exec(el.tagName.toLowerCase());
  if (heading) return { block: 'heading', level: Number(heading[1]) };
  const nested = el.tagName.toLowerCase() === 'li' || el.closest('li, blockquote') !== null;
  return { block: 'paragraph', nested };
}

/**
 * @param {MdBinding} binding
 * @param {string} src
 * @param {string} html
 * @param {ParagraphGroup | undefined} group
 * @returns {Promise<MdSaveResult>}
 */
async function saveMdBlock(binding, src, html, group) {
  try {
    const res = await fetch(buildCmsUrl('/mutate'), {
      method: 'POST',
      headers: await mutateHeaders(),
      body: JSON.stringify({
        type: 'md_block',
        collection: binding.collection,
        id: binding.id,
        blockPath: binding.blockPath,
        src,
        html,
        ...group,
      }),
    });
    if (res.status === 401) return { ok: false, reason: 'unauthorized' };
    if (res.status === 409) return { ok: false, reason: 'stale' };
    if (!res.ok) return { ok: false, reason: 'error' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * @param {object} options
 * @param {MdEditorState} options.state
 * @param {(element: Element, success: boolean) => void} options.flash
 * @param {(message: string, kind: 'success' | 'error') => unknown} options.showToast
 * @param {() => void} options.onUnauthorized
 */
export function mountMdBlockEditors({ state, flash, showToast, onUnauthorized }) {
  mountParagraphGroups();
  document.querySelectorAll('[data-caret-md]').forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset.caretMdMounted === 'true') return;

    const binding = parseMdBinding(el.getAttribute('data-caret-md'));
    const src = el.getAttribute('data-caret-md-src') || '';
    if (!binding || !src) return;
    const ctx = blockContextOf(el);
    const sourcesRaw = el.getAttribute('data-caret-md-sources');
    const sources = sourcesRaw === null ? null : parseParagraphSources(sourcesRaw);
    // A structural group with missing or malformed source metadata cannot be
    // saved safely as one block. Keep it visible but do not make it editable.
    if (sourcesRaw !== null && sources === null) return;
    if (sources && (sources[0].blockPath !== binding.blockPath || sources[0].src !== src)) return;
    el.dataset.caretMdMounted = 'true';
    if (sources) {
      el.classList.add('cms-md-paragraphs');
      el.addEventListener('paste', pasteParagraphText);
      // A drop can import arbitrary block structure outside the paste path.
      el.addEventListener('drop', event => event.preventDefault());
    }

    el.setAttribute('contenteditable', 'true');
    el.classList.add('cms-editable', 'cms-md-block');

    el.addEventListener('keydown', (event) => {
      if (sources || event.key !== 'Enter') return;
      if (event.shiftKey && ctx.block === 'paragraph' && !ctx.nested) {
        return; // hard break in a top-level paragraph — allowed
      }
      event.preventDefault();
      showToast(
        event.shiftKey
          ? 'Line breaks are not supported in this block'
          : 'Paragraph changes are not supported in this block',
        'error',
      );
    });

    el.addEventListener('beforeinput', (rawEvent) => {
      const event = /** @type {InputEvent} */ (rawEvent);
      if (!sources && (event.inputType === 'insertParagraph' ||
          (event.inputType === 'insertLineBreak' && (ctx.block !== 'paragraph' || ctx.nested)))) {
        event.preventDefault();
        showToast('Paragraph changes are not supported in this block', 'error');
      }
    });

    el.addEventListener('focus', () => {
      snapshots.set(el, el.innerHTML);
    });

    el.addEventListener('input', () => {
      if (el.innerHTML !== snapshots.get(el)) state.dirtyEls.add(el);
      else state.dirtyEls.delete(el);
    });

    el.addEventListener('blur', async () => {
      if (state.linkPopupEl === el) return;

      const editableEl = /** @type {MdEditableElement} */ (el);
      if (editableEl._caretSkipSave) {
        editableEl._caretSkipSave = false;
        state.dirtyEls.delete(el);
        el.innerHTML = snapshots.get(el) || '';
        return;
      }

      const snapshot = snapshots.get(el) ?? '';
      const submitted = el.innerHTML;
      const paragraphs = sources ? paragraphHtml(el) : null;
      const clean = paragraphs ? paragraphs.map(p => `<p>${p || '<br>'}</p>`).join('') : sanitizeHtml(submitted);
      if (!sources) el.innerHTML = clean;
      if (submitted === snapshot && !state.dirtyEls.has(el)) return;

      // Pre-flight the serialization locally so unrepresentable content fails
      // with an immediate message instead of a server round-trip. The server
      // re-derives independently — this is UX, not the trust boundary.
      try {
        if (paragraphs) {
          for (const html of paragraphs) {
            const paragraph = document.createElement('p');
            paragraph.innerHTML = html;
            serializeBlock(domToSNodes(paragraph), { block: 'paragraph', nested: false });
          }
        } else serializeBlock(domToSNodes(el), ctx);
      } catch (error) {
        if (error instanceof SerializeError) {
          showToast('This formatting cannot be saved in a markdown block', 'error');
          state.dirtyEls.add(el);
          return;
        }
        throw error;
      }

      const generation = (generations.get(el) ?? 0) + 1;
      generations.set(el, generation);

      el.classList.add('cms-saving');
      const result = await enqueueSave(() => {
        // A newer blur queued behind us supersedes this content — skip so the
        // older payload can't overwrite the newer draft.
        if (generations.get(el) !== generation) return { ok: true, skipped: true };
        const group = sources && paragraphs ? { sources, paragraphs } : undefined;
        return saveMdBlock(binding, src, sources ? '' : clean, group);
      });
      el.classList.remove('cms-saving');
      if (('skipped' in result && result.skipped) || generations.get(el) !== generation) return;
      flash(el, result.ok);

      if (result.ok) {
        if (el.innerHTML === (sources ? submitted : clean)) {
          state.dirtyEls.delete(el);
          snapshots.set(el, el.innerHTML);
        }
        showToast('Draft saved — publish to update the file', 'success');
        // Signal the toolbar so server-delivery mode reveals its Publish/Discard
        // controls (hidden until a body draft is pending).
        window.dispatchEvent(new CustomEvent('cms:draftSaved'));
      } else if (result.reason === 'stale') {
        state.dirtyEls.add(el);
        showToast('This content changed. Copy your edits, then reload before saving.', 'error');
      } else if (result.reason === 'unauthorized') {
        onUnauthorized();
      } else {
        state.dirtyEls.add(el);
        showToast('Failed to save. Your edits are kept here; focus and leave the block to retry.', 'error');
      }
    });
  });
}
