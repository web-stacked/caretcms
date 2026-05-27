import { SPACING_Y_VALUES } from './constants.js';
import { spacingIndex } from './utils.js';

export function createSpacingDragController({
  isBusy,
  isReordering,
  closePickers,
  getSectionSpacing,
  updateSpacingByToken,
  setActiveSection,
  onCommitted,
}) {
  let dragState = null;

  function stop() {
    if (!dragState) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    document.body.classList.remove('cms-spacing-dragging');
    dragState.handle.classList.remove('is-dragging');
    dragState = null;
  }

  function start(event, sectionId, handle) {
    if (isBusy()) return;

    event.preventDefault();
    event.stopPropagation();
    setActiveSection(sectionId);
    closePickers();

    const currentSpacing = getSectionSpacing(sectionId);
    dragState = {
      sectionId,
      startY: event.clientY,
      startIndex: spacingIndex(currentSpacing),
      currentIndex: spacingIndex(currentSpacing),
      changed: false,
      handle,
    };

    handle.classList.add('is-dragging');
    document.body.classList.add('cms-spacing-dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd, { once: true });
    window.addEventListener('pointercancel', onEnd, { once: true });
  }

  function onMove(event) {
    if (!dragState || isBusy() || isReordering()) return;

    const delta = event.clientY - dragState.startY;
    const step = Math.round(delta / 56);
    const nextIndex = Math.max(
      0,
      Math.min(SPACING_Y_VALUES.length - 1, dragState.startIndex + step),
    );

    if (nextIndex === dragState.currentIndex) return;

    dragState.currentIndex = nextIndex;
    dragState.changed = true;
    const nextToken = SPACING_Y_VALUES[nextIndex];
    updateSpacingByToken(dragState.sectionId, nextToken);
  }

  function onEnd() {
    if (!dragState) return;
    const changed = dragState.changed;
    const sectionId = dragState.sectionId;
    stop();
    if (changed) {
      onCommitted(sectionId);
    }
  }

  return {
    start,
    stop,
    isDragging: () => dragState !== null,
  };
}
