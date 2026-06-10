/**
 * Runtime exports for use in Astro pages.
 *
 *   import { bindEntry, loadEntry, loadCollection } from '@caretcms/core/runtime'
 */

// Binding — ADR-004 explicit inline binding (power-user API)
export { bindEntry } from "./bind.js";

// Content loading — read stored data in .astro frontmatter (power-user API)
export { loadEntry, loadCollection, listCollections } from "./content.js";
export type { EntryData } from "./content.js";

// Sandbox / multi-tenant primitives — used by Cloudflare adapter for demo mode
export { SessionOverlayAdapter } from "./storage/session-overlay-adapter.js";
export { QuotaUploadHandler } from "./storage/quota-upload-handler.js";
export type {
  QuotaCounter,
  QuotaUploadHandlerOptions,
} from "./storage/quota-upload-handler.js";

// Shared image-upload validation — adapter authors should call
// readAndValidateImage() before writing user-supplied bytes to storage.
export {
  IMAGE_KIND_TO_EXT,
  IMAGE_MAX_SIZE,
  IMAGE_MIME_TO_KIND,
  UploadError,
  detectImageKind,
  readAndValidateImage,
  sanitizeImageBaseName,
} from "./storage/image-validation.js";
export type { AllowedImageKind } from "./storage/image-validation.js";
