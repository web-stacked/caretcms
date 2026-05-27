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
