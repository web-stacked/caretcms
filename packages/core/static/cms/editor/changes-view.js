import { parseCaretAttr, resolveBinding } from './helpers.js';
import { t } from './i18n.js';
import { changedPart } from './text-diff.js';
import { buildChangeCard, placeChangeCard } from './change-card.js';

/** @typedef {import('./draft-client.js').DraftEntryChanges} DraftEntryChanges */
/** @typedef {import('./draft-client.js').DraftFieldChange} DraftFieldChange */
/** @typedef {{ entry: DraftEntryChanges, change: DraftFieldChange, el: Element }} FieldChange A changed field. */
/** @typedef {{ body: true, el: Element, was: string | null }} BodyChange Body text the editor changed; `was` is the published text when the page knows it. */
/** @typedef {FieldChange | BodyChange} PageChange */

/** What an element's HTML reads as. @param {string} html */
function textOf(html) {
  return (new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Body-text blocks on this page that show the editor's unpublished edit. The
 * page as the server renders it now says which (`data-caret-md-draft`), so an
 * edit made or undone since the page loaded is counted correctly.
 * @returns {Promise<BodyChange[]>}
 */
async function bodyChangesOnPage() {
  if (!document.querySelector('[data-caret-md]')) return [];
  /** @type {Document} */
  let fresh;
  try {
    const response = await fetch(window.location.href, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return [];
    fresh = new DOMParser().parseFromString(await response.text(), 'text/html');
  } catch {
    return [];
  }
  /** @type {BodyChange[]} */
  const found = [];
  const taken = new Set();
  fresh.querySelectorAll('[data-caret-md][data-caret-md-draft]').forEach((draft) => {
    const binding = draft.getAttribute('data-caret-md') || '';
    const el = blockOnPage(binding);
    if (!el || taken.has(el)) return;
    taken.add(el);
    const original = draft.getAttribute('data-caret-md-original');
    found.push({ body: true, el, was: original === null ? null : textOf(original) });
  });
  return found;
}

/**
 * The element on the live page for a body block. Paragraphs the editor grouped
 * into one editable host lost their own binding, so look the block up in the
 * host's sources.
 * @param {string} binding `collection::id::body::path`
 */
function blockOnPage(binding) {
  const direct = document.querySelector(`[data-caret-md="${CSS.escape(binding)}"]:not([data-caret-md-sources])`);
  if (direct) return direct;
  const path = binding.split('::')[3];
  const prefix = binding.split('::').slice(0, 3).join('::');
  for (const host of document.querySelectorAll('[data-caret-md-sources]')) {
    if (!(host.getAttribute('data-caret-md') || '').startsWith(`${prefix}::`)) continue;
    try {
      const sources = /** @type {{ blockPath: string }[]} */ (JSON.parse(host.getAttribute('data-caret-md-sources') || '[]'));
      const index = sources.findIndex(source => source.blockPath === path);
      if (index >= 0) return host.children[index] ?? host;
    } catch { /* not a host this page can read */ }
  }
  return null;
}


/**
 * The Changes view: a dot beside every element on the page whose content the
 * editor changed in a draft, or that changed on the site since the draft was
 * started. A dot opens a card with both values and what can be done.
 *
 * @param {{
 *   getChanges: () => Promise<DraftEntryChanges[]>,
 *   revertField: (collection: string, id: string, field: string) => Promise<void>,
 *   settleConflicts: () => void | Promise<void>,
 *   onReverted: () => void,
 *   onError: (message: string) => void,
 * }} options
 */
export function createChangesView(options) {
  /** @type {HTMLDivElement | null} */
  let layer = null;
  /** @type {HTMLDivElement | null} */
  let card = null;
  /** @type {PageChange[]} */
  let shown = [];
  let on = false;

  /** Field changes whose element is on this page. @param {DraftEntryChanges[]} entries */
  function onPage(entries) {
    /** @type {FieldChange[]} */
    const found = [];
    const seen = new Set();
    document.querySelectorAll('[data-caret]').forEach((el) => {
      const bound = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
      if (!bound) return;
      const entry = entries.find(candidate => candidate.collection === bound.collection && candidate.id === bound.id);
      // The element's own value, or the list or group it belongs to when that changed as a whole
      // (an item added or removed): then the first element inside it carries the dot.
      const change = entry?.changes.find(candidate => candidate.field === bound.field)
        ?? entry?.changes.find(candidate => bound.field.startsWith(`${candidate.field}.`));
      const key = `${bound.collection}::${bound.id}::${change?.field}`;
      if (!entry || !change || seen.has(key)) return;
      seen.add(key);
      found.push({ entry, change, el });
    });
    return found;
  }

  function closeCard() {
    card?.remove();
    card = null;
    layer?.querySelectorAll('.cms-change-dot[aria-expanded="true"]').forEach(dot => dot.setAttribute('aria-expanded', 'false'));
  }

  /** @param {PageChange} item @param {HTMLButtonElement} dot */
  function openCard(item, dot) {
    closeCard();
    if ('body' in item) {
      const now = (item.el.textContent || '').replace(/\s+/g, ' ').trim();
      const part = item.was === null ? null : changedPart(item.was, now);
      card = buildChangeCard({
        label: t('editor.changes.bodyLabel'),
        title: t('editor.changes.mine'),
        tone: 'mine',
        rows: part ? [[t('editor.changes.siteValue'), part.before || t('editor.conflict.empty')], [t('editor.changes.yours'), part.after || t('editor.conflict.empty')]] : [],
        note: t('editor.changes.bodyNote'),
        actions: [{ label: t('editor.changes.close'), primary: true, run: closeCard }],
      });
      document.body.append(card);
      dot.setAttribute('aria-expanded', 'true');
      placeChangeCard(card, item.el, dot.getBoundingClientRect().left);
      /** @type {HTMLElement | null} */ (card.querySelector('button'))?.focus();
      return;
    }
    const { entry, change, el } = item;
    const empty = t('editor.conflict.empty');
    const theirs = changedPart(change.site, change.mine);
    const moved = changedPart(change.started, change.site);
    const undo = async () => {
      try {
        await options.revertField(entry.collection, entry.id, change.field);
        options.onReverted();
      } catch {
        options.onError(t('editor.changes.failed'));
      }
    };
    card = buildChangeCard({
      label: change.label,
      title: t(`editor.changes.${change.kind}`),
      tone: change.kind,
      rows: change.kind === 'site'
        ? [[t('editor.changes.was'), moved.before || empty], [t('editor.changes.now'), moved.after || empty]]
        : [[t('editor.changes.siteValue'), theirs.before || empty], [t('editor.changes.yours'), theirs.after || empty]],
      actions: change.kind === 'mine'
        ? [{ label: t('editor.changes.close'), run: closeCard }, { label: t('editor.changes.undo'), primary: true, run: () => void undo() }]
        : change.kind === 'site'
          ? [{ label: t('editor.changes.close'), primary: true, run: closeCard }]
          : [{ label: t('editor.changes.close'), run: closeCard },
            { label: t('editor.changes.choose'), primary: true, run: () => { closeCard(); void options.settleConflicts(); } }],
    });
    document.body.append(card);
    dot.setAttribute('aria-expanded', 'true');
    placeChangeCard(card, el, dot.getBoundingClientRect().left);
    /** @type {HTMLElement | null} */ (card.querySelector('button'))?.focus();
  }

  function place() {
    if (!layer) return;
    const dots = /** @type {HTMLButtonElement[]} */ ([...layer.querySelectorAll('.cms-change-dot')]);
    dots.forEach((dot, index) => {
      const item = shown[index];
      if (!item) return;
      const box = item.el.getBoundingClientRect();
      dot.hidden = box.width === 0 && box.height === 0;
      dot.style.left = `${Math.max(2, box.left + window.scrollX - 18)}px`;
      dot.style.top = `${box.top + window.scrollY + Math.min(box.height / 2, 14) - 7}px`;
    });
  }

  function clear() {
    closeCard();
    layer?.remove();
    layer = null;
    shown = [];
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey);
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.key === 'Escape' && card) closeCard();
  }

  /** @param {DraftEntryChanges[]} entries @param {BodyChange[]} body */
  function draw(entries, body) {
    clear();
    shown = [...onPage(entries), ...body];
    layer = document.createElement('div');
    layer.className = 'cms-change-layer';
    layer.setAttribute('data-caret-ui', '');
    for (const item of shown) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `cms-change-dot cms-change-${'body' in item ? 'mine' : item.change.kind}`;
      dot.setAttribute('aria-label', t('editor.changes.dot', { label: 'body' in item ? t('editor.changes.bodyLabel') : item.change.label }));
      dot.setAttribute('aria-expanded', 'false');
      dot.addEventListener('click', () => (dot.getAttribute('aria-expanded') === 'true' ? closeCard() : openCard(item, dot)));
      layer.append(dot);
    }
    document.body.append(layer);
    place();
    window.addEventListener('resize', place);
    document.addEventListener('keydown', onKey);
  }

  /** Turn the view on or off. Returns how many changes are marked on this page, or null when the list couldn't be read. */
  async function toggle() {
    if (on) { on = false; clear(); return 0; }
    try {
      const [entries, body] = await Promise.all([options.getChanges(), bodyChangesOnPage()]);
      draw(entries, body);
      on = true;
      return shown.length;
    } catch {
      return null;
    }
  }

  return {
    toggle,
    isOn: () => on,
    hide: () => { on = false; clear(); },
    /** How many elements on this page the view would mark. @param {DraftEntryChanges[]} entries */
    countOnPage: async (entries) => onPage(entries).length + (await bodyChangesOnPage()).length,
  };
}
