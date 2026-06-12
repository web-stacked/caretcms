/**
 * Public contract surface for tooling that interoperates with the runtime
 * without importing it (caretize mirrors these; adapters import them).
 *
 * Everything re-exported here is a compatibility promise: the identifier
 * grammar gates what storage keys exist, the tag list gates what the rewrite
 * engine can render, and the rich allowlist gates what survives sanitization.
 * Mirror copies in other packages are held to these by the parity test
 * (`tests/unit/contracts-parity.test.ts`).
 */

export {
  COLLECTION_NAME_RE,
  ENTRY_ID_RE,
  EDITOR_ID_RE,
  assertSafeEditorId,
} from "./runtime/storage/id-contracts.js";

export { REWRITABLE_TEXT_TAGS } from "./runtime/rewrite.js";

export {
  RICH_ALLOWED_TAGS,
  RICH_ALLOWED_ATTRS,
  SAFE_HREF_RE,
} from "./runtime/rich-allowlist.js";
