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
