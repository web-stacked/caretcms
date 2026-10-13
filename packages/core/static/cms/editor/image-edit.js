import { buildCmsUrl } from './config.js';
import { uploadHeaders } from './security.js';
import { resolveBinding } from './helpers.js';

/** @typedef {{ collection: string, id: string, field: string }} ResolvedCaretBinding */
/** @typedef {{ collection: string | null, id: string | null, field: string }} ParsedCaretBinding */
/** @typedef {{ ok: true, revision?: number } | { ok: false, reason: 'conflict' | 'unauthorized' | 'error', latestValue?: unknown }} SaveResult */
/**
 * @typedef {((message: string, kind: 'success' | 'error') => unknown) & {
 *   conflict: (options: {
 *     message: string,
 *     onKeepMine: () => void | Promise<void>,
 *     onLoadLatest: () => void,
 *   }) => unknown,
 * }} ConflictToast
 */

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function readUploadUrl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const url = /** @type {Record<string, unknown>} */ (value).url;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

const OVERLAY_HTML = `
  <span class="cms-img-overlay-content cms-img-state-idle">
    <svg class="cms-img-overlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"/>
      <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z"/>
    </svg>
    <span class="cms-img-overlay-text">Replace image</span>
  </span>
  <span class="cms-img-overlay-content cms-img-state-uploading">
    <span class="cms-img-spinner"></span>
    <span class="cms-img-overlay-text">Uploading…</span>
  </span>
`;

/** The editable image the Replace control currently covers. */
/** @type {HTMLImageElement | null} */
let active = null;

/**
 * The image an event on the Replace control belongs to, so other editor
 * affordances (the link "Open" button) treat the control as that image.
 * @param {Element} target
 * @returns {HTMLImageElement | null}
 */
export function imageUnderControl(target) {
  return target.closest('.cms-img-overlay') ? active : null;
}

/** @param {EventTarget | null} target @returns {HTMLImageElement | null} */
function editableImage(target) {
  if (!(target instanceof HTMLImageElement) || !target.hasAttribute('data-caret')) return null;
  if (target.closest('.cms-toolbar, .cms-studio-panel, .cms-content-map')) return null;
  return target;
}

/**
 * Image replacement without changing the page's DOM: one "Replace image"
 * control lives in a fixed layer and is positioned over whichever editable
 * image is hovered or focused, so absolutely positioned, background, and
 * carousel images keep their layout.
 *
 * @param {object} options
 * @param {(attr: string) => ParsedCaretBinding | null} options.parseCaretAttr
 * @param {(element: Element, success: boolean) => void} options.flash
 * @param {(file: File) => Promise<File>} options.compressImage
 * @param {(image: HTMLImageElement, url: string) => void} options.updateEmblaCarousel
 * @param {(collection: string, id: string, field: string, value: string) => Promise<SaveResult>} options.saveField
 * @param {(state: 'saving' | 'error', text: string) => void} options.setStatus
 * @param {ConflictToast} options.showToast
 * @param {() => void} options.onUnauthorized
 */
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
  // Keyboard access: an editable image outside a link or button becomes a stop.
  document.querySelectorAll('img[data-caret]').forEach((el) => {
    const img = /** @type {HTMLImageElement} */ (el);
    if (img.dataset.caretImgMounted === 'true') return;
    img.dataset.caretImgMounted = 'true';
    if (!img.closest('a, button') && !img.hasAttribute('tabindex')) img.tabIndex = 0;
  });

  if (document.querySelector('.cms-img-layer')) return;

  const layer = document.createElement('div');
  layer.className = 'cms-img-layer';
  const overlay = document.createElement('button');
  overlay.type = 'button';
  overlay.className = 'cms-img-overlay';
  overlay.tabIndex = -1; // keyboard users act on the focused image itself
  overlay.hidden = true;
  overlay.innerHTML = OVERLAY_HTML;
  const input = document.createElement('input');
  input.type = 'file';
  input.className = 'cms-img-input';
  input.accept = 'image/jpeg,image/png,image/webp,image/avif';
  input.setAttribute('aria-label', 'Upload replacement image');
  input.hidden = true;
  layer.append(overlay, input);
  document.body.appendChild(layer);

  let uploading = false;
  let frame = 0;

  const place = () => {
    frame = 0;
    if (!active || !active.isConnected) { hide(true); return; }
    const rect = active.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) { overlay.hidden = true; return; }
    overlay.hidden = false;
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    // Follow scrolling, smooth-scroll libraries, and animations while shown.
    frame = requestAnimationFrame(place);
  };

  /** @param {HTMLImageElement} img */
  const show = (img) => {
    if (document.body.classList.contains('cms-preview-mode')) return;
    if (uploading && img !== active) return;
    active = img;
    overlay.classList.toggle('cms-img-compact', img.getBoundingClientRect().height < 120);
    overlay.style.borderRadius = getComputedStyle(img).borderRadius;
    if (!frame) place();
  };

  /** @param {boolean} [force] */
  const hide = (force = false) => {
    if (uploading && !force) return;
    active = null;
    overlay.hidden = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  document.addEventListener('mouseover', (event) => {
    const img = editableImage(event.target);
    if (img) show(img);
  });
  document.addEventListener('mouseout', (event) => {
    if (!active || event.target !== active) return;
    if (event.relatedTarget instanceof Node && overlay.contains(event.relatedTarget)) return;
    if (document.activeElement !== active) hide();
  });
  overlay.addEventListener('mouseleave', (event) => {
    if (event.relatedTarget === active || document.activeElement === active) return;
    hide();
  });
  document.addEventListener('focusin', (event) => {
    const img = editableImage(event.target);
    if (img) show(img);
    else if (active && event.target !== overlay) hide();
  });
  document.addEventListener('keydown', (event) => {
    const img = editableImage(event.target);
    if (!img || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    show(img);
    input.click();
  });

  overlay.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation(); // keep the page's own handlers (lightboxes) out of it
    if (!uploading) input.click();
  });

  /** @param {string} marker @param {string} src */
  const syncBoundImages = (marker, src) => {
    document.querySelectorAll('img[data-caret]').forEach((node) => {
      const image = /** @type {HTMLImageElement} */ (node);
      if (image.getAttribute('data-caret') !== marker) return;
      image.src = src;
      image.removeAttribute('srcset');
      updateEmblaCarousel(image, src);
    });
  };

  // Save-conflict resolution for images: the upload itself already succeeded
  // (we hold the stored `mineUrl`); only writing it into the entry conflicted.
  /**
   * @param {HTMLImageElement} img
   * @param {ResolvedCaretBinding} resolved
   * @param {string} marker
   * @param {string} mineUrl
   * @param {unknown} latestValue
   */
  const runImageConflict = (img, resolved, marker, mineUrl, latestValue) => {
    showToast.conflict({
      message: 'This image changed elsewhere while you were editing.',
      onKeepMine: async () => {
        const retry = await saveField(resolved.collection, resolved.id, resolved.field, mineUrl);
        flash(img, retry.ok);
        if (retry.ok) {
          syncBoundImages(marker, mineUrl);
          showToast('Your image saved', 'success');
        } else if (retry.reason === 'conflict') {
          runImageConflict(img, resolved, marker, mineUrl, retry.latestValue);
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
    const img = active;
    if (!file || !img) return;

    const marker = img.getAttribute('data-caret') || '';
    const resolved = resolveBinding(img, parseCaretAttr(marker));
    if (!resolved) return;

    // Optimistic preview
    const previewUrl = URL.createObjectURL(file);
    const originalSrc = img.src;
    img.src = previewUrl;

    uploading = true;
    overlay.classList.add('uploading');
    setStatus('saving', 'Uploading…');

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
      const url = readUploadUrl(await uploadRes.json());
      if (!url) throw new Error('Invalid upload response');

      // Point at the durable uploaded URL now, so the shown image survives the
      // optimistic blob being revoked in `finally` (and any conflict prompt).
      img.src = url;

      const result = await saveField(resolved.collection, resolved.id, resolved.field, url);
      if (result.ok) {
        syncBoundImages(marker, url);
        showToast('Image updated', 'success');
      } else if (result.reason === 'conflict') {
        runImageConflict(img, resolved, marker, url, result.latestValue);
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
      uploading = false;
      overlay.classList.remove('uploading');
      if (!img.matches(':hover') && document.activeElement !== img) hide();
    }

    input.value = '';
  });
}
