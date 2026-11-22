import { buildCmsUrl } from './config.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';
import { t } from './i18n.js';

/** Keys CaretCMS keeps for itself; a restore never sends them back. */
const PRIVATE_KEYS = ['__body', '__caret_tombstone__', '__caret_draft__', '__caret_publish__', '__caret_template__'];
const HEADERS = { 'Content-Type': 'application/json', 'x-caret-request': '1' };

/** @typedef {{ ts: number, data: unknown, action: string, editor?: { name?: string, email?: string } }} HistoryItem */
/** @typedef {{ key: string, collection: string, id: string, field: string, el: Element }} Bound */

/** A field's value in entry data, following dots for nested fields. @param {unknown} data @param {string} field */
function valueAt(data, field) {
  let value = data;
  for (const part of field.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = /** @type {Record<string, unknown>} */ (value)[part];
  }
  return value;
}

/**
 * Page history: drag a slider back through the times this page's content was
 * published or restored, and the page shows what it said then. Plain text and
 * images change in place; rich text and body text keep today's version.
 * Restore makes the version shown a draft, to publish like any other.
 *
 * @param {{ showToast: import('./toast.js').ToastController, reload: (message: string) => void }} options
 */
export function createPageHistory({ showToast, reload }) {
  /** @type {HTMLDivElement | null} */
  let dock = null;
  /** What each element showed before the slider moved, to put back on close. @type {Map<Element, { text?: string, src?: string }>} */
  const original = new Map();

  /** Bound text and image elements on the page. Rich and body text aren't shown from history. */
  function boundOnPage() {
    /** @type {Bound[]} */
    const found = [];
    document.querySelectorAll('[data-caret]').forEach((el) => {
      if (el.hasAttribute('data-caret-rich') || el.closest('[data-caret-md]')) return;
      const bound = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
      if (bound) found.push({ key: `${bound.collection}::${bound.id}::${bound.field}`, ...bound, el });
    });
    return found;
  }

  /** Each entry's history, oldest first. @param {Bound[]} bound */
  async function loadHistories(bound) {
    /** @type {Map<string, HistoryItem[]>} */
    const histories = new Map();
    for (const { collection, id } of bound) {
      const key = `${collection}::${id}`;
      if (histories.has(key)) continue;
      const response = await fetch(buildCmsUrl('/history', new URLSearchParams({ collection, id })), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`History request failed (${response.status})`);
      const items = /** @type {HistoryItem[]} */ (((await response.json()).history ?? []).filter((/** @type {HistoryItem} */ item) => typeof item.ts === 'number'));
      histories.set(key, items.sort((a, b) => a.ts - b.ts));
    }
    return histories;
  }

  /**
   * An entry's data at a moment: each history item holds the data from just
   * before its change, so the first item after the moment says what it was
   * then. With none after it, the entry is as it is now (`null` = unchanged).
   * @param {HistoryItem[]} items @param {number} at
   */
  function dataAt(items, at) {
    const next = items.find(item => item.ts > at);
    return next ? { data: next.data } : null;
  }

  /** @param {Bound} bound @param {unknown} value */
  function show(bound, value) {
    const el = bound.el;
    if (!original.has(el)) original.set(el, el instanceof HTMLImageElement ? { src: el.getAttribute('src') ?? '' } : { text: el.textContent ?? '' });
    const before = /** @type {{ text?: string, src?: string }} */ (original.get(el));
    if (el instanceof HTMLImageElement) {
      const src = typeof value === 'string' && /^(\/|https?:)/.test(value) ? value : before.src ?? '';
      if (el.getAttribute('src') !== src) el.setAttribute('src', src);
    } else {
      const text = typeof value === 'string' ? value : value === undefined || value === null ? before.text ?? '' : String(value);
      if (el.textContent !== text) el.textContent = text;
    }
  }

  function putBack() {
    document.querySelectorAll('.cms-history-changed').forEach(el => el.classList.remove('cms-history-changed'));
    for (const [el, value] of original) {
      if (el instanceof HTMLImageElement) el.setAttribute('src', value.src ?? '');
      else el.textContent = value.text ?? '';
    }
    original.clear();
  }

  /** Sit just above the editor's toolbar, wherever the site or the dev server put it. */
  function place() {
    if (!dock) return;
    const toolbar = document.querySelector('.cms-toolbar-inner') ?? document.querySelector('.cms-toolbar');
    const top = toolbar?.getBoundingClientRect().top ?? window.innerHeight;
    dock.style.bottom = `${Math.max(12, window.innerHeight - top + 10)}px`;
  }

  /** Room under the page while the panel is open, so the last texts can scroll above it. */
  let paddingBefore = '';
  function makeRoom() {
    if (!dock) return;
    paddingBefore = document.body.style.paddingBottom;
    const height = window.innerHeight - dock.getBoundingClientRect().top;
    document.body.style.paddingBottom = `${Math.max(height + 24, parseFloat(getComputedStyle(document.body).paddingBottom) || 0)}px`;
  }

  /** Scroll so the first outlined difference is visible above the panel, unless one already is. */
  function revealDifference() {
    if (!dock) return;
    const changed = [...document.querySelectorAll('.cms-history-changed')];
    if (changed.length === 0) return;
    const limit = dock.getBoundingClientRect().top - 16;
    const visible = changed.some((el) => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.bottom <= limit; });
    if (visible) return;
    const box = changed[0].getBoundingClientRect();
    window.scrollBy({ top: box.top - Math.max(16, (limit - box.height) / 2), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function close() {
    putBack();
    dock?.remove();
    dock = null;
    document.body.style.paddingBottom = paddingBefore;
    window.removeEventListener('resize', place);
  }

  async function open() {
    if (dock) { close(); return; }
    const bound = boundOnPage();
    /** @type {Map<string, HistoryItem[]>} */
    let histories;
    try {
      histories = await loadHistories(bound);
    } catch {
      showToast(t('editor.pageHistory.failed'), 'error');
      return;
    }
    // What each element shows at a moment, as one comparable string.
    /** @param {number} at */
    const viewAt = (at) => bound.map((item) => {
      const state = at === Number.POSITIVE_INFINITY ? null : dataAt(histories.get(`${item.collection}::${item.id}`) ?? [], at);
      return JSON.stringify(state ? valueAt(state.data, item.field) ?? null : '__now__');
    }).join('\u0000');
    // Stops: just before each change, oldest first, then now. A stop that looks
    // the same on this page as the next one (the change was to a field this page
    // doesn't show) is left out.
    const moments = [...new Set([...histories.values()].flat().map(item => item.ts))].sort((a, b) => a - b);
    const all = [...moments.map(ts => ({ at: ts - 1, ts })), { at: Number.POSITIVE_INFINITY, ts: Number.POSITIVE_INFINITY }];
    const views = all.map(stop => viewAt(stop.at));
    const nowView = bound.map((item) => JSON.stringify(item.el instanceof HTMLImageElement ? item.el.getAttribute('src') : (item.el.textContent ?? ''))).join('\u0000');
    const stops = all.filter((stop, index) => index === all.length - 1 ||
      (views[index] !== views[index + 1] && views[index].replaceAll('"__now__"', '') !== nowView));
    if (stops.length < 2) {
      showToast(t('editor.pageHistory.empty'), 'success');
      return;
    }
    dock = document.createElement('div');
    dock.className = 'cms-page-history';
    dock.setAttribute('role', 'dialog');
    dock.setAttribute('aria-label', t('editor.pageHistory.title'));
    dock.setAttribute('data-caret-ui', '');
    const label = document.createElement('label');
    label.htmlFor = 'cms-page-history-range';
    const range = document.createElement('input');
    range.type = 'range';
    range.id = 'cms-page-history-range';
    range.min = '0';
    range.max = String(stops.length - 1);
    range.step = '1';
    range.value = String(stops.length - 1);
    const actions = document.createElement('div');
    actions.className = 'cms-page-history-actions';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'cms-page-history-restore';
    restore.textContent = t('editor.pageHistory.restore');
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = t('editor.pageHistory.close');
    actions.append(done, restore);
    dock.append(label, range, actions);
    document.body.append(dock);
    place();
    makeRoom();
    window.addEventListener('resize', place);

    const format = (/** @type {number} */ ts) => new Date(ts).toLocaleString(document.documentElement.lang || undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    const title = document.createElement('strong');
    const detail = document.createElement('span');
    detail.className = 'cms-page-history-detail';
    label.append(title, detail);
    function render() {
      const index = Number(range.value);
      const stop = stops[index];
      const now = stop.at === Number.POSITIVE_INFINITY;
      title.textContent = now ? t('editor.pageHistory.current') : t('editor.pageHistory.version', { index: index + 1, count: stops.length });
      restore.hidden = now;
      let differences = 0;
      for (const item of bound) {
        const state = now ? null : dataAt(histories.get(`${item.collection}::${item.id}`) ?? [], stop.at);
        const before = original.get(item.el);
        show(item, state ? valueAt(state.data, item.field) : (before?.text ?? before?.src));
        const today = original.get(item.el);
        const differs = !now && (item.el instanceof HTMLImageElement ? item.el.getAttribute('src') !== today?.src : item.el.textContent !== today?.text);
        item.el.classList.toggle('cms-history-changed', differs);
        if (differs) differences++;
      }
      detail.textContent = now ? t('editor.pageHistory.dragHint')
        : t(differences === 1 ? 'editor.pageHistory.differencesOne' : 'editor.pageHistory.differencesOther', { count: differences, date: format(stop.ts) });
      if (now) putBack();
      else revealDifference();
    }
    range.addEventListener('input', render);
    done.addEventListener('click', close);
    restore.addEventListener('click', async () => {
      const at = stops[Number(range.value)].at;
      restore.disabled = true;
      try {
        for (const [key, items] of histories) {
          const state = dataAt(items, at);
          if (!state || !state.data || typeof state.data !== 'object' || Array.isArray(state.data)) continue;
          const [collection, id] = key.split('::');
          const data = Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (state.data)).filter(([name]) => !PRIVATE_KEYS.includes(name)));
          const response = await fetch(buildCmsUrl('/mutate'), { method: 'POST', credentials: 'same-origin', headers: HEADERS,
            body: JSON.stringify({ type: 'put_entry', collection, id, data }) });
          if (!response.ok) throw new Error(`Restore failed (${response.status})`);
        }
        close();
        reload(t('editor.pageHistory.restored'));
      } catch {
        restore.disabled = false;
        showToast(t('editor.pageHistory.restoreFailed'), 'error');
      }
    });
    render();
    range.focus();
  }

  // Leaving the page with an old version on screen: put today's back first, so
  // nothing that records what the page showed ("since you were last here")
  // records the old version. Registered before that listener, so it runs first.
  window.addEventListener('pagehide', putBack);

  return { open, close };
}
