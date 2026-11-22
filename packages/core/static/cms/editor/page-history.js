import { buildCmsUrl } from './config.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';
import { t } from './i18n.js';
import { sanitizeHtml } from './sanitize.js';

/** Keys CaretCMS keeps for itself; a restore never sends them back. */
const PRIVATE_KEYS = ['__body', '__caret_tombstone__', '__caret_draft__', '__caret_publish__', '__caret_template__'];
const HEADERS = { 'Content-Type': 'application/json', 'x-caret-request': '1' };

/** @typedef {{ ts: number, data: unknown, action: string, editor?: { name?: string, email?: string } }} HistoryItem */
/** @typedef {{ key: string, collection: string, id: string, field: string, el: Element }} Bound */
/** @typedef {{ items: HistoryItem[], template: Record<string, string> }} EntryHistory An entry's changes, oldest first, and what its template says per field. */

/** @param {Element} el */
const isRich = el => el.hasAttribute('data-caret-rich');

/** What an element shows: an image's address, a rich text's HTML, a plain text's characters. @param {Element} el */
function shownBy(el) {
  if (el instanceof HTMLImageElement) return el.getAttribute('src') ?? '';
  return isRich(el) ? el.innerHTML : (el.textContent ?? '');
}

/**
 * What a stored value shows in an element, or null when it can't be shown
 * there (so today's stays). Rich text is sanitized like the editor's own.
 * @param {Element} el @param {unknown} value
 */
function displayOf(el, value) {
  if (value === undefined || value === null) return null;
  if (el instanceof HTMLImageElement) return typeof value === 'string' && /^(\/|https?:)/.test(value) ? value : null;
  if (!isRich(el)) return String(value);
  const holder = document.createElement('div');
  holder.innerHTML = sanitizeHtml(String(value));
  return holder.innerHTML;
}

/**
 * What is shown, without Astro's scoped-style markers: the page's own markup
 * carries them and stored text doesn't, which is no difference to a reader.
 * @param {string} display
 */
const comparable = display => display.replace(/\sdata-astro-cid-[a-z0-9]+(?:="")?/g, '');

/** @param {Element} el @param {string} display */
function put(el, display) {
  if (comparable(shownBy(el)) === comparable(display)) return;
  if (el instanceof HTMLImageElement) el.setAttribute('src', display);
  else if (isRich(el)) el.innerHTML = display;
  else el.textContent = display;
}

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
 * @param {{
 *   showToast: import('./toast.js').ToastController,
 *   reload: (message: string) => void,
 *   draftMode: boolean,
 *   onOpen: () => void,
 *   onRestore: (entries: { collection: string, id: string }[]) => void,
 * }} options `draftMode`: a restore becomes a draft; otherwise it is live at
 *   once. `onOpen` runs before the panel shows, `onRestore` with the entries a
 *   restore wrote.
 */
export function createPageHistory({ showToast, reload, draftMode, onOpen, onRestore }) {
  /** @type {HTMLDivElement | null} */
  let dock = null;
  /** What each element showed before the slider moved, to put back on close. @type {Map<Element, string>} */
  const original = new Map();

  /** Bound text and image elements on the page. Markdown body text isn't shown from history. */
  function boundOnPage() {
    /** @type {Bound[]} */
    const found = [];
    document.querySelectorAll('[data-caret]').forEach((el) => {
      if (el.closest('[data-caret-md]')) return;
      const bound = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
      if (bound) found.push({ key: `${bound.collection}::${bound.id}::${bound.field}`, ...bound, el });
    });
    return found;
  }

  /** Each entry's history. @param {Bound[]} bound */
  async function loadHistories(bound) {
    /** @type {Map<string, EntryHistory>} */
    const histories = new Map();
    for (const { collection, id } of bound) {
      const key = `${collection}::${id}`;
      if (histories.has(key)) continue;
      const response = await fetch(buildCmsUrl('/history', new URLSearchParams({ collection, id })), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`History request failed (${response.status})`);
      const body = await response.json();
      const items = /** @type {HistoryItem[]} */ ((body.history ?? []).filter((/** @type {HistoryItem} */ item) => typeof item.ts === 'number'));
      histories.set(key, { items: items.sort((a, b) => a.ts - b.ts), template: body.template && typeof body.template === 'object' ? body.template : {} });
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

  /**
   * What an element showed at a moment (`Infinity` = now): the entry's value
   * then, the template's own text where the entry held none, or today's when
   * neither can be shown.
   * @param {Bound} item @param {Map<string, EntryHistory>} histories @param {number} at
   */
  function displayAt(item, histories, at) {
    const today = original.get(item.el) ?? shownBy(item.el);
    const history = histories.get(`${item.collection}::${item.id}`);
    const state = at === Number.POSITIVE_INFINITY || !history ? null : dataAt(history.items, at);
    if (!state) return today;
    return displayOf(item.el, valueAt(state.data, item.field)) ?? displayOf(item.el, history?.template[item.field]) ?? today;
  }

  function putBack() {
    document.querySelectorAll('.cms-history-changed').forEach(el => el.classList.remove('cms-history-changed'));
    for (const [el, display] of original) {
      // Exactly what was there, markers included.
      if (shownBy(el) === display) continue;
      if (el instanceof HTMLImageElement) el.setAttribute('src', display);
      else if (isRich(el)) el.innerHTML = display;
      else el.textContent = display;
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
    if (!dock) return;
    putBack();
    dock?.remove();
    dock = null;
    document.body.style.paddingBottom = paddingBefore;
    window.removeEventListener('resize', place);
  }

  async function open() {
    if (dock) { close(); return; }
    const bound = boundOnPage();
    /** @type {Map<string, EntryHistory>} */
    let histories;
    try {
      histories = await loadHistories(bound);
    } catch {
      showToast(t('editor.pageHistory.failed'), 'error');
      return;
    }
    // What the page shows at a moment, as one comparable string.
    /** @param {number} at */
    const viewAt = at => bound.map(item => comparable(displayAt(item, histories, at))).join('\u0000');
    // Stops: just before each change, oldest first, then now. A stop that looks
    // the same on this page as the next one (the change was to something this
    // page doesn't show), or the same as the page does now, is left out.
    const moments = [...new Set([...histories.values()].flatMap(history => history.items.map(item => item.ts)))].sort((a, b) => a - b);
    const all = [...moments.map(ts => ({ at: ts - 1, ts })), { at: Number.POSITIVE_INFINITY, ts: Number.POSITIVE_INFINITY }];
    const views = all.map(stop => viewAt(stop.at));
    const nowView = views[views.length - 1];
    const stops = all.filter((stop, index) => index === all.length - 1 || (views[index] !== views[index + 1] && views[index] !== nowView));
    if (stops.length < 2) {
      showToast(t('editor.pageHistory.empty'), 'success');
      return;
    }
    onOpen();
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
        if (!original.has(item.el)) original.set(item.el, shownBy(item.el));
        const display = displayAt(item, histories, stop.at);
        put(item.el, display);
        const differs = comparable(display) !== comparable(original.get(item.el) ?? '');
        item.el.classList.toggle('cms-history-changed', differs);
        if (differs) differences++;
      }
      detail.textContent = now ? t(stops.length === 2 ? 'editor.pageHistory.dragHintOne' : 'editor.pageHistory.dragHintOther', { count: stops.length - 1 })
        : t(differences === 1 ? 'editor.pageHistory.differencesOne' : 'editor.pageHistory.differencesOther', { count: differences, date: format(stop.ts) });
      if (now) putBack();
      else revealDifference();
    }
    range.addEventListener('input', render);
    done.addEventListener('click', close);
    restore.addEventListener('click', async () => {
      const at = stops[Number(range.value)].at;
      restore.disabled = true;
      /** @type {{ collection: string, id: string }[]} */
      const restored = [];
      try {
        for (const [key, { items }] of histories) {
          const state = dataAt(items, at);
          if (!state || !state.data || typeof state.data !== 'object' || Array.isArray(state.data)) continue;
          const [collection, id] = key.split('::');
          const data = Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (state.data)).filter(([name]) => !PRIVATE_KEYS.includes(name)));
          const response = await fetch(buildCmsUrl('/mutate'), { method: 'POST', credentials: 'same-origin', headers: HEADERS,
            body: JSON.stringify({ type: 'put_entry', collection, id, data }) });
          if (!response.ok) throw new Error(`Restore failed (${response.status})`);
          restored.push({ collection, id });
        }
        close();
        onRestore(restored);
        reload(t(draftMode ? 'editor.pageHistory.restored' : 'editor.pageHistory.restoredLive'));
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
