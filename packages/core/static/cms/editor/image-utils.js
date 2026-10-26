/**
 * @param {File} file
 * @param {number} [maxWidth]
 * @param {number} [quality]
 * @returns {Promise<File>}
 */
export async function compressImage(file, maxWidth = 1600, quality = 0.82) {
  if (file.size < 200000 && file.type === 'image/webp') return file;

  /** @type {ImageBitmap} */
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Not decodable here: send it as it is and let the server say why.
    return file;
  }
  let width = bitmap.width;
  let height = bitmap.height;

  const needsResize = width > maxWidth;

  // PNGs: preserve lossless quality — only process if oversized
  if (file.type === 'image/png' && !needsResize) {
    bitmap.close();
    return file;
  }

  if (needsResize) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Keep PNG format to preserve lossless quality; convert others to lossy WebP
  const isPng = file.type === 'image/png';
  const outType = isPng ? 'image/png' : 'image/webp';

  const blob = await new Promise((/** @type {(value: Blob | null) => void} */ resolve) =>
    canvas.toBlob((b) => resolve(b), outType, isPng ? undefined : quality),
  );

  if (!blob || blob.size >= file.size) return file;

  const ext = isPng ? '.png' : '.webp';
  const name = file.name.replace(/\.[^.]+$/, ext);
  return new File([blob], name, { type: outType });
}

/**
 * @param {HTMLImageElement} img
 * @param {string} newUrl
 */
export function updateEmblaCarousel(img, newUrl) {
  // Find the closest Embla container
  const emblaContainer = img.closest('.embla');
  if (!emblaContainer) return;

  // Find the slide this image belongs to
  const slide = img.closest('.embla__slide');
  if (!(slide instanceof HTMLElement)) return;

  const index = slide.dataset.index;
  if (!index) return;
  const slideIndex = Number.parseInt(index, 10);
  if (Number.isNaN(slideIndex)) return;

  // Update the data-full attribute for lightbox
  slide.dataset.full = newUrl;

  // Update thumbnail if it exists
  const thumbBtn = document.querySelector(`.thumb-btn[data-index="${slideIndex}"]`);
  if (thumbBtn) {
    const thumbImg = thumbBtn.querySelector('img');
    if (thumbImg instanceof HTMLImageElement) {
      thumbImg.src = newUrl;
      // Add a flash effect to show it updated
      thumbBtn.classList.add('cms-thumb-updated');
      setTimeout(() => thumbBtn.classList.remove('cms-thumb-updated'), 1000);
    }
  }

  // Update lightbox thumbnails if visible
  const lightboxThumb = document.querySelector(`.lightbox-thumb[data-index="${slideIndex}"]`);
  if (lightboxThumb instanceof HTMLElement) {
    lightboxThumb.dataset.src = newUrl;
    const lbImg = lightboxThumb.querySelector('img');
    if (lbImg instanceof HTMLImageElement) lbImg.src = newUrl;
  }

  // Dispatch custom event that the product page can listen to
  emblaContainer.dispatchEvent(
    new CustomEvent('cms:imageUpdated', {
      detail: { index: slideIndex, url: newUrl },
    }),
  );
}

/**
 * Wait until an uploaded image is actually served. A dev server learns about
 * new public files a moment after they're written, and a CDN can lag too, so
 * switching to the URL at once shows a broken image. Probes with an image
 * load (which works cross-origin), retrying until `timeoutMs`; resolves false
 * if it never loads, and callers switch anyway.
 * @param {string} url
 * @param {{ timeoutMs?: number, intervalMs?: number, createImage?: () => HTMLImageElement }} [options]
 * @returns {Promise<boolean>}
 */
export function whenServed(url, { timeoutMs = 15000, intervalMs = 400, createImage = () => new Image() } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  return new Promise((resolve) => {
    function probe() {
      const image = createImage();
      image.onload = () => resolve(true);
      image.onerror = () => {
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(probe, intervalMs);
      };
      // Retries use a fresh URL so a failed attempt can't be reused.
      image.src = attempt++ === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}caret-retry=${attempt}`;
    }
    probe();
  });
}
