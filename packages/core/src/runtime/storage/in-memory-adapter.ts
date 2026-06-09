import type { CollectionMetadata, EntryData, HistoryEntry, StorageAdapter } from "../../types.js";

const HISTORY_LIMIT = 50;

export class InMemoryAdapter implements StorageAdapter {
  private collections = new Map<string, Map<string, Record<string, unknown>>>();
  private revisions = new Map<string, number>();
  private history = new Map<string, HistoryEntry[]>();
  private collectionMeta = new Map<string, CollectionMetadata>();
  private editorOverlays = new Map<string, InMemoryAdapter>();

  /** A persistent per-editor overlay store. Same id → same store, so a draft
   *  survives across requests within this process. */
  async makeEditorOverlay(editorId: string): Promise<StorageAdapter> {
    let overlay = this.editorOverlays.get(editorId);
    if (!overlay) {
      overlay = new InMemoryAdapter();
      this.editorOverlays.set(editorId, overlay);
    }
    return overlay;
  }

  private revisionKey(collection: string, id: string): string {
    return `${collection}::${id}`;
  }

  /** Preload entries for testing or demo bootstrap. */
  preload(collection: string, entries: Array<{ id: string; data: Record<string, unknown> }>): void {
    let col = this.collections.get(collection);
    if (!col) {
      col = new Map();
      this.collections.set(collection, col);
    }
    for (const entry of entries) {
      col.set(entry.id, structuredClone(entry.data));
    }
  }

  async discoverCollections(): Promise<string[]> {
    return [...this.collections.keys()].sort((a, b) => a.localeCompare(b));
  }

  async isKnownCollection(collection: string): Promise<boolean> {
    return this.collections.has(collection);
  }

  async getEntry(collection: string, id: string): Promise<EntryData | null> {
    const data = this.collections.get(collection)?.get(id);
    if (!data) return null;
    return { id, data: structuredClone(data) };
  }

  async listEntryIds(collection: string): Promise<string[]> {
    const col = this.collections.get(collection);
    if (!col) return [];
    return [...col.keys()].sort((a, b) => a.localeCompare(b));
  }

  async listEntries(collection: string): Promise<EntryData[]> {
    const col = this.collections.get(collection);
    if (!col) return [];
    return [...col.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, data]) => ({ id, data: structuredClone(data) }));
  }

  async writeEntry(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    let col = this.collections.get(collection);
    if (!col) {
      col = new Map();
      this.collections.set(collection, col);
    }
    col.set(id, structuredClone(data));
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    this.collections.get(collection)?.delete(id);
  }

  async getRevision(collection: string, id: string): Promise<number> {
    return this.revisions.get(this.revisionKey(collection, id)) ?? 0;
  }

  async bumpRevision(collection: string, id: string): Promise<number> {
    const key = this.revisionKey(collection, id);
    const current = this.revisions.get(key) ?? 0;
    const next = current + 1;
    this.revisions.set(key, next);
    return next;
  }

  async getHistory(collection: string, id: string): Promise<HistoryEntry[]> {
    const entries = this.history.get(this.revisionKey(collection, id));
    return entries ? structuredClone(entries) : [];
  }

  async appendHistory(collection: string, id: string, entry: HistoryEntry): Promise<void> {
    const key = this.revisionKey(collection, id);
    const current = this.history.get(key) ?? [];
    const next = [structuredClone(entry), ...current].slice(0, HISTORY_LIMIT);
    this.history.set(key, next);
  }

  // --- Collection Management ---

  async createCollection(metadata: CollectionMetadata): Promise<void> {
    this.collectionMeta.set(metadata.id, structuredClone(metadata));
    if (!this.collections.has(metadata.id)) {
      this.collections.set(metadata.id, new Map());
    }
  }

  async deleteCollection(collection: string): Promise<void> {
    this.collectionMeta.delete(collection);
    this.collections.delete(collection);

    // Clear revisions and history for this collection
    const keysToDelete: string[] = [];
    this.revisions.forEach((_, key) => {
      if (key.startsWith(`${collection}::`)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach((key) => {
      this.revisions.delete(key);
      this.history.delete(key);
    });
  }

  async getCollectionMetadata(collection: string): Promise<CollectionMetadata | null> {
    const meta = this.collectionMeta.get(collection);
    return meta ? structuredClone(meta) : null;
  }

  async listCollectionMetadata(): Promise<CollectionMetadata[]> {
    return [...this.collectionMeta.values()]
      .map((m) => structuredClone(m))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
