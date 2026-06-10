/**
 * Identifier grammar for collections and entry ids, shared across the storage
 * layer so the adapters enforce exactly one definition. These MIRROR the
 * mutation engine's command validation (`runtime/mutations/contracts.ts`): the
 * engine validates ids before they reach an adapter, and the adapters re-check
 * as defense in depth (the markdown adapter especially, since it writes into the
 * project's source tree). Keep all copies byte-identical.
 */

/** A collection name. */
export const COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** An entry id. */
export const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * A draft / overlay id (an editor's session UUID). Used as a filesystem path
 * segment for disk-backed draft overlays, so it must not contain path
 * separators or dots — guard against traversal even though ids are minted, not
 * user-supplied.
 */
export const EDITOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Throw on an editor/overlay id that isn't a safe path segment; else return it. */
export function assertSafeEditorId(editorId: string): string {
  if (!EDITOR_ID_RE.test(editorId)) {
    throw new Error(`[caretcms] unsafe editor overlay id: ${JSON.stringify(editorId)}`);
  }
  return editorId;
}
