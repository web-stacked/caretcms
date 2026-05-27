import { sanitizeHtml } from './sanitize.js';

export function mountStudioSync({ studioIframe, state, showToast, clientLinkify }) {
  if (!studioIframe) return;

  window.addEventListener('message', (e) => {
    // Only accept messages from our iframe
    if (e.source !== studioIframe.contentWindow) return;
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'cms:saved') {
      const { collection, id, data } = msg;
      if (!data || typeof data !== 'object') return;

      let updated = 0;

      function walkData(obj, prefix) {
        for (const [key, value] of Object.entries(obj)) {
          const path = prefix ? `${prefix}.${key}` : key;
          const selector = `${collection}::${id}::${path}`;

          if (typeof value === 'string') {
            // Text and image fields — unified under [data-caret]
            const els = document.querySelectorAll(`[data-caret="${selector}"]`);
            els.forEach((el) => {
              // Skip elements being actively edited to prevent overwriting unsaved work
              if (el === state.dirtyEl || el === document.activeElement) return;

              if (el instanceof HTMLImageElement) {
                // Image element
                if (el.src !== value && el.getAttribute('src') !== value) {
                  el.src = value;
                  updated++;
                }
              } else if (el.hasAttribute('data-caret-rich')) {
                const sanitized = sanitizeHtml(value);
                if (el.innerHTML !== sanitized) {
                  el.innerHTML = sanitized;
                  updated++;
                }
              } else if (el.hasAttribute('data-caret-raw')) {
                if (el.getAttribute('data-caret-raw') !== value) {
                  el.setAttribute('data-caret-raw', value);
                  el.innerHTML = clientLinkify(value);
                  updated++;
                }
              } else if (el.textContent !== value) {
                el.textContent = value;
                updated++;
              }
            });
          } else if (typeof value === 'object' && value !== null) {
            walkData(value, path);
          }
        }
      }

      walkData(data, '');

      if (updated > 0) {
        showToast(`Updated ${updated} element${updated > 1 ? 's' : ''} on page`, 'success');
      } else {
        showToast('Saved — refresh to see changes', 'success');
      }
    }

    if (msg.type === 'cms:created') {
      showToast('New entry created — refresh to see changes', 'success');
    }
  });
}
