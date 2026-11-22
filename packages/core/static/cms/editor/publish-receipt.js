import { t } from './i18n.js';

/** @typedef {import('./draft-client.js').PendingDraft} PendingDraft */

const MAX_LINES = 3;

/**
 * The list shown in the Publish dialog: each draft by name with what it
 * changes, and a checkbox per draft when there is more than one, so some can
 * be published now and the rest kept as drafts.
 *
 * @param {PendingDraft[]} pending
 * @param {(chosen: number) => void} onChange Called with how many drafts are ticked.
 */
export function buildPublishReceipt(pending, onChange) {
  const list = document.createElement('ul');
  list.className = 'cms-receipt';
  /** @type {HTMLInputElement[]} */
  const boxes = [];
  pending.forEach((entry, index) => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    if (pending.length > 1) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.id = `cms-receipt-${index}`;
      box.addEventListener('change', () => onChange(boxes.filter(candidate => candidate.checked).length));
      boxes.push(box);
      label.append(box);
    }
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = entry.title || entry.id;
    text.append(name);
    const lines = entry.deleted ? [t('editor.receipt.deleted')] : [
      ...entry.fields.map(field => t('editor.receipt.field', { label: field.label,
        site: field.site || t('editor.conflict.empty'), mine: field.mine || t('editor.conflict.empty') })),
      ...(entry.text ? [t('editor.receipt.text')] : []),
    ];
    const shown = lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), t('editor.receipt.more', { count: lines.length - (MAX_LINES - 1) })] : lines;
    for (const line of shown.length ? shown : [t('editor.receipt.changed')]) {
      const detail = document.createElement('small');
      detail.textContent = line;
      text.append(detail);
    }
    label.append(text);
    item.append(label);
    list.append(item);
  });

  return {
    element: list,
    /** The ticked drafts, or null when every draft is ticked. */
    chosen() {
      if (boxes.length === 0 || boxes.every(box => box.checked)) return null;
      return pending.filter((_, index) => boxes[index].checked).map(({ collection, id }) => ({ collection, id }));
    },
  };
}
