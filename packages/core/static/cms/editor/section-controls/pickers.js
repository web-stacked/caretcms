import { HOME_SECTION_KEYS, SPACING_Y_OPTIONS } from './constants.js';
import { humanizeSectionKey } from './utils.js';

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

    const top = rect.bottom + 8;
    picker.style.left = `${Math.round(left)}px`;
    picker.style.top = `${Math.round(top)}px`;
  }

  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);
  return position;
}

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

export function createAddPicker({ onPick }) {
  const picker = document.createElement('div');
  picker.className = 'cms-section-add-picker';
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

  let openForSectionId = null;
  let anchorButton = null;

  function close() {
    picker.hidden = true;
    picker.classList.remove('open');
    openForSectionId = null;
    anchorButton = null;
  }

  const position = attachGlobalPositioning({
    picker,
    getAnchor: () => anchorButton,
  });

  function open(button, sectionId) {
    anchorButton = button;
    openForSectionId = sectionId;
    picker.hidden = false;
    picker.classList.add('open');
    position();
  }

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
    setDisabled(disabled) {
      picker.querySelectorAll('.cms-section-add-option').forEach((button) => {
        button.disabled = disabled;
      });
    },
  };
}

export function createSpacingPicker({ onPick }) {
  const picker = document.createElement('div');
  picker.className = 'cms-section-add-picker cms-section-spacing-picker';
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

  let openForSectionId = null;
  let anchorButton = null;

  function close() {
    picker.hidden = true;
    picker.classList.remove('open');
    openForSectionId = null;
    anchorButton = null;
  }

  const position = attachGlobalPositioning({
    picker,
    getAnchor: () => anchorButton,
  });

  function open(button, sectionId, currentValue) {
    anchorButton = button;
    openForSectionId = sectionId;
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
  }

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
    setDisabled(disabled) {
      picker.querySelectorAll('.cms-section-add-option').forEach((button) => {
        button.disabled = disabled;
      });
    },
  };
}
