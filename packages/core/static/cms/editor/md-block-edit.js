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

const snapshots = new WeakMap();

/** Parse `collection::id::body::blockPath`, or null. */
function parseMdBinding(raw) {
  const parts = (raw || '').split('::');
  if (parts.length !== 4 || parts[2] !== 'body') return null;
  if (!/^\d+(\.\d+)*$/.test(parts[3])) return null;
  return { collection: parts[0], id: parts[1], blockPath: parts[3] };
}

/** Serialization context from the DOM — mirrors the server's derivation. */
function blockContextOf(el) {
  const heading = /^h([1-6])$/.exec(el.tagName.toLowerCase());
  if (heading) return { block: 'heading', level: Number(heading[1]) };
  const nested = el.tagName.toLowerCase() === 'li' || el.closest('li, blockquote') !== null;
  return { block: 'paragraph', nested };
}

async function saveMdBlock(binding, src, html) {
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
    }),
  });
  if (res.status === 401) return { ok: false, reason: 'unauthorized' };
  if (res.status === 409) return { ok: false, reason: 'stale' };
  if (!res.ok) return { ok: false, reason: 'error' };
  return { ok: true };
}

export function mountMdBlockEditors({ state, flash, showToast, onUnauthorized }) {
  document.querySelectorAll('[data-caret-md]').forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset.caretMdMounted === 'true') return;

    const binding = parseMdBinding(el.getAttribute('data-caret-md'));
    const src = el.getAttribute('data-caret-md-src') || '';
    if (!binding || !src) return;
    el.dataset.caretMdMounted = 'true';

    const ctx = blockContextOf(el);

    el.setAttribute('contenteditable', 'true');
    el.classList.add('cms-editable', 'cms-md-block');

    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (event.shiftKey && ctx.block === 'paragraph' && !ctx.nested) {
        return; // hard break in a top-level paragraph — allowed
      }
      event.preventDefault();
      showToast(
        event.shiftKey
          ? 'Line breaks are not supported in this block'
          : 'Adding new blocks is coming in a future version',
        'error',
      );
    });

    el.addEventListener('focus', () => {
      snapshots.set(el, el.innerHTML);
    });

    el.addEventListener('input', () => {
      if (el.innerHTML !== snapshots.get(el)) state.dirtyEls.add(el);
      else state.dirtyEls.delete(el);
    });

    el.addEventListener('blur', async () => {
      if (el._caretSkipSave) {
        el._caretSkipSave = false;
        state.dirtyEls.delete(el);
        el.innerHTML = snapshots.get(el) || '';
        return;
      }

      const snapshot = snapshots.get(el) ?? '';
      const clean = sanitizeHtml(el.innerHTML);
      el.innerHTML = clean; // normalize what the user sees to what will save
      if (clean === snapshot) return;

      // Pre-flight the serialization locally so unrepresentable content fails
      // with an immediate message instead of a server round-trip. The server
      // re-derives independently — this is UX, not the trust boundary.
      try {
        serializeBlock(domToSNodes(el), ctx);
      } catch (error) {
        if (error instanceof SerializeError) {
          showToast('This formatting cannot be saved in a markdown block', 'error');
          state.dirtyEls.add(el);
          return;
        }
        throw error;
      }

      el.classList.add('cms-saving');
      const result = await saveMdBlock(binding, src, clean);
      el.classList.remove('cms-saving');
      flash(el, result.ok);

      if (result.ok) {
        state.dirtyEls.delete(el);
        snapshots.set(el, clean);
        showToast('Draft saved — publish to update the file', 'success');
      } else if (result.reason === 'stale') {
        state.dirtyEls.delete(el);
        el.innerHTML = snapshot;
        showToast('This content changed since the page loaded. Reload to edit it.', 'error');
      } else if (result.reason === 'unauthorized') {
        onUnauthorized();
      } else {
        state.dirtyEls.delete(el);
        el.innerHTML = snapshot;
        showToast('Failed to save. Changes reverted.', 'error');
      }
    });
  });
}
