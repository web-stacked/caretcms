import { buildCmsUrl } from './config.js';
import { uploadHeaders } from './security.js';
import { resolveBinding } from './helpers.js';

export function mountImageEditors({
  parseCaretAttr,
  flash,
  compressImage,
  updateEmblaCarousel,
  saveField,
  setStatus,
  showToast,
  onUnauthorized,
}) {
  const syncBoundImages = (marker, src) => {
    document.querySelectorAll('[data-caret]').forEach((node) => {
      if (!(node instanceof HTMLImageElement)) return;
      if (node.getAttribute('data-caret') !== marker) return;
      node.src = src;
      updateEmblaCarousel(node, src);
    });
  };

  document.querySelectorAll('[data-caret]').forEach((el) => {
    if (!(el instanceof HTMLImageElement)) return;
    const img = el;
    if (img.dataset.caretImgMounted === 'true') return;
    img.dataset.caretImgMounted = 'true';

    const existingWrapper = img.parentElement;
    if (existingWrapper?.classList.contains('cms-img-wrapper')) {
      existingWrapper.parentNode?.insertBefore(img, existingWrapper);
      existingWrapper.remove();
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'cms-img-wrapper';
    wrapper.style.position = 'relative';
    wrapper.style.display = 'block';
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';

    img.parentNode?.insertBefore(wrapper, img);
    wrapper.appendChild(img);

    // Corner badge — persistent edit indicator
    const badge = document.createElement('div');
    badge.className = 'cms-img-badge';
    badge.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    wrapper.appendChild(badge);

    // Full overlay with idle + uploading states
    const overlay = document.createElement('button');
    overlay.className = 'cms-img-overlay';
    overlay.type = 'button';
    overlay.innerHTML = `
      <span class="cms-img-overlay-content cms-img-state-idle">
        <svg class="cms-img-overlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z"/>
        </svg>
        <span class="cms-img-overlay-text">Replace Image</span>
      </span>
      <span class="cms-img-overlay-content cms-img-state-uploading">
        <span class="cms-img-spinner"></span>
        <span class="cms-img-overlay-text">Uploading...</span>
      </span>
    `;
    wrapper.appendChild(overlay);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/avif';
    input.style.display = 'none';
    wrapper.appendChild(input);

    overlay.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent slide click (lightbox)
      input.click();
    });

    // Save-conflict resolution for images: the upload itself already succeeded
    // (we hold the stored `mineUrl`); only writing it into the entry conflicted.
    // Keep the uploaded image shown and let the user choose, rather than
    // silently swapping in whatever landed elsewhere.
    const runImageConflict = (resolved, marker, mineUrl, latestValue) => {
      showToast.conflict({
        message: 'This image changed elsewhere while you were editing.',
        onKeepMine: async () => {
          setStatus('saving', 'Saving...');
          const retry = await saveField(resolved.collection, resolved.id, resolved.field, mineUrl);
          flash(img, retry.ok);
          if (retry.ok) {
            syncBoundImages(marker, mineUrl);
            showToast('Your image saved', 'success');
          } else if (retry.reason === 'conflict') {
            runImageConflict(resolved, marker, mineUrl, retry.latestValue);
          } else if (retry.reason !== 'unauthorized') {
            showToast('Failed to save image. Try again.', 'error');
          }
        },
        onLoadLatest: () => {
          const src = typeof latestValue === 'string' ? latestValue : mineUrl;
          syncBoundImages(marker, src);
          showToast('Loaded latest image', 'success');
        },
      });
    };

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;

      const marker = img.getAttribute('data-caret') || '';
      const parsed = parseCaretAttr(marker);
      const resolved = resolveBinding(img, parsed);
      if (!resolved) return;

      // Optimistic preview
      const previewUrl = URL.createObjectURL(file);
      const originalSrc = img.src;
      img.src = previewUrl;

      overlay.classList.add('uploading');
      badge.classList.add('cms-img-badge-hidden');
      setStatus('saving', 'Uploading...');

      try {
        const compressed = await compressImage(file);
        const formData = new FormData();
        formData.append('file', compressed);
        const headers = await uploadHeaders();

        const uploadRes = await fetch(buildCmsUrl('/upload'), {
          method: 'POST',
          headers,
          body: formData,
        });
        if (uploadRes.status === 401) {
          // Restore the real image before the redirect — the optimistic blob is
          // revoked in `finally`, so leaving it as src would flash a broken image.
          img.src = originalSrc;
          onUnauthorized();
          return;
        }
        if (!uploadRes.ok) throw new Error('Upload failed');
        const { url } = await uploadRes.json();

        // Point at the durable uploaded URL now, so the shown image survives the
        // optimistic blob being revoked in `finally` (and any conflict prompt).
        img.src = url;

        const result = await saveField(resolved.collection, resolved.id, resolved.field, url);
        if (result.ok) {
          syncBoundImages(marker, url);
          showToast('Image updated', 'success');
        } else if (result.reason === 'conflict') {
          // Keep the uploaded image shown; let the user choose.
          runImageConflict(resolved, marker, url, result.latestValue);
        } else if (result.reason !== 'unauthorized') {
          syncBoundImages(marker, originalSrc);
          showToast('Failed to save image. Changes reverted.', 'error');
        }

        flash(img, result.ok);
      } catch {
        img.src = originalSrc;
        flash(img, false);
        setStatus('error', 'Upload failed');
        showToast('Upload failed', 'error');
      } finally {
        URL.revokeObjectURL(previewUrl);
        overlay.classList.remove('uploading');
        badge.classList.remove('cms-img-badge-hidden');
      }

      input.value = '';
    });
  });
}
