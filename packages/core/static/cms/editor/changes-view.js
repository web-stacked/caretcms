import { parseCaretAttr, resolveBinding } from './helpers.js';
import { t } from './i18n.js';
import { changedPart } from './text-diff.js';

/** @typedef {import('./draft-client.js').DraftEntryChanges} DraftEntryChanges */
/** @typedef {import('./draft-client.js').DraftFieldChange} DraftFieldChange */
/** @typedef {{ entry: DraftEntryChanges, change: DraftFieldChange, el: Element }} PageChange */

const MARGIN = 8;

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

  /** @param {string} label @param {string} value */
  function row(label, value) {
    const line = document.createElement('div');
    line.className = 'cms-change-row';
    const name = document.createElement('span');
    name.textContent = label;
    const text = document.createElement('strong');
    text.textContent = value || t('editor.conflict.empty');
    line.append(name, text);
    return line;
  }

  /** @param {string} label @param {boolean} primary @param {() => void} run */
  function action(label, primary, run) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (primary) button.className = 'cms-change-primary';
    button.addEventListener('click', run);
    return button;
  }

  /** @param {PageChange} item @param {HTMLButtonElement} dot */
  function openCard(item, dot) {
    closeCard();
    const { entry, change } = item;
    card = document.createElement('div');
    card.className = 'cms-change-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', change.label);
    const title = document.createElement('p');
    title.className = `cms-change-title cms-change-${change.kind}`;
    title.textContent = t(`editor.changes.${change.kind}`);
    const actions = document.createElement('div');
    actions.className = 'cms-change-actions';
    const theirs = changedPart(change.site, change.mine);
    if (change.kind === 'mine') {
      card.append(title, row(t('editor.changes.siteValue'), theirs.before), row(t('editor.changes.yours'), theirs.after));
      actions.append(action(t('editor.changes.close'), false, closeCard), action(t('editor.changes.undo'), true, async () => {
        try {
          await options.revertField(entry.collection, entry.id, change.field);
          options.onReverted();
        } catch {
          options.onError(t('editor.changes.failed'));
        }
      }));
    } else if (change.kind === 'site') {
      const moved = changedPart(change.started, change.site);
      card.append(title, row(t('editor.changes.was'), moved.before), row(t('editor.changes.now'), moved.after));
      actions.append(action(t('editor.changes.close'), true, closeCard));
    } else {
      card.append(title, row(t('editor.changes.siteValue'), theirs.before), row(t('editor.changes.yours'), theirs.after));
      actions.append(action(t('editor.changes.close'), false, closeCard),
        action(t('editor.changes.choose'), true, () => { closeCard(); void options.settleConflicts(); }));
    }
    card.append(actions);
    layer?.append(card);
    dot.setAttribute('aria-expanded', 'true');
    const at = dot.getBoundingClientRect();
    const width = card.offsetWidth;
    const left = Math.max(MARGIN, Math.min(at.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - width - MARGIN));
    card.style.left = `${left}px`;
    // Below the element, unless that reaches the editor's toolbar at the bottom of the window: then above it.
    const element = item.el.getBoundingClientRect();
    const toolbarTop = document.querySelector('.cms-toolbar')?.getBoundingClientRect().top ?? window.innerHeight;
    const room = Math.min(window.innerHeight, toolbarTop) - MARGIN;
    const below = Math.max(at.bottom, element.bottom) + MARGIN;
    const top = below + card.offsetHeight > room && element.top - MARGIN - card.offsetHeight >= 0
      ? element.top - MARGIN - card.offsetHeight
      : below;
    card.style.top = `${top + window.scrollY}px`;
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

  return { toggle, isOn: () => on, hide: () => { on = false; clear(); } };
}
