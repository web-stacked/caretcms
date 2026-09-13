const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

export class StudioUploadError extends Error {
  /** @param {'unauthorized' | 'failed' | 'invalid-response'} kind */
  constructor(kind) {
    super(kind === 'unauthorized' ? 'Unauthorized' : 'Upload failed');
    this.name = 'StudioUploadError';
    this.kind = kind;
  }
}

/** @param {{ type?: string }} file */
export function isSupportedImage(file) {
  return IMAGE_TYPES.has(file.type || '');
}

/**
 * @param {{
 *   apiBasePath: string,
 *   fetchImpl?: typeof fetch,
 *   createBitmap?: typeof createImageBitmap,
 *   createCanvas?: () => HTMLCanvasElement,
 *   onUnauthorized?: () => void,
 * }} options
 */
export function createStudioUploadClient({
  apiBasePath,
  fetchImpl = fetch,
  createBitmap = file => createImageBitmap(file),
  createCanvas = () => document.createElement('canvas'),
  onUnauthorized = () => {},
}) {
  /** @param {File} file @param {number} [maxWidth] @param {number} [quality] */
  async function compress(file, maxWidth = 1600, quality = 0.82) {
    if (file.size < 200000 && file.type === 'image/webp') return file;
    const bitmap = await createBitmap(file);
    let width = bitmap.width;
    let height = bitmap.height;
    const needsResize = width > maxWidth;
    if (file.type === 'image/png' && !needsResize) {
      bitmap.close();
      return file;
    }
    if (needsResize) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }
    const canvas = createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const isPng = file.type === 'image/png';
    const outputType = isPng ? 'image/png' : 'image/webp';
    return new Promise(resolve => {
      canvas.toBlob(blob => {
        if (!blob || blob.size >= file.size) return resolve(file);
        const extension = isPng ? '.png' : '.webp';
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, extension), { type: outputType }));
      }, outputType, isPng ? undefined : quality);
    });
  }

  /** @param {File} file */
  async function readDimensions(file) {
    try {
      const bitmap = await createBitmap(file);
      let width = bitmap.width;
      let height = bitmap.height;
      bitmap.close();
      if (width > 1600) {
        height = Math.round((height * 1600) / width);
        width = 1600;
      }
      return { width, height };
    } catch {
      return null;
    }
  }

  /** @param {File} file */
  async function upload(file) {
    const form = new FormData();
    form.append('file', await compress(file));
    const response = await fetchImpl(`${apiBasePath}/upload`, {
      method: 'POST',
      body: form,
      headers: { 'x-caret-request': '1' },
      credentials: 'same-origin',
    });
    if (response.status === 401) {
      onUnauthorized();
      throw new StudioUploadError('unauthorized');
    }
    if (!response.ok) throw new StudioUploadError('failed');
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('url' in body) || typeof body.url !== 'string') {
      throw new StudioUploadError('invalid-response');
    }
    return body.url;
  }

  return { compress, readDimensions, upload };
}
