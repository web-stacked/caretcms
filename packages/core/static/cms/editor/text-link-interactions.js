import { escapeHtml } from './linkify.js';

export function createTextLinkInteractions({
  state,
  clientLinkify,
  showToast,
  snapshots,
}) {
  let activePopover = null;
  let activeLinkHint = null;

  function removeLinkHint() {
    if (activeLinkHint) {
      activeLinkHint.remove();
      activeLinkHint = null;
    }
  }

  function dismissLinkPopup() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    state.linkPopupEl = null;
  }

  function showLinkPopup(rect, initialUrl, onApply) {
    dismissLinkPopup();

    const popover = document.createElement('div');
    popover.className = 'cms-link-popover';
    popover.innerHTML = `
      <div class="cms-link-popover-row">
        <svg class="cms-link-popover-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
        </svg>
        <input type="text" class="cms-link-popover-input" placeholder="Paste URL or path (e.g. /contact)" value="${escapeHtml(initialUrl)}" />
      </div>
      <div class="cms-link-popover-actions">
        <span class="cms-link-popover-hint">${navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+K</span>
        <div class="cms-link-popover-btns">
          <button type="button" class="cms-link-popover-cancel">Cancel</button>
          <button type="button" class="cms-link-popover-apply">Apply</button>
        </div>
      </div>
    `;

    document.body.appendChild(popover);
    activePopover = popover;

    const popW = 340;
    let left = rect.left + rect.width / 2 - popW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));
    let top = rect.bottom + 8;
    if (top + 120 > window.innerHeight) {
      top = rect.top - 120;
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    const input = popover.querySelector('.cms-link-popover-input');
    const applyBtn = popover.querySelector('.cms-link-popover-apply');
    const cancelBtn = popover.querySelector('.cms-link-popover-cancel');

    requestAnimationFrame(() => input.focus());
    if (initialUrl) input.select();

    function apply() {
      const url = input.value.trim();
      dismissLinkPopup();
      onApply(url);
    }

    function cancel() {
      dismissLinkPopup();
      onApply(null);
    }

    applyBtn.addEventListener('click', apply);
    cancelBtn.addEventListener('click', cancel);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });

    setTimeout(() => {
      function onDocClick(e) {
        if (!popover.contains(e.target)) {
          document.removeEventListener('click', onDocClick, true);
          cancel();
        }
      }
      document.addEventListener('click', onDocClick, true);
    }, 0);
  }

  function showLinkHint(el) {
    removeLinkHint();
    const hint = document.createElement('div');
    hint.className = 'cms-link-hint';
    hint.textContent = `${navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+K to link`;
    document.body.appendChild(hint);
    activeLinkHint = hint;

    const rect = el.getBoundingClientRect();
    hint.style.top = `${rect.top - 28}px`;
    hint.style.left = `${rect.right - hint.offsetWidth}px`;
  }

  function onKeydown(e) {
    const focused = document.activeElement;

    // Ctrl+S / Cmd+S — save focused element by triggering blur save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (focused && focused.matches('[data-caret]')) {
        focused.blur();
      }
      return;
    }

    // Ctrl+K / Cmd+K — insert link in a rich or linkable field
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      if (focused && focused.matches('[data-caret]') && focused.hasAttribute('data-caret-rich')) {
        // Rich text mode — use execCommand('createLink')
        e.preventDefault();
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;

        const selectedText = sel.toString();
        if (!selectedText.trim()) return;

        const range = sel.getRangeAt(0).cloneRange();
        const selRect = range.getBoundingClientRect();

        // Check if selection is already a link
        const anchorNode = sel.anchorNode;
        const existingLink = anchorNode?.nodeType === Node.TEXT_NODE
          ? anchorNode.parentElement?.closest('a')
          : anchorNode instanceof Element ? anchorNode.closest('a') : null;
        const initialUrl = existingLink?.getAttribute('href') || '';

        state.linkPopupEl = focused;

        showLinkPopup(selRect, initialUrl, (url) => {
          focused.focus();

          if (url) {
            const newSel = window.getSelection();
            newSel.removeAllRanges();
            newSel.addRange(range);

            if (existingLink) {
              existingLink.setAttribute('href', url);
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

            state.dirtyEls.add(focused);
          } else if (url === '' && existingLink) {
            document.execCommand('unlink', false, null);
            state.dirtyEls.add(focused);
          }

          state.linkPopupEl = null;
        });
        return;
      }

      if (focused && focused.matches('[data-caret]') && focused.hasAttribute('data-caret-raw')) {
        e.preventDefault();
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;

        const selectedText = sel.toString();
        if (!selectedText.trim()) return;

        const range = sel.getRangeAt(0).cloneRange();
        const selRect = range.getBoundingClientRect();
        state.linkPopupEl = focused;

        showLinkPopup(selRect, '', (url) => {
          focused.focus();

          if (url) {
            const newSel = window.getSelection();
            newSel.removeAllRanges();
            newSel.addRange(range);
            document.execCommand('insertText', false, `[${selectedText}](${url})`);
            state.dirtyEls.add(focused);
          }

          state.linkPopupEl = null;
        });
      }
      return;
    }

    // Escape — revert to snapshot and blur without saving
    if (e.key === 'Escape') {
      if (activePopover) return;

      if (focused && focused.matches('[data-caret]')) {
        e.preventDefault();
        const snapshot = snapshots.get(focused);
        if (snapshot !== undefined) {
          const isRich = focused.hasAttribute('data-caret-rich');
          const isLinkable = focused.hasAttribute('data-caret-raw');
          if (isRich) {
            focused.innerHTML = snapshot;
          } else if (isLinkable) {
            focused.innerHTML = clientLinkify(snapshot);
            focused.setAttribute('data-caret-raw', snapshot);
          } else {
            focused.textContent = snapshot;
          }
          state.dirtyEls.delete(focused);
        }
        focused._caretSkipSave = true;
        focused.blur();
        removeLinkHint();
        showToast('Edit cancelled', 'success');
      }
    }
  }

  return {
    onKeydown,
    showLinkHint,
    removeLinkHint,
    showLinkPopup,
  };
}
