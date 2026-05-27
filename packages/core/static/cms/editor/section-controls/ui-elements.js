import { spacingToken, humanizeSectionKey } from './utils.js';

export function createSectionControlsElement() {
  const controls = document.createElement('div');
  controls.className = 'cms-section-controls';
  controls.innerHTML = `
    <div class="cms-section-controls-actions">
      <button type="button" class="cms-section-btn cms-section-btn-drag" data-action="drag" title="Drag to reorder" draggable="true">Drag</button>
      <button type="button" class="cms-section-btn" data-action="up" title="Move up">Up</button>
      <button type="button" class="cms-section-btn" data-action="down" title="Move down">Down</button>
      <button type="button" class="cms-section-btn" data-action="duplicate" title="Duplicate">Duplicate</button>
      <button type="button" class="cms-section-btn" data-action="delete" title="Delete">Delete</button>
      <button type="button" class="cms-section-btn" data-action="toggle" title="Toggle visibility">Hide</button>
      <button type="button" class="cms-section-btn" data-action="spacing" title="Set vertical spacing">Space</button>
    </div>
  `;
  return controls;
}

export function createSectionBadge(section, order) {
  const badge = document.createElement('div');
  badge.className = 'cms-section-chip';
  badge.textContent = `${order}. ${humanizeSectionKey(section.key)}`;
  return badge;
}

export function createSpacingDragHandle(section) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'cms-section-gap-handle';
  handle.title = 'Drag vertically to resize section spacing';
  handle.dataset.sectionId = section.id;
  handle.innerHTML = `
    <span class="cms-section-gap-grip"></span>
    <span class="cms-section-gap-label">${
      spacingToken(section.spacing_y) === 'default'
        ? 'Y'
        : `Y:${spacingToken(section.spacing_y)}`
    }</span>
  `;
  return handle;
}

export function createInsertHandle() {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'cms-section-insert-handle';
  handle.title = 'Insert section below';
  handle.setAttribute('aria-label', 'Insert section below');
  handle.innerHTML = `
    <span class="cms-section-insert-plus">+</span>
  `;
  return handle;
}
