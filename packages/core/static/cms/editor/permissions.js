import { buildCmsUrl, isPolicyDraftMode } from './config.js';
import { readHeaders } from './security.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';
import { t } from './i18n.js';

/**
 * With an authorization policy, an editor may be allowed to edit only some of
 * a page's entries. Bindings for the others are shown read-only, with the
 * reason, instead of accepting typing that can't be saved.
 */

/** The entry a binding belongs to, as collection::id. @param {Element} el */
function entryKey(el) {
  const md = el.getAttribute('data-caret-md');
  if (md !== null) {
    const [collection, id] = md.split('::');
    return collection && id ? `${collection}::${id}` : null;
  }
  const resolved = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
  return resolved ? `${resolved.collection}::${resolved.id}` : null;
}

/** Entries on this page this editor may not edit (none without a policy). */
export async function findDeniedEntries() {
  /** @type {Set<string>} */
  const denied = new Set();
  if (!isPolicyDraftMode()) return denied;
  const keys = new Set();
  document.querySelectorAll('[data-caret], [data-caret-md]').forEach((el) => {
    const key = entryKey(el);
    if (key) keys.add(key);
  });
  await Promise.all([...keys].map(async (key) => {
    const [collection, id] = key.split('::');
    try {
      const res = await fetch(buildCmsUrl('/entries', { collection, id }), { headers: readHeaders() });
      const body = res.ok ? await res.json() : null;
      if (body && body.editable === false) denied.add(key);
    } catch {
      // Unknown: leave it editable; the save still enforces the policy.
    }
  }));
  return denied;
}

/** @type {WeakSet<Element>} */
const explained = new WeakSet();

/**
 * Mark bindings of denied entries read-only so the editors skip them, and say
 * why when one is clicked.
 * @param {Set<string>} denied
 * @param {(message: string, kind: 'success' | 'error') => unknown} showToast
 */
export function lockDeniedBindings(denied, showToast) {
  if (denied.size === 0) return;
  document.querySelectorAll('[data-caret], [data-caret-md]').forEach((el) => {
    const key = entryKey(el);
    if (!key || !denied.has(key)) return;
    el.setAttribute('data-caret-locked', 'permission');
    el.classList.add('cms-locked');
    if (el instanceof HTMLElement) el.title = t('editor.permissions.denied');
    if (explained.has(el)) return;
    explained.add(el);
    el.addEventListener('click', () => {
      if (document.body.classList.contains('cms-edit-mode')) showToast(t('editor.permissions.denied'), 'error');
    });
  });
}
