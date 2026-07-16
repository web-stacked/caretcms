export type EntryData = { id: string; data: Record<string, unknown> };
export type HistoryEntry = { ts: number; data: unknown; action: string };
export type CaretMode = "embedded" | "cloud";
export type CaretProviderKind = "storage" | "uploads";

export type RuntimeProviderReference<TKind extends CaretProviderKind = CaretProviderKind> = {
  kind: TKind;
  entrypoint: string;
  exportName?: string;
  options?: Record<string, unknown> | null;
};

export type CaretStorageProvider = RuntimeProviderReference<"storage">;
export type CaretUploadProvider = RuntimeProviderReference<"uploads">;

export type CollectionSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  title?: string;
  description?: string;
};

export type CollectionMetadata = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  creatable?: boolean;
  orderable?: boolean;
  schema: CollectionSchema;
  created_at: number;
  updated_at: number;
};

export interface StorageAdapter {
  discoverCollections(): Promise<string[]>;
  isKnownCollection(collection: string): Promise<boolean>;
  getEntry(collection: string, id: string): Promise<EntryData | null>;
  listEntryIds(collection: string): Promise<string[]>;
  listEntries(collection: string): Promise<EntryData[]>;
  writeEntry(collection: string, id: string, data: Record<string, unknown>): Promise<void>;
  deleteEntry(collection: string, id: string): Promise<void>;
  getRevision(collection: string, id: string): Promise<number>;
  bumpRevision(collection: string, id: string): Promise<number>;
  getHistory(collection: string, id: string): Promise<HistoryEntry[]>;
  appendHistory(collection: string, id: string, entry: HistoryEntry): Promise<void>;

  // Collection management
  createCollection(metadata: CollectionMetadata): Promise<void>;
  deleteCollection(collection: string): Promise<void>;
  getCollectionMetadata(collection: string): Promise<CollectionMetadata | null>;
  listCollectionMetadata(): Promise<CollectionMetadata[]>;

  /**
   * Optional: build a write-isolated overlay adapter scoped to a session id.
   * Used by demo / sandbox mode together with `SessionOverlayAdapter`. Adapters
   * that don't support multi-tenant scoping can omit this.
   */
  makeSessionOverlay?(sessionId: string): Promise<StorageAdapter>;

  /**
   * Optional: build a PERSISTENT, write-isolated overlay scoped to an editor id.
   * Backs the drafts / preview-before-publish workflow: an editor's unpublished
   * edits land in this overlay, the public site keeps reading the base, and
   * "Publish" flushes the overlay back into the base. Distinct from
   * `makeSessionOverlay`, which is ephemeral demo isolation (and may carry a TTL).
   * The same `editorId` must return an overlay over the same backing store so a
   * draft survives across requests. Adapters that can't isolate writes may omit it.
   */
  makeEditorOverlay?(editorId: string): Promise<StorageAdapter>;

  /**
   * Optional: the on-disk directory holding this adapter's content, for the
   * git-journal commit-on-publish feature. File-backed adapters return the path
   * git should stage (e.g. the markdown content root); adapters with no
   * filesystem presence (KV/R2, in-memory) omit it, so git-on-publish no-ops.
   */
  committablePath?(): string;

  /**
   * Optional: the raw source text an entry's markdown BODY lives in (the full
   * `.md` file, frontmatter included). Backs body inline editing: the mutation
   * engine hash-checks a block's `data-caret-md-src` range against this before
   * accepting a draft, and publish splices edited blocks back into it. Only
   * source-file-backed adapters (markdown) implement it; overlay wrappers must
   * delegate to their BASE (the body source is always the published file).
   */
  readBodySource?(collection: string, id: string): Promise<string | null>;
}

export interface UploadContext {
  sessionId?: string;
}

export interface UploadHandler {
  upload(file: File, ctx?: UploadContext): Promise<{ url: string }>;

  /**
   * Optional: build a per-session wrapper that enforces sandbox quotas
   * (per-file size, total session bytes). Used by demo mode together with
   * `QuotaUploadHandler`. Adapters that don't support quota tracking can
   * omit this.
   */
  makeSessionWrapper?(sessionId: string): Promise<UploadHandler>;
}
