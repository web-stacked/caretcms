export async function compressImage(file, maxWidth = 1600, quality = 0.82) {
  if (file.size < 200000 && file.type === 'image/webp') return file;

  const bitmap = await createImageBitmap(file);
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
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Keep PNG format to preserve lossless quality; convert others to lossy WebP
  const isPng = file.type === 'image/png';
  const outType = isPng ? 'image/png' : 'image/webp';

  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), outType, isPng ? undefined : quality),
  );

  if (!blob || blob.size >= file.size) return file;

  const ext = isPng ? '.png' : '.webp';
  const name = file.name.replace(/\.[^.]+$/, ext);
  return new File([blob], name, { type: outType });
}

export function updateEmblaCarousel(img, newUrl) {
  // Find the closest Embla container
  const emblaContainer = img.closest('.embla');
  if (!emblaContainer) return;

  // Find the slide this image belongs to
  const slide = img.closest('.embla__slide');
  if (!slide) return;

  const slideIndex = parseInt(slide.dataset.index, 10);
  if (isNaN(slideIndex)) return;

  // Update the data-full attribute for lightbox
  slide.dataset.full = newUrl;

  // Update thumbnail if it exists
  const thumbBtn = document.querySelector(`.thumb-btn[data-index="${slideIndex}"]`);
  if (thumbBtn) {
    const thumbImg = thumbBtn.querySelector('img');
    if (thumbImg) {
      thumbImg.src = newUrl;
      // Add a flash effect to show it updated
      thumbBtn.classList.add('cms-thumb-updated');
      setTimeout(() => thumbBtn.classList.remove('cms-thumb-updated'), 1000);
    }
  }

  // Update lightbox thumbnails if visible
  const lightboxThumb = document.querySelector(`.lightbox-thumb[data-index="${slideIndex}"]`);
  if (lightboxThumb) {
    lightboxThumb.dataset.src = newUrl;
    const lbImg = lightboxThumb.querySelector('img');
    if (lbImg) lbImg.src = newUrl;
  }

  // Dispatch custom event that the product page can listen to
  emblaContainer.dispatchEvent(
    new CustomEvent('cms:imageUpdated', {
      detail: { index: slideIndex, url: newUrl },
    }),
  );
}
