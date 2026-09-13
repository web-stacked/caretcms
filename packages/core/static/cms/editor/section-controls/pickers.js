import { HOME_SECTION_KEYS, SPACING_Y_OPTIONS } from './constants.js';
import { humanizeSectionKey } from './utils.js';

/**
 * @param {{ picker: HTMLElement, getAnchor: () => HTMLButtonElement | null }} options
 * @returns {() => void}
 */
function attachGlobalPositioning({ picker, getAnchor }) {
  function position() {
    const anchorButton = getAnchor();
    if (!anchorButton || picker.hidden) return;

    const rect = anchorButton.getBoundingClientRect();
    const pickerRect = picker.getBoundingClientRect();

    let left = rect.left;
    if (left + pickerRect.width > window.innerWidth - 12) {
      left = window.innerWidth - pickerRect.width - 12;
    }
    if (left < 12) left = 12;

    const viewportMargin = 12;
    const gap = 8;
    const toolbar = document.querySelector('.cms-toolbar');
    const toolbarRect = toolbar instanceof HTMLElement ? toolbar.getBoundingClientRect() : null;
    const lowerBoundary = toolbarRect && toolbarRect.top > 0 && toolbarRect.top < window.innerHeight
      ? Math.min(window.innerHeight - viewportMargin, toolbarRect.top - gap)
      : window.innerHeight - viewportMargin;
    const spaceBelow = lowerBoundary - rect.bottom - gap;
    const spaceAbove = rect.top - viewportMargin - gap;
    const top = pickerRect.height <= spaceBelow || spaceBelow >= spaceAbove
      ? rect.bottom + gap
      : Math.max(viewportMargin, rect.top - pickerRect.height - gap);
    picker.style.left = `${Math.round(left)}px`;
    picker.style.top = `${Math.round(top)}px`;
  }

  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  return position;
}

/**
 * @param {{ picker: HTMLElement, getAnchor: () => HTMLButtonElement | null, close: () => void }} options
 */
function attachOutsideClose({ picker, getAnchor, close }) {
  document.addEventListener('click', (event) => {
    if (picker.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;

    const anchorButton = getAnchor();
    if (picker.contains(target)) return;
    if (anchorButton && anchorButton.contains(target)) return;
    close();
  });
}

/** @param {{ onPick: (sectionId: string, key: string) => void }} options */
export function createAddPicker({ onPick }) {
  const picker = document.createElement('div');
  picker.id = 'cms-section-add-picker';
  picker.className = 'cms-section-add-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Insert section');
  picker.hidden = true;
  picker.innerHTML = `
    <div class="cms-section-add-picker-head">Insert Section</div>
    <div class="cms-section-add-picker-list"></div>
  `;

  const list = picker.querySelector('.cms-section-add-picker-list');
  HOME_SECTION_KEYS.forEach((key) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cms-section-add-option';
    btn.dataset.key = key;
    btn.textContent = humanizeSectionKey(key);
    list?.appendChild(btn);
  });

  document.body.appendChild(picker);

  /** @type {string | null} */
  let openForSectionId = null;
  /** @type {HTMLButtonElement | null} */
  let anchorButton = null;

  function close() {
    anchorButton?.setAttribute('aria-expanded', 'false');
    picker.hidden = true;
    picker.classList.remove('open');
    openForSectionId = null;
    anchorButton = null;
  }

  const position = attachGlobalPositioning({
    picker,
    getAnchor: () => anchorButton,
  });

  /** @param {HTMLButtonElement} button @param {string} sectionId */
  function open(button, sectionId) {
    anchorButton = button;
    openForSectionId = sectionId;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', picker.id);
    button.setAttribute('aria-expanded', 'true');
    picker.hidden = false;
    picker.classList.add('open');
    position();
    const firstButton = picker.querySelector('button');
    if (firstButton instanceof HTMLButtonElement) firstButton.focus();
  }

  picker.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    const previousAnchor = anchorButton;
    close();
    previousAnchor?.focus();
  });

  picker.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const option = target.closest('.cms-section-add-option');
    if (!(option instanceof HTMLButtonElement)) return;

    const key = option.dataset.key;
    if (!openForSectionId || !key) return;
    onPick(openForSectionId, key);
    close();
  });

  attachOutsideClose({
    picker,
    getAnchor: () => anchorButton,
    close,
  });

  return {
    open,
    close,
    /** @param {boolean} disabled */
    setDisabled(disabled) {
      picker.querySelectorAll('.cms-section-add-option').forEach((button) => {
        if (button instanceof HTMLButtonElement) button.disabled = disabled;
      });
    },
  };
}

/** @param {{ onPick: (sectionId: string, value: string) => void }} options */
export function createSpacingPicker({ onPick }) {
  const picker = document.createElement('div');
  picker.id = 'cms-section-spacing-picker';
  picker.className = 'cms-section-add-picker cms-section-spacing-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Vertical spacing');
  picker.hidden = true;
  picker.innerHTML = `
    <div class="cms-section-add-picker-head">Vertical Spacing</div>
    <div class="cms-section-add-picker-list"></div>
  `;

  const list = picker.querySelector('.cms-section-add-picker-list');
  SPACING_Y_OPTIONS.forEach((option) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cms-section-add-option';
    btn.dataset.value = option.value;
    btn.textContent = option.label;
    list?.appendChild(btn);
  });

  document.body.appendChild(picker);

  /** @type {string | null} */
  let openForSectionId = null;
  /** @type {HTMLButtonElement | null} */
  let anchorButton = null;

  function close() {
    anchorButton?.setAttribute('aria-expanded', 'false');
    picker.hidden = true;
    picker.classList.remove('open');
    openForSectionId = null;
    anchorButton = null;
  }

  const position = attachGlobalPositioning({
    picker,
    getAnchor: () => anchorButton,
  });

  /** @param {HTMLButtonElement} button @param {string} sectionId @param {unknown} currentValue */
  function open(button, sectionId, currentValue) {
    anchorButton = button;
    openForSectionId = sectionId;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', picker.id);
    button.setAttribute('aria-expanded', 'true');
    picker.hidden = false;
    picker.classList.add('open');

    picker.querySelectorAll('.cms-section-add-option').forEach((item) => {
      item.classList.toggle(
        'active',
        (item instanceof HTMLButtonElement ? item.dataset.value : null) ===
          (currentValue || 'default'),
      );
    });

    position();
    const selectedButton = picker.querySelector('button.active, button');
    if (selectedButton instanceof HTMLButtonElement) selectedButton.focus();
  }

  picker.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    const previousAnchor = anchorButton;
    close();
    previousAnchor?.focus();
  });

  picker.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const option = target.closest('.cms-section-add-option');
    if (!(option instanceof HTMLButtonElement)) return;

    const value = option.dataset.value;
    if (!openForSectionId || !value) return;
    onPick(openForSectionId, value);
    close();
  });

  attachOutsideClose({
    picker,
    getAnchor: () => anchorButton,
    close,
  });

  return {
    open,
    close,
    /** @param {boolean} disabled */
    setDisabled(disabled) {
      picker.querySelectorAll('.cms-section-add-option').forEach((button) => {
        if (button instanceof HTMLButtonElement) button.disabled = disabled;
      });
    },
  };
}
