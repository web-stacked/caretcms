import { parseCaretAttr, resolveBinding } from './helpers.js';
import { t } from './i18n.js';
import { changedPart } from './text-diff.js';
import { buildChangeCard, placeChangeCard } from './change-card.js';

/**
 * "Since you were last here": what the editor saw on a page is remembered in
 * their browser. On the next visit, content that differs and isn't their own
 * draft is announced, and a short tour steps through each change.
 *
 * Kept in localStorage, so it works with every storage adapter and delivery
 * mode, and belongs to this browser like the editor's drafts do.
 */

const PREFIX = 'caret:seen:v1:';
const MAX_TEXT = 200;
const MAX_ITEMS = 400;

/** @typedef {{ h: string, t: string, own?: true }} Seen What an element showed: a hash of all of it, the start of its text, and whether that was the editor's own unpublished edit. */
/** @typedef {{ key: string, el: Element, image: boolean, was: string, now: string }} AwayChange */

/** @param {string} text */
function hash(text) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}

/** What an element shows: an image's address, or its text with whitespace collapsed. @param {Element} el */
function shownBy(el) {
  if (el instanceof HTMLImageElement) return el.getAttribute('src') || '';
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Every bound element on the page by binding key; the first element wins for a binding shown twice. */
function bindingsOnPage() {
  /** @type {Map<string, Element>} */
  const found = new Map();
  document.querySelectorAll('[data-caret]').forEach((el) => {
    const bound = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
    if (!bound) return;
    const key = `${bound.collection}::${bound.id}::${bound.field}`;
    if (!found.has(key) && found.size < MAX_ITEMS) found.set(key, el);
  });
  return found;
}

function storageKey() {
  return PREFIX + window.location.pathname;
}

/** @returns {{ at: number, items: Record<string, Seen> } | null} */
function readSeen() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey()) || 'null');
    return stored && typeof stored.at === 'number' && stored.items && typeof stored.items === 'object' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Remember what the page shows now. Bindings in `keep` hold on to what was
 * remembered before, so a change the editor hasn't looked at is announced again.
 * Bindings in `own` show the editor's own unpublished edit: what they show next
 * time (published, undone or discarded) is the editor's doing, not news.
 * @param {Set<string>} keep
 * @param {number | null} keepAt The time to keep while something is still unannounced.
 * @param {Set<string>} own
 */
function writeSeen(keep, keepAt, own) {
  const before = readSeen();
  /** @type {Record<string, Seen>} */
  const items = {};
  for (const [key, el] of bindingsOnPage()) {
    const text = shownBy(el);
    items[key] = keep.has(key) && before?.items[key] ? before.items[key]
      : { h: hash(text), t: text.slice(0, MAX_TEXT), ...(own.has(key) ? { own: /** @type {const} */ (true) } : {}) };
  }
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ at: keep.size && keepAt ? keepAt : Date.now(), items }));
  } catch {
    /* storage is full or blocked: nothing is announced next time */
  }
}

/**
 * @param {{
 *   showToast: import('./toast.js').ToastController,
 *   ownChanges: () => Promise<Set<string>>,
 * }} options `ownChanges` returns the binding keys the editor changed in a draft.
 */
export function mountAwayNotice(options) {
  /** Changes not yet looked at. @type {AwayChange[]} */
  let waiting = [];
  /** @type {number | null} */
  let since = null;
  /** @type {Element | null} */
  let spotlit = null;
  /** The bindings holding the editor's own unpublished edits, as last read. @type {Set<string>} */
  let own = new Set();
  async function readOwn() {
    try { own = await options.ownChanges(); } catch { /* keep the last known set */ }
    return own;
  }

  function spotlight(/** @type {Element | null} */ el) {
    spotlit?.classList.remove('cms-away-spot');
    spotlit = el;
    if (!el) return;
    el.classList.add('cms-away-spot');
    el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  /** The card of the tour step on screen. @type {HTMLElement | null} */
  let card = null;
  function closeCard() {
    card?.remove();
    card = null;
    document.removeEventListener('keydown', onKey, true);
  }
  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); finish(); }
  }

  function finish() {
    closeCard();
    spotlight(null);
    waiting = [];
    writeSeen(new Set(), null, own);
  }

  /** What a text said and says now, cut down to the part that changed. @param {AwayChange} change */
  function shortened(change) {
    const { before, after } = changedPart(change.was, change.now);
    return { was: before || t('editor.conflict.empty'), now: after || t('editor.conflict.empty') };
  }

  /** Step `index` of the tour: the element outlined, and a card beside it with what it said and says now. @param {number} index */
  function step(index) {
    const change = waiting[index];
    if (!change) { finish(); return; }
    closeCard();
    spotlight(change.el);
    const position = { index: index + 1, count: waiting.length };
    const last = index === waiting.length - 1;
    const { was, now } = shortened(change);
    card = buildChangeCard({
      label: t('editor.away.stepLabel', position),
      title: waiting.length === 1 ? t('editor.away.stepTitleOnly') : t('editor.away.stepTitle', position),
      tone: 'site',
      rows: change.image ? [] : [[t('editor.changes.was'), was], [t('editor.changes.now'), now]],
      note: change.image ? t('editor.away.imageReplaced') : undefined,
      actions: [
        // One change needs no way around it: Done is the only step.
        ...(index > 0 ? [{ label: t('editor.away.back'), run: () => step(index - 1) }]
          : waiting.length > 1 ? [{ label: t('editor.away.skip'), run: finish }] : []),
        { label: t(last ? 'editor.away.done' : 'editor.away.next'), primary: true, run: () => step(index + 1) },
      ],
    });
    document.body.append(card);
    // Place it once the element has scrolled into view.
    const place = () => { if (card) placeChangeCard(card, change.el, change.el.getBoundingClientRect().left); };
    place();
    setTimeout(place, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450);
    document.addEventListener('keydown', onKey, true);
    /** @type {HTMLElement | null} */ (card.querySelector('.cms-change-primary'))?.focus({ preventScroll: true });
  }

  async function check() {
    const seen = readSeen();
    await readOwn();
    if (!seen) { writeSeen(new Set(), null, own); return; }
    /** @type {AwayChange[]} */
    const differs = [];
    for (const [key, el] of bindingsOnPage()) {
      const before = seen.items[key];
      const now = shownBy(el);
      // What the editor last saw was their own edit: whatever shows now, they did it.
      if (before && !before.own && before.h !== hash(now)) differs.push({ key, el, image: el instanceof HTMLImageElement, was: before.t, now: now.slice(0, MAX_TEXT) });
    }
    waiting = differs.filter(change => !own.has(change.key));
    since = seen.at;
    if (waiting.length === 0) { writeSeen(new Set(), null, own); return; }
    // Earlier today reads as a time; any other day as a date.
    const then = new Date(seen.at);
    const today = then.toDateString() === new Date().toDateString();
    const locale = document.documentElement.lang || undefined;
    const date = then.toLocaleDateString(locale, { day: 'numeric', month: 'long' });
    const time = then.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    const one = waiting.length === 1;
    options.showToast.notice({
      message: t(today ? (one ? 'editor.away.noticeOneToday' : 'editor.away.noticeOtherToday') : (one ? 'editor.away.noticeOne' : 'editor.away.noticeOther'), { count: waiting.length, date, time }),
      actions: [
        { label: t('editor.away.show'), primary: true, onClick: () => step(0) },
        { label: t('editor.away.dismiss'), onClick: finish },
      ],
    });
  }

  // Leaving the page: remember what is on screen, including the editor's own
  // edits, but keep unannounced changes so they are announced next time.
  window.addEventListener('pagehide', () => writeSeen(new Set(waiting.map(change => change.key)), since, own));
  // A save changes which fields are the editor's own.
  window.addEventListener('cms:draftSaved', () => { void readOwn(); });
  void check();
  return {
    /** Count what these entries show as the editor's own doing (an undone publish), so it isn't announced. @param {{ collection: string, id: string }[]} entries */
    markOwn(entries) {
      const prefixes = entries.map(({ collection, id }) => `${collection}::${id}::`);
      for (const key of bindingsOnPage().keys()) if (prefixes.some(prefix => key.startsWith(prefix))) own.add(key);
    },
  };
}
