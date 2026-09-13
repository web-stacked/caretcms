import { reorderByDrag } from './model.js';

/** @typedef {import('./model.js').Section} Section */

/**
 * @param {{
 *   controls: HTMLElement,
 *   sectionId: string,
 *   sectionNode: HTMLElement,
 *   setDragSourceId: (sectionId: string | null) => void,
 *   clearDropIndicators: () => void,
 * }} options
 */
export function bindDragSourceHandlers({
  controls,
  sectionId,
  sectionNode,
  setDragSourceId,
  clearDropIndicators,
}) {
  controls.addEventListener('dragstart', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const dragHandle = target.closest('.cms-section-btn-drag');
    if (!(dragHandle instanceof HTMLButtonElement)) return;

    setDragSourceId(sectionId);
    sectionNode.classList.add('cms-section-drag-source');
    document.body.classList.add('cms-section-dragging');

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', sectionId);
    }
  });

  controls.addEventListener('dragend', () => {
    setDragSourceId(null);
    clearDropIndicators();
  });
}

/**
 * @param {{
 *   sectionNode: HTMLElement,
 *   sectionId: string,
 *   isBusy: () => boolean,
 *   getDragSourceId: () => string | null,
 *   getSections: () => Section[],
 *   setSections: (sections: Section[]) => void,
 *   clearDropIndicators: () => void,
 *   onReordered: () => void,
 * }} options
 */
export function bindDropTargetHandlers({
  sectionNode,
  sectionId,
  isBusy,
  getDragSourceId,
  getSections,
  setSections,
  clearDropIndicators,
  onReordered,
}) {
  sectionNode.addEventListener('dragover', (event) => {
    const dragSourceId = getDragSourceId();
    if (!dragSourceId || isBusy()) return;
    if (dragSourceId === sectionId) return;

    event.preventDefault();
    const rect = sectionNode.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;

    sectionNode.classList.add('cms-section-drop-target');
    sectionNode.classList.toggle('cms-section-drop-before', !placeAfter);
    sectionNode.classList.toggle('cms-section-drop-after', placeAfter);
    sectionNode.dataset.dropPosition = placeAfter ? 'after' : 'before';

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  });

  sectionNode.addEventListener('dragleave', (event) => {
    const related = event.relatedTarget;
    if (related instanceof Node && sectionNode.contains(related)) return;
    sectionNode.classList.remove(
      'cms-section-drop-target',
      'cms-section-drop-before',
      'cms-section-drop-after',
    );
    delete sectionNode.dataset.dropPosition;
  });

  sectionNode.addEventListener('drop', (event) => {
    const dragSourceId = getDragSourceId();
    if (!dragSourceId || isBusy()) return;
    if (dragSourceId === sectionId) return;

    event.preventDefault();
    const placeAfter = sectionNode.dataset.dropPosition === 'after';
    const currentSections = getSections();
    const nextSections = reorderByDrag({
      sections: currentSections,
      sourceId: dragSourceId,
      targetId: sectionId,
      placeAfter,
    });

    clearDropIndicators();
    if (nextSections === currentSections) return;
    setSections(nextSections);
    onReordered();
  });
}
