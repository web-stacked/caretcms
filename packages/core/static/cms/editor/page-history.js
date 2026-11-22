import { buildCmsUrl } from './config.js';
import { parseCaretAttr, resolveBinding } from './helpers.js';
import { t } from './i18n.js';
import { sanitizeHtml } from './sanitize.js';
import { blockHtml, bodyChanges, pageBlocks, pageMatches } from './history-body.js';

/** Keys CaretCMS keeps for itself; a restore never sends them back. */
const PRIVATE_KEYS = ['__body', '__caret_tombstone__', '__caret_draft__', '__caret_publish__', '__caret_template__'];
const HEADERS = { 'Content-Type': 'application/json', 'x-caret-request': '1' };

/** @typedef {{ ts: number, data: unknown, body?: string, action: string, editor?: { name?: string, email?: string } }} HistoryItem `data` and `body` are the entry as it was just before this change. */
/** @typedef {{ key: string, collection: string, id: string, field: string, el: Element }} Bound */
/** @typedef {{ items: HistoryItem[], template: Record<string, string>, body: string | null }} EntryHistory An entry's changes, oldest first, what its template says per field, and its Markdown body text today (null without one). */

/** A moment as editors read it: "22 November, 09:14", with the year when it isn't this year. @param {number} ts */
function versionDate(ts) {
  const date = new Date(ts);
  return date.toLocaleString(document.documentElement.lang || undefined, {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}

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
 * images change in place, and so do Markdown body paragraphs (history-body.js).
 * Restore makes the version shown a draft, to publish like any other; an
 * earlier body text is restored with its source file and published at once.
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
      const response = await fetch(buildCmsUrl('/history', new URLSearchParams({ collection, id, published: '1' })), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`History request failed (${response.status})`);
      const body = await response.json();
      const items = /** @type {HistoryItem[]} */ ((body.history ?? []).filter((/** @type {HistoryItem} */ item) => typeof item.ts === 'number'));
      histories.set(key, { items: items.sort((a, b) => a.ts - b.ts), template: body.template && typeof body.template === 'object' ? body.template : {},
        body: typeof body.body === 'string' ? body.body : null });
    }
    return histories;
  }

  /**
   * An entry's body text at a moment, or null when it is today's (or unknown).
   * @param {EntryHistory} history @param {number} at
   */
  function bodyAt(history, at) {
    if (history.body === null || at === Number.POSITIVE_INFINITY) return null;
    const next = history.items.find(item => item.ts > at);
    return next && typeof next.body === 'string' && next.body !== history.body ? next.body : null;
  }

  /** Body blocks changed on the page for an earlier version, to undo on close. */
  /** @type {Map<HTMLElement, string>} */
  const bodyReplaced = new Map();
  /** @type {Map<HTMLElement, string>} */
  const bodyHidden = new Map();
  /** @type {HTMLElement[]} */
  const bodyInserted = [];

  function clearBody() {
    for (const [el, html] of bodyReplaced) { el.innerHTML = html; el.classList.remove('cms-history-changed'); }
    for (const [el, display] of bodyHidden) el.style.display = display;
    bodyInserted.forEach(el => el.remove());
    bodyReplaced.clear();
    bodyHidden.clear();
    bodyInserted.length = 0;
  }

  /**
   * Show each entry's body text as it was at a moment: changed paragraphs say
   * what they said then, newer ones are hidden, removed ones shown again, all
   * outlined. Returns how many differ, and whether some differing body text
   * can't be shown (the page was built from an older body than the site's).
   * @param {Map<string, EntryHistory>} histories @param {number} at
   */
  function showBody(histories, at) {
    clearBody();
    let differences = 0;
    let unseen = false;
    for (const [key, history] of histories) {
      const then = bodyAt(history, at);
      if (then === null || history.body === null) continue;
      const onPage = pageBlocks(key);
      if (!pageMatches(history.body, onPage)) { unseen = true; continue; }
      const changes = bodyChanges(history.body, then, onPage);
      for (const [el, markdown] of changes.replace) {
        bodyReplaced.set(el, el.innerHTML);
        el.innerHTML = blockHtml(markdown);
        el.classList.add('cms-history-changed');
        differences++;
      }
      for (const el of changes.hide) {
        bodyHidden.set(el, el.style.display);
        el.style.display = 'none';
        differences++;
      }
      /** @type {Map<HTMLElement, HTMLElement>} The last block shown again after each block, so several keep their order. */
      const lastAfter = new Map();
      for (const { after, before, markdown } of changes.insert) {
        const like = after ?? before;
        if (!like) continue;
        const el = document.createElement(like.tagName);
        el.className = 'cms-history-changed cms-history-restored';
        el.setAttribute('data-caret-ui', '');
        el.innerHTML = blockHtml(markdown);
        if (after) {
          (lastAfter.get(after) ?? after).after(el);
          lastAfter.set(after, el);
        } else {
          /** @type {HTMLElement} */ (before).before(el);
        }
        bodyInserted.push(el);
        differences++;
      }
    }
    return { differences, unseen };
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
    clearBody();
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

  /**
   * Sit just above the editor's toolbar, wherever the site or the dev server
   * put it, and lift notices above the panel so none covers it.
   */
  function place() {
    if (!dock) return;
    const toolbar = document.querySelector('.cms-toolbar-inner') ?? document.querySelector('.cms-toolbar');
    const top = toolbar?.getBoundingClientRect().top ?? window.innerHeight;
    dock.style.bottom = `${Math.max(12, window.innerHeight - top + 10)}px`;
    const toasts = /** @type {HTMLElement | null} */ (document.querySelector('.cms-toast-stack'));
    if (toasts) toasts.style.bottom = `${window.innerHeight - dock.getBoundingClientRect().top + 10}px`;
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
    /** @type {HTMLElement | null} */ (document.querySelector('.cms-toast-stack'))?.style.removeProperty('bottom');
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
    const viewAt = at => [...bound.map(item => comparable(displayAt(item, histories, at))),
      ...[...histories.values()].map(history => bodyAt(history, at) ?? '')].join('\u0000');
    // Stops: just before each change, oldest first, then now. A stop that looks
    // the same on this page as the next one (the change was to something this
    // page doesn't show), or the same as the page does now, is left out.
    const moments = [...new Set([...histories.values()].flatMap(history => history.items.map(item => item.ts)))].sort((a, b) => a - b);
    const all = [...moments.map(ts => ({ at: ts - 1, ts })), { at: Number.POSITIVE_INFINITY, ts: Number.POSITIVE_INFINITY }];
    const views = all.map(stop => viewAt(stop.at));
    const nowView = views[views.length - 1];
    const stops = all.filter((stop, index) => index === all.length - 1 || (views[index] !== views[index + 1] && views[index] !== nowView));
    /** When the version that was replaced at `ts` went up: the change before it, or null for the earliest version known. @param {number} ts */
    const startOf = ts => moments.filter(moment => moment < ts).pop() ?? null;
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
    // The track behind the slider: a notch per version, the chosen one larger,
    // and the stretch from it to now filled in. The slider stays the control
    // (keyboard, screen readers); a click on a notch moves it there.
    const timeline = document.createElement('div');
    timeline.className = 'cms-page-history-timeline';
    const track = document.createElement('div');
    track.className = 'cms-page-history-track';
    track.setAttribute('aria-hidden', 'true');
    const span = document.createElement('div');
    span.className = 'cms-page-history-span';
    track.append(span);
    const notches = stops.map((stop, index) => {
      const notch = document.createElement('span');
      notch.className = 'cms-page-history-notch';
      notch.style.left = `${(index / (stops.length - 1)) * 100}%`;
      notch.title = stop.at === Number.POSITIVE_INFINITY ? t('editor.pageHistory.now') : versionDate(stop.ts);
      notch.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        range.value = String(index);
        render();
        range.focus();
      });
      track.append(notch);
      return notch;
    });
    const ends = document.createElement('div');
    ends.className = 'cms-page-history-ends';
    ends.setAttribute('aria-hidden', 'true');
    const oldest = document.createElement('span');
    oldest.textContent = t('editor.pageHistory.oldest');
    const newest = document.createElement('span');
    newest.textContent = t('editor.pageHistory.now');
    ends.append(oldest, newest);
    timeline.append(track, range, ends);
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
    dock.append(label, timeline, actions);
    document.body.append(dock);
    place();
    makeRoom();
    window.addEventListener('resize', place);

    const heading = document.createElement('span');
    heading.className = 'cms-page-history-heading';
    const title = document.createElement('strong');
    const when = document.createElement('span');
    when.className = 'cms-page-history-when';
    heading.append(title, when);
    const detail = document.createElement('span');
    detail.className = 'cms-page-history-detail';
    label.append(heading, detail);
    function render() {
      const index = Number(range.value);
      const stop = stops[index];
      const now = stop.at === Number.POSITIVE_INFINITY;
      const since = now ? null : startOf(stop.ts);
      title.textContent = now ? t('editor.pageHistory.current') : t('editor.pageHistory.version', { index: index + 1, count: stops.length });
      when.textContent = now ? '' : since === null ? t('editor.pageHistory.earliest') : t('editor.pageHistory.since', { date: versionDate(since) });
      notches.forEach((notch, at) => {
        notch.classList.toggle('is-chosen', at === index);
        notch.classList.toggle('is-between', at > index);
      });
      span.style.left = `${(index / (stops.length - 1)) * 100}%`;
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
      const textDiffers = !now && [...histories.values()].some(history => bodyAt(history, stop.at) !== null);
      const body = now ? { differences: 0, unseen: false } : showBody(histories, stop.at);
      differences += body.differences;
      detail.textContent = now ? t(stops.length === 2 ? 'editor.pageHistory.dragHintOne' : 'editor.pageHistory.dragHintOther', { count: stops.length - 1 })
        : [
          body.unseen && differences === 0 ? t('editor.pageHistory.textUnseen', { date: versionDate(stop.ts) })
            : t(differences === 1 ? 'editor.pageHistory.differencesOne' : 'editor.pageHistory.differencesOther', { count: differences, date: versionDate(stop.ts) }),
          ...(body.unseen && differences > 0 ? [t('editor.pageHistory.textUnseenToo')] : []),
          // Body text can't be a draft: restoring it publishes it.
          ...(textDiffers && draftMode ? [t('editor.pageHistory.textPublishes')] : []),
        ].join(' ');
      range.setAttribute('aria-valuetext', now ? title.textContent : `${title.textContent}, ${when.textContent}`);
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
      let textRestored = false;
      try {
        for (const [key, history] of histories) {
          const { items } = history;
          // An earlier body text is restored with its whole source file, as
          // History in the Studio does: published at once, since body text
          // has no draft of a whole version.
          if (bodyAt(history, at) !== null) {
            const [collection, id] = key.split('::');
            const version = items.find(item => item.ts > at);
            const response = await fetch(buildCmsUrl('/history'), { method: 'POST', credentials: 'same-origin', headers: HEADERS,
              body: JSON.stringify({ collection, id, ts: version?.ts, published: true }) });
            if (!response.ok) throw new Error(`Restore failed (${response.status})`);
            restored.push({ collection, id });
            textRestored = true;
            continue;
          }
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
        reload(t(textRestored ? 'editor.pageHistory.restoredText' : draftMode ? 'editor.pageHistory.restored' : 'editor.pageHistory.restoredLive'));
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
