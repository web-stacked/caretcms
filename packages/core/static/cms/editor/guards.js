export function mountEditorGuards(state) {
  document.body.classList.add('cms-edit-mode');

  window.addEventListener('beforeunload', (e) => {
    if (state.dirtyEls.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Smart navigation: only block clicks on CMS-editable elements.
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      // Allow clicks inside the CMS toolbar
      if (target.closest('.cms-toolbar')) return;

      // Allow clicks on image overlay buttons
      if (target.closest('.cms-img-overlay')) return;

      // Allow clicks inside the link popover
      if (target.closest('.cms-link-popover')) return;

      // Allow clicks on the floating "Open page" affordance — it's a real
      // anchor that lets visitors follow links instead of editing them.
      if (target.closest('.cms-link-follow')) return;

      const editable = target.closest('[data-caret]');
      const link = target.closest('a');
      if (link) {
        // Link contains or is a CMS editable — block nav, focus editable
        const cmsInLink = editable || link.querySelector('[data-caret]');
        if (cmsInLink instanceof HTMLElement) {
          e.preventDefault();
          e.stopPropagation();
          cmsInLink.focus();
          return;
        }
        // Non-CMS link — let it navigate normally
        return;
      }

      // For buttons: only intercept if they contain CMS content
      const btn = target.closest('button');
      if (btn && !btn.closest('.cms-toolbar') && !btn.closest('.cms-img-wrapper')) {
        const cmsInBtn = editable || btn.querySelector('[data-caret]');
        if (cmsInBtn instanceof HTMLElement) {
          e.preventDefault();
          e.stopPropagation();
          cmsInBtn.focus();
        }
      }
    },
    true,
  );

  // Block form submissions (except CMS forms)
  document.addEventListener(
    'submit',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.cms-toolbar')) {
        e.preventDefault();
      }
    },
    true,
  );
}
