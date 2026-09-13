/**
 * Floating rich text format toolbar for [data-caret-rich] elements.
 *
 * Singleton toolbar appears on text selection within rich-text fields.
 * Uses document.execCommand() for formatting (still the most reliable
 * cross-browser approach for contenteditable formatting).
 */

/** @typedef {{ dirtyEls: Set<Element>, linkPopupEl: HTMLElement | null }} RichEditorState */
/** @typedef {(url: string | null) => void} LinkApplyCallback */
/** @typedef {(rect: DOMRect | DOMRectReadOnly, initialUrl: string, onApply: LinkApplyCallback) => void} ShowLinkPopup */
/** @typedef {{ sep?: boolean, cmd?: string, label?: string, title?: string, style?: string, isLink?: boolean }} ToolbarItem */

/** @type {HTMLDivElement | null} */
let toolbar = null;
/** @type {HTMLElement | null} */
let currentRichEl = null;
/** @type {ShowLinkPopup | null} */
let showLinkPopupFn = null;
/** @type {RichEditorState | null} */
let editorState = null;

/** @type {ToolbarItem[]} */
const BUTTONS = [
  { cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)', style: 'font-weight:700' },
  { cmd: 'italic', label: 'I', title: 'Italic (Ctrl+I)', style: 'font-style:italic' },
  { sep: true },
  { cmd: 'createLink', label: '\u{1F517}', title: 'Link (Ctrl+K)', isLink: true },
  { cmd: 'removeFormat', label: 'T\u2093', title: 'Clear formatting' },
];

/** @returns {HTMLDivElement} */
function createToolbar() {
  const el = document.createElement('div');
  el.className = 'cms-rich-toolbar';
  el.style.display = 'none';

  for (const btn of BUTTONS) {
    if (btn.sep) {
      const sep = document.createElement('div');
      sep.className = 'cms-rich-toolbar-sep';
      el.appendChild(sep);
      continue;
    }
    if (!btn.cmd) continue;
    const command = btn.cmd;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cms-rich-toolbar-btn';
    button.title = btn.title || '';
    button.dataset.cmd = command;
    if (btn.style) button.style.cssText = btn.style;

    // Use text for simple labels, innerHTML for the link icon
    if (btn.isLink) {
      button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`;
    } else {
      button.textContent = btn.label || '';
    }

    button.addEventListener('mousedown', (e) => {
      e.preventDefault(); // Prevent blur on the rich element
      if (btn.isLink) {
        handleLinkButton();
      } else {
        document.execCommand(command);
        if (currentRichEl) editorState?.dirtyEls.add(currentRichEl);
        updateActiveStates();
      }
    });

    el.appendChild(button);
  }

  // Prevent toolbar clicks from stealing focus
  el.addEventListener('mousedown', (e) => e.preventDefault());

  document.body.appendChild(el);
  return el;
}

function handleLinkButton() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !currentRichEl) return;

  const range = sel.getRangeAt(0).cloneRange();
  const selRect = range.getBoundingClientRect();
  const target = currentRichEl;
  const selectedText = sel.toString();

  // Check if selection is already a link
  const anchorNode = sel.anchorNode;
  const existingLink = anchorNode?.nodeType === Node.TEXT_NODE
    ? anchorNode.parentElement?.closest('a')
    : anchorNode instanceof Element ? anchorNode.closest('a') : null;
  const initialUrl = existingLink?.getAttribute('href') || '';

  function liveExistingLink() {
    if (!existingLink) return null;
    if (target.contains(existingLink)) return existingLink;
    return Array.from(target.querySelectorAll('a')).find((link) =>
      link.getAttribute('href') === initialUrl && link.textContent === selectedText
    ) || null;
  }

  if (showLinkPopupFn) {
    showLinkPopupFn(selRect, initialUrl, (url) => {
      target.focus();
      const link = liveExistingLink();

      if (url) {
        const newSel = window.getSelection();
        if (!newSel) {
          if (editorState) editorState.linkPopupEl = null;
          hide();
          return;
        }
        newSel.removeAllRanges();
        newSel.addRange(range);

        if (link) {
          // Update existing link
          link.setAttribute('href', url);
        } else {
          document.execCommand('createLink', false, url);
        }

        // Set security attrs on external links
        const freshSel = window.getSelection();
        if (freshSel && freshSel.anchorNode) {
          const textNode = freshSel.anchorNode;
          const newLink = textNode.nodeType === Node.TEXT_NODE
            ? textNode.parentElement?.closest('a')
            : textNode instanceof Element ? textNode.closest('a') : null;
          if (newLink && /^https?:/i.test(url)) {
            newLink.setAttribute('target', '_blank');
            newLink.setAttribute('rel', 'noopener noreferrer');
          }
        }
        editorState?.dirtyEls.add(target);
      } else if (url === '' && link) {
        // Empty URL = unlink
        document.execCommand('unlink');
        editorState?.dirtyEls.add(target);
      }

      if (editorState) editorState.linkPopupEl = null;
      hide();
    });
    // showLinkPopup dismisses any prior popover first, which clears this state.
    // Claim the new popover only after it has completed that cleanup.
    if (editorState) editorState.linkPopupEl = target;
  }
}

function updateActiveStates() {
  if (!toolbar) return;
  const buttons = toolbar.querySelectorAll('.cms-rich-toolbar-btn[data-cmd]');
  for (const btn of buttons) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    const cmd = btn.dataset.cmd;
    if (!cmd || cmd === 'createLink' || cmd === 'removeFormat') continue;
    try {
      btn.classList.toggle('active', document.queryCommandState(cmd));
    } catch {
      // queryCommandState can throw for unsupported commands
    }
  }
}

/** @param {Selection} sel */
function position(sel) {
  if (!toolbar || sel.isCollapsed || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;

  const tbRect = toolbar.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tbRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tbRect.width - 8));

  // Prefer above selection, flip below if near top
  let top = rect.top - tbRect.height - 8;
  if (top < 8) {
    top = rect.bottom + 8;
  }

  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
}

/** @param {Selection} sel */
function show(sel) {
  if (!toolbar) toolbar = createToolbar();
  toolbar.style.display = 'flex';
  updateActiveStates();
  position(sel);
}

function hide() {
  if (toolbar) {
    toolbar.style.display = 'none';
  }
  currentRichEl = null;
}

function onSelectionChange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    hide();
    return;
  }

  // Check if selection is inside a rich element (or a markdown body block,
  // which shares the same inline formatting commands)
  const anchor = sel.anchorNode;
  const richEl = anchor instanceof Element
    ? anchor.closest('[data-caret-rich], [data-caret-md]')
    : anchor?.parentElement?.closest('[data-caret-rich], [data-caret-md]');

  if (!(richEl instanceof HTMLElement)) {
    hide();
    return;
  }

  currentRichEl = richEl;
  show(sel);
}

/**
 * Mount the rich text toolbar. Call once during editor boot.
 * @param {object} options
 * @param {RichEditorState} options.state
 * @param {(message: string, kind: 'success' | 'error') => unknown} options.showToast
 * @param {ShowLinkPopup} [options.showLinkPopup]
 */
export function mountRichToolbar({ state, showToast, showLinkPopup }) {
  editorState = state;
  void showToast;
  showLinkPopupFn = showLinkPopup || null;
  document.addEventListener('selectionchange', onSelectionChange);
}
