/**
 * One undo history for every on-page edit (text fields and Markdown blocks):
 * one step per edit (focus to blur), however many autosaves it took. Steps
 * save their old value back through the editor that recorded them.
 */

/**
 * `apply` saves `value` over the `expected` stored one; false when it can't.
 * @typedef {{ el: HTMLElement, edit: number, before: string, after: string,
 *   apply: (value: string, expected: string) => Promise<boolean> }} UndoStep
 */
/** @typedef {{ saved: (options: { message: string, action?: { label: string, onClick: () => void | Promise<void> } }) => unknown }} UndoToast */

/** @type {UndoStep[]} */
const undoSteps = [];
/** @type {UndoStep[]} */
const redoSteps = [];
const UNDO_LIMIT = 50;
/** @type {UndoToast | null} */
let toast = null;
let keysBound = false;

/** Whether a saved on-page edit can be undone. */
export function canUndoLastEdit() {
  return undoSteps.length > 0;
}

export async function undoLastEdit() {
  const step = undoSteps.pop();
  if (!step) return;
  if (await step.apply(step.before, step.after)) {
    redoSteps.push(step);
    toast?.saved({ message: 'Change undone', action: { label: 'Redo', onClick: redoLastEdit } });
  } else {
    undoSteps.push(step);
  }
}

async function redoLastEdit() {
  const step = redoSteps.pop();
  if (!step) return;
  if (await step.apply(step.after, step.before)) {
    undoSteps.push(step);
    toast?.saved({ message: 'Change redone', action: { label: 'Undo', onClick: undoLastEdit } });
  } else {
    redoSteps.push(step);
  }
}

/** The first save of an edit adds its step; later saves of it update `after`. @param {UndoStep} step */
export function recordEdit(step) {
  const top = undoSteps[undoSteps.length - 1];
  if (top && top.el === step.el && top.edit === step.edit) top.after = step.after;
  else {
    undoSteps.push(step);
    if (undoSteps.length > UNDO_LIMIT) undoSteps.shift();
  }
  redoSteps.length = 0;
}

/** Forget an edit's step (it was taken back some other way). @param {HTMLElement} el @param {number} edit */
export function dropEdit(el, edit) {
  const top = undoSteps[undoSteps.length - 1];
  if (top && top.el === el && top.edit === edit) undoSteps.pop();
}

/** ⌘Z / Ctrl+Z undoes the last saved edit when no text field has focus
 * (inside a field the browser's own undo applies). @param {KeyboardEvent} event */
function onUndoKeys(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
  if (!(event.shiftKey ? redoSteps.length : undoSteps.length)) return;
  event.preventDefault();
  void (event.shiftKey ? redoLastEdit() : undoLastEdit());
}

/** @param {UndoToast} showToast */
export function bindUndo(showToast) {
  toast = showToast;
  if (keysBound) return;
  document.addEventListener('keydown', onUndoKeys);
  keysBound = true;
}
