/**
 * Shared image-upload validation primitives. Used by both the filesystem
 * upload handler and adapter implementations (Cloudflare R2, etc.) so every
 * handler treats the browser-supplied `file.type` as a hint and the bytes on
 * disk as authoritative.
 */

export type AllowedImageKind = "jpeg" | "png" | "webp" | "avif";

/**
 * Marks an upload failure whose message is safe to show the end user (a
 * validation/quota rejection, not an internal error). The upload route
 * surfaces `UploadError.message` and returns an opaque message for anything
 * else, so unexpected errors (e.g. a filesystem error carrying a path) never
 * leak to the client.
 */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export const IMAGE_MIME_TO_KIND: Record<string, AllowedImageKind> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export const IMAGE_KIND_TO_EXT: Record<AllowedImageKind, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  avif: "avif",
};

export const IMAGE_MAX_SIZE = 10 * 1024 * 1024;

export function detectImageKind(bytes: Uint8Array): AllowedImageKind | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }

  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    bytes[8] === 0x61 &&
    bytes[9] === 0x76 &&
    bytes[10] === 0x69 &&
    (bytes[11] === 0x66 || bytes[11] === 0x73)
  ) {
    return "avif";
  }

  return null;
}

/**
 * Strip the client-supplied extension entirely; callers re-derive it from the
 * verified magic bytes. Blocks `evil.html` / `evil.svg` filenames from
 * landing in storage even when their byte contents happen to match a
 * permitted image format.
 */
export function sanitizeImageBaseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Common validation pipeline: enforces size cap, declared MIME allowlist,
 * magic-byte match against the declared type, and returns the kind + buffered
 * bytes so the caller can stream them to the destination once.
 */
export async function readAndValidateImage(file: File): Promise<{
  kind: AllowedImageKind;
  bytes: Uint8Array;
}> {
  if (!IMAGE_MIME_TO_KIND[file.type]) {
    throw new UploadError("File type not allowed");
  }
  if (file.size > IMAGE_MAX_SIZE) {
    throw new UploadError("File too large (max 10MB)");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectImageKind(bytes);
  if (!detected) {
    throw new UploadError("File contents do not match a supported image format");
  }
  if (detected !== IMAGE_MIME_TO_KIND[file.type]) {
    throw new UploadError("File contents do not match the declared MIME type");
  }

  return { kind: detected, bytes };
}
