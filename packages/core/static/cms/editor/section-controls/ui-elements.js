import { spacingHandleLabel } from './utils.js';
import { t, tHtml } from '../i18n.js';

/** @typedef {import('./model.js').Section} Section */

/** @returns {HTMLDivElement} */
export function createSectionControlsElement() {
  const controls = document.createElement('div');
  controls.className = 'cms-section-controls';
  controls.innerHTML = `
    <div class="cms-section-controls-actions">
      <button type="button" class="cms-section-btn cms-section-btn-drag" data-action="drag" title="${tHtml('editor.sections.dragTitle')}" draggable="true">${tHtml('editor.sections.drag')}</button>
      <button type="button" class="cms-section-btn" data-action="up" title="${tHtml('editor.sections.upTitle')}">${tHtml('editor.sections.up')}</button>
      <button type="button" class="cms-section-btn" data-action="down" title="${tHtml('editor.sections.downTitle')}">${tHtml('editor.sections.down')}</button>
      <details class="cms-section-more">
        <summary class="cms-section-btn">${tHtml('editor.sections.more')}</summary>
        <div class="cms-section-more-menu">
          <button type="button" class="cms-section-btn" data-action="toggle" title="${tHtml('editor.sections.toggleTitle')}">${tHtml('editor.sections.hide')}</button>
          <button type="button" class="cms-section-btn" data-action="spacing" title="${tHtml('editor.sections.spacingTitle')}">${tHtml('editor.sections.spacing')}</button>
          <button type="button" class="cms-section-btn" data-action="duplicate" title="${tHtml('editor.sections.duplicateTitle')}">${tHtml('editor.sections.duplicate')}</button>
          <button type="button" class="cms-section-btn" data-action="delete" title="${tHtml('editor.sections.deleteTitle')}">${tHtml('editor.sections.delete')}</button>
        </div>
      </details>
    </div>
  `;
  return controls;
}

/** @param {number} order @param {string} name the section kind's name @returns {HTMLDivElement} */
export function createSectionBadge(order, name) {
  const badge = document.createElement('div');
  badge.className = 'cms-section-chip';
  badge.textContent = t('editor.sections.chip', { order, name });
  return badge;
}

/** @param {Section} section @returns {HTMLButtonElement} */
export function createSpacingDragHandle(section) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'cms-section-gap-handle';
  handle.title = t('editor.sections.gapTitle');
  handle.setAttribute('aria-label', t('editor.sections.gapLabel'));
  handle.dataset.sectionId = section.id;
  handle.innerHTML = `
    <span class="cms-section-gap-grip"></span>
    <span class="cms-section-gap-label"></span>
  `;
  const label = /** @type {HTMLElement} */ (handle.querySelector('.cms-section-gap-label'));
  label.textContent = spacingHandleLabel(section.spacing_y);
  return handle;
}

/** @returns {HTMLButtonElement} */
export function createInsertHandle() {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'cms-section-insert-handle';
  handle.title = t('editor.sections.insertBelow');
  handle.setAttribute('aria-label', t('editor.sections.insertBelow'));
  handle.innerHTML = `
    <span class="cms-section-insert-plus">+</span>
  `;
  return handle;
}
