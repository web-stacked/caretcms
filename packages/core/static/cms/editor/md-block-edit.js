import { markdownBlockHtml, mountParagraphGroups, paragraphHtml, pasteParagraphText } from './md-paragraphs.js';
/**
 * Inline editing for markdown body blocks (`data-caret-md`).
 *
 * A stamped block (paragraph / heading / list item, bound by the render-time
 * mdast plugin) becomes contenteditable; the floating rich toolbar provides
 * bold/italic/link. About a second after typing stops, and on blur, the
 * block's sanitized inner HTML is sent as an `md_block` mutation — the server
 * derives the markdown, verifies the source range hash, and stores a draft in
 * the editor's overlay. Where field edits save live (the dev server), the
 * server publishes that draft into the `.md` file straight away and answers
 * `live: true`; the page's block stamps are then re-read from a fresh render,
 * because the file's ranges moved.
 *
 * No `expectedRevision` is sent: body drafts live in a PER-EDITOR overlay, so
 * there is no cross-editor race on the draft itself — the source-range hash in
 * `data-caret-md-src` is the staleness guard that matters, and a 409 here
 * means the underlying file changed (publish, external edit) and the page must
 * be reloaded to pick up fresh stamps.
 */
import { bindUndo, dropEdit, recordEdit, undoLastEdit } from './undo-stack.js';

import { serializeBlock, domToSNodes, SerializeError } from './md-serialize.js';
import { buildCmsUrl } from './config.js';
import { mutateHeaders } from './security.js';
import { SESSION_RESTORED_EVENT } from './session-recovery.js';

/** @typedef {HTMLElement & { _caretSkipSave?: boolean }} MdEditableElement */
/** @typedef {{ collection: string, id: string, blockPath: string }} MdBinding */
/** @typedef {{ blockPath: string, src: string, html: string }} ParagraphSource */
/** @typedef {{ sources: ParagraphSource[], paragraphs: string[] }} ParagraphGroup */
/** @typedef {{ dirtyEls: Set<Element>, linkPopupEl: HTMLElement | null }} MdEditorState */
/** @typedef {{ ok: true, live: boolean, refreshed?: boolean, skipped?: boolean } | { ok: false, reason: 'unauthorized' | 'stale' | 'error' }} MdSaveResult */
/** @typedef {{ block: 'heading', level: number } | { block: 'paragraph', nested: boolean }} MdBlockContext */

/** Each block's last saved HTML. @type {WeakMap<HTMLElement, string>} */
const snapshots = new WeakMap();
/** HTML a block is being saved with right now. @type {WeakMap<HTMLElement, string>} */
const inFlight = new WeakMap();

// Like text fields: save ~1.2s after typing stops, and on blur.
const AUTOSAVE_DELAY_MS = 1200;

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
    // Finish the response before signaling a save. Private/no-store
    // responses must not leave an unread fetch stream alive after this scope.
    const text = await res.text();
    if (res.status === 401) return { ok: false, reason: 'unauthorized' };
    if (res.status === 409) return { ok: false, reason: 'stale' };
    if (!res.ok) return { ok: false, reason: 'error' };
    let live = false;
    try { live = JSON.parse(text)?.live === true; } catch { /* a draft */ }
    return { ok: true, live };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/** Read a block's binding and source stamps as they are now (a live save
 * refreshes them). @param {HTMLElement} el */
function readStamps(el) {
  const binding = parseMdBinding(el.getAttribute('data-caret-md'));
  const src = el.getAttribute('data-caret-md-src') || '';
  const sourcesRaw = el.getAttribute('data-caret-md-sources');
  const sources = sourcesRaw === null ? null : parseParagraphSources(sourcesRaw);
  if (!binding || !src || (sourcesRaw !== null && sources === null)) return null;
  if (sources && (sources[0].blockPath !== binding.blockPath || sources[0].src !== src)) return null;
  return { binding, src, sources };
}

const STAMP_ATTRS = ['data-caret-md', 'data-caret-md-src', 'data-caret-md-sources'];

/**
 * After a live save the file's ranges moved: copy every block stamp of this
 * entry from a fresh render of the page, in document order. False when the
 * page's blocks no longer line up with it.
 * @param {MdBinding} binding
 */
async function refreshStamps(binding) {
  const prefix = `${binding.collection}::${binding.id}::body::`;
  /** @param {ParentNode} root */
  const blocks = root => [...root.querySelectorAll('[data-caret-md]')]
    .filter(node => (node.getAttribute('data-caret-md') || '').startsWith(prefix));
  try {
    const res = await fetch(window.location.href, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return false;
    const fresh = new DOMParser().parseFromString(await res.text(), 'text/html');
    mountParagraphGroups(fresh);
    const next = blocks(fresh);
    const current = blocks(document);
    if (next.length !== current.length) return false;
    current.forEach((el, index) => {
      for (const name of STAMP_ATTRS) {
        const value = next[index].getAttribute(name);
        if (value === null) el.removeAttribute(name);
        else el.setAttribute(name, value);
      }
    });
    return true;
  } catch {
    return false;
  }
}

// Blocks whose save stopped because the session ended, each with the function
// that saves it again once the editor signs back in.
/** @type {Map<HTMLElement, () => Promise<void>>} */
const awaitingSignIn = new Map();
let sessionRetryBound = false;

/**
 * @param {object} options
 * @param {MdEditorState} options.state
 * @param {(element: Element, success: boolean) => void} options.flash
 * @param {((message: string, kind: 'success' | 'error') => unknown) & { saved: (options: { message: string, action?: { label: string, onClick: () => void | Promise<void> } }) => unknown }} options.showToast
 * @param {() => void} options.onUnauthorized
 */
export function mountMdBlockEditors({ state, flash, showToast, onUnauthorized }) {
  bindUndo(showToast);
  if (!sessionRetryBound) {
    window.addEventListener(SESSION_RESTORED_EVENT, () => {
      for (const save of [...awaitingSignIn.values()]) void save();
    });
    sessionRetryBound = true;
  }
  mountParagraphGroups();
  document.querySelectorAll('[data-caret-md]').forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset.caretMdMounted === 'true') return;

    const stamps = readStamps(el);
    // A block with missing or malformed source metadata cannot be saved
    // safely. Keep it visible but do not make it editable.
    if (!stamps) return;
    const { sources } = stamps;
    const ctx = blockContextOf(el);
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

    let edit = 0;
    let editSaved = false;
    let editLive = true;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let autosaveTimer;
    snapshots.set(el, el.innerHTML);
    /** The block's HTML when the current edit began. */
    let editStart = el.innerHTML;

    el.addEventListener('focus', () => {
      if (!state.dirtyEls.has(el)) snapshots.set(el, el.innerHTML);
      edit += 1;
      editStart = snapshots.get(el) ?? el.innerHTML;
    });

    el.addEventListener('input', () => {
      if (el.innerHTML !== snapshots.get(el)) state.dirtyEls.add(el);
      else state.dirtyEls.delete(el);
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        if (document.activeElement === el && state.linkPopupEl !== el) void commitBlock({ autosave: true });
      }, AUTOSAVE_DELAY_MS);
    });

    /**
     * Save the block's current content. On blur (not autosave) the DOM is
     * normalized first; while typing it's left alone so the caret stays put.
     * @param {{ autosave?: boolean }} [options]
     * @returns {Promise<MdSaveResult | null>} null when nothing was sent
     */
    const save = async ({ autosave = false } = {}) => {
      const current = readStamps(el);
      if (!current) return { ok: false, reason: 'stale' };
      const submitted = el.innerHTML;
      const paragraphs = current.sources ? paragraphHtml(el) : null;
      const clean = paragraphs ? paragraphs.map(p => `<p>${p || '<br>'}</p>`).join('') : markdownBlockHtml(submitted);
      if (!current.sources && !autosave) el.innerHTML = clean;
      const expected = el.innerHTML;
      if (expected === snapshots.get(el)) {
        state.dirtyEls.delete(el);
        return null;
      }
      // The same content is already on its way (a blur right after autosave).
      if (expected === inFlight.get(el)) return null;

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
          // While typing the block can pass through unsavable states; only
          // say so when the edit ends.
          if (!autosave) showToast('This formatting cannot be saved in a markdown block', 'error');
          state.dirtyEls.add(el);
          return null;
        }
        throw error;
      }

      const generation = (generations.get(el) ?? 0) + 1;
      generations.set(el, generation);

      el.classList.add('cms-saving');
      inFlight.set(el, expected);
      const result = await enqueueSave(() => {
        // A newer save queued behind us supersedes this content — skip so the
        // older payload can't overwrite the newer draft.
        if (generations.get(el) !== generation) return { ok: true, live: false, skipped: true };
        // Stamps may have been refreshed by a save that finished meanwhile.
        const latest = readStamps(el) ?? current;
        const group = latest.sources && paragraphs ? { sources: latest.sources, paragraphs } : undefined;
        return saveMdBlock(latest.binding, latest.src, latest.sources ? '' : clean, group).then(async saved =>
          // Inside the queue: the next save must see the stamps this one moved.
          saved.ok && saved.live ? { ...saved, refreshed: await refreshStamps(latest.binding) } : saved);
      });
      el.classList.remove('cms-saving');
      if (inFlight.get(el) === expected) inFlight.delete(el);
      if (('skipped' in result && result.skipped) || generations.get(el) !== generation) return null;
      if (result.ok) {
        snapshots.set(el, expected);
        if (el.innerHTML === expected) state.dirtyEls.delete(el);
        if (result.live && !result.refreshed) {
          showToast.saved({
            message: 'Saved. Refresh before editing this text again.',
            action: { label: 'Refresh', onClick: () => window.location.reload() },
          });
        }
        if (!result.live) window.dispatchEvent(new CustomEvent('cms:draftSaved'));
      }
      return result;
    };

    /** Put `value` back over `expected` for undo and redo. @param {string} value @param {string} expected */
    const applyUndo = async (value, expected) => {
      if (snapshots.get(el) !== expected || state.dirtyEls.has(el)) {
        showToast("This text changed since, so it wasn't undone.", 'error');
        return false;
      }
      el.innerHTML = value;
      const result = await save();
      if (result === null || result.ok) {
        flash(el, true);
        return true;
      }
      el.innerHTML = expected;
      snapshots.set(el, expected);
      showToast("Couldn't undo the change. Try again.", 'error');
      return false;
    };

    /** @param {{ autosave?: boolean }} [options] */
    const commitBlock = async ({ autosave = false } = {}) => {
      awaitingSignIn.delete(el);
      if (state.linkPopupEl === el) return;
      if (!autosave) clearTimeout(autosaveTimer);

      // Escape: put back the text from when editing began, and save it if
      // part of the edit had already autosaved. No undo step is left.
      const editableEl = /** @type {MdEditableElement} */ (el);
      if (!autosave && editableEl._caretSkipSave) {
        editableEl._caretSkipSave = false;
        el.innerHTML = editStart;
        state.dirtyEls.delete(el);
        dropEdit(el, edit);
        editSaved = false;
        if (snapshots.get(el) !== editStart) await save();
        return;
      }

      const result = await save({ autosave });
      if (result === null) {
        if (!autosave) finishEdit();
        return;
      }
      flash(el, result.ok);

      if (result.ok) {
        recordEdit({ el, edit, before: editStart, after: snapshots.get(el) ?? '', apply: applyUndo });
        editSaved = true;
        editLive = result.live;
        if (!autosave) finishEdit();
      } else if (result.reason === 'stale') {
        state.dirtyEls.add(el);
        showToast('This content changed. Copy your edits, then reload before saving.', 'error');
      } else if (result.reason === 'unauthorized') {
        state.dirtyEls.add(el);
        awaitingSignIn.set(el, commitBlock);
        onUnauthorized();
      } else {
        state.dirtyEls.add(el);
        showToast('Failed to save. Your edits are kept here; focus and leave the block to retry.', 'error');
      }
    };

    /** When an edit ends, confirm it once with Undo. */
    const finishEdit = () => {
      if (!editSaved) return;
      editSaved = false;
      showToast.saved({
        // Body drafts publish with the rest; fields here may have saved live.
        message: editLive ? 'Saved' : 'Draft saved. Publish to show it to visitors.',
        action: { label: 'Undo', onClick: undoLastEdit },
      });
    };
    el.addEventListener('blur', () => { void commitBlock(); });
  });
}
