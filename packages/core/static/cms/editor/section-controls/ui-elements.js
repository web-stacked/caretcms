import { spacingToken, humanizeSectionKey } from './utils.js';

/** @typedef {import('./model.js').Section} Section */

/** @returns {HTMLDivElement} */
export function createSectionControlsElement() {
  const controls = document.createElement('div');
  controls.className = 'cms-section-controls';
  controls.innerHTML = `
    <div class="cms-section-controls-actions">
      <button type="button" class="cms-section-btn cms-section-btn-drag" data-action="drag" title="Drag to reorder" draggable="true">Drag</button>
      <button type="button" class="cms-section-btn" data-action="up" title="Move up">Up</button>
      <button type="button" class="cms-section-btn" data-action="down" title="Move down">Down</button>
      <details class="cms-section-more">
        <summary class="cms-section-btn">More</summary>
        <div class="cms-section-more-menu">
          <button type="button" class="cms-section-btn" data-action="toggle" title="Toggle visibility">Hide</button>
          <button type="button" class="cms-section-btn" data-action="spacing" title="Set vertical spacing">Spacing</button>
          <button type="button" class="cms-section-btn" data-action="duplicate" title="Duplicate section">Duplicate</button>
          <button type="button" class="cms-section-btn" data-action="delete" title="Delete section">Delete</button>
        </div>
      </details>
    </div>
  `;
  return controls;
}

/** @param {Section} section @param {number} order @returns {HTMLDivElement} */
export function createSectionBadge(section, order) {
  const badge = document.createElement('div');
  badge.className = 'cms-section-chip';
  badge.textContent = `${order}. ${humanizeSectionKey(section.key)}`;
  return badge;
}

/** @param {Section} section @returns {HTMLButtonElement} */
export function createSpacingDragHandle(section) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'cms-section-gap-handle';
  handle.title = 'Drag vertically to resize section spacing';
  handle.setAttribute('aria-label', 'Resize vertical section spacing');
  handle.dataset.sectionId = section.id;
  handle.innerHTML = `
    <span class="cms-section-gap-grip"></span>
    <span class="cms-section-gap-label">${spacingToken(section.spacing_y) === 'default'
      ? 'Default spacing'
      : `${spacingToken(section.spacing_y)} spacing`}</span>
  `;
  return handle;
}

/** @returns {HTMLButtonElement} */
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
