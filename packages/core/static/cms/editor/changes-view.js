import { parseCaretAttr, resolveBinding } from './helpers.js';
import { t } from './i18n.js';
import { changedPart } from './text-diff.js';
import { buildChangeCard, placeChangeCard } from './change-card.js';

/** @typedef {import('./draft-client.js').DraftEntryChanges} DraftEntryChanges */
/** @typedef {import('./draft-client.js').DraftFieldChange} DraftFieldChange */
/** @typedef {{ entry: DraftEntryChanges, change: DraftFieldChange, el: Element }} PageChange */


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

  /** Changes whose element is on this page. @param {DraftEntryChanges[]} entries */
  function onPage(entries) {
    /** @type {PageChange[]} */
    const found = [];
    const seen = new Set();
    document.querySelectorAll('[data-caret]').forEach((el) => {
      const bound = resolveBinding(el, parseCaretAttr(el.getAttribute('data-caret') || ''));
      if (!bound) return;
      const entry = entries.find(candidate => candidate.collection === bound.collection && candidate.id === bound.id);
      const change = entry?.changes.find(candidate => candidate.field === bound.field);
      const key = `${bound.collection}::${bound.id}::${bound.field}`;
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

  /** @param {DraftEntryChanges[]} entries */
  function draw(entries) {
    clear();
    shown = onPage(entries);
    layer = document.createElement('div');
    layer.className = 'cms-change-layer';
    layer.setAttribute('data-caret-ui', '');
    for (const item of shown) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `cms-change-dot cms-change-${item.change.kind}`;
      dot.setAttribute('aria-label', t('editor.changes.dot', { label: item.change.label }));
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
      draw(await options.getChanges());
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
    countOnPage: (entries) => onPage(entries).length,
  };
}
