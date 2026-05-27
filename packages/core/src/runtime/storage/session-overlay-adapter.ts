import type {
  CollectionMetadata,
  EntryData,
  HistoryEntry,
  StorageAdapter,
} from "../../types.js";

const TOMBSTONE_KEY = "__caret_tombstone__";

function isTombstone(entry: EntryData | null): boolean {
  return Boolean(entry && entry.data?.[TOMBSTONE_KEY] === true);
}

/**
 * Overlay adapter for demo / multi-tenant sandbox use. Reads check the overlay
 * first and fall back to the shared base adapter; writes go only to the overlay.
 *
 * Visitor edits a single field → only that key lands in the overlay; everything
 * else is served from the seeded base. Storage cost is bounded to deltas.
 *
 * Deletes write a tombstone sentinel into the overlay rather than removing the
 * overlay key, so deleting a base-only entry stays deleted for the session
 * instead of falling through to the seeded value on the next read.
 */
export class SessionOverlayAdapter implements StorageAdapter {
  constructor(
    private readonly base: StorageAdapter,
    private readonly overlay: StorageAdapter,
  ) {}

  async discoverCollections(): Promise<string[]> {
    const [base, ov] = await Promise.all([
      this.base.discoverCollections(),
      this.overlay.discoverCollections(),
    ]);
    return [...new Set([...base, ...ov])].sort((a, b) => a.localeCompare(b));
  }

  async isKnownCollection(collection: string): Promise<boolean> {
    if (await this.overlay.isKnownCollection(collection)) return true;
    return this.base.isKnownCollection(collection);
  }

  async getEntry(collection: string, id: string): Promise<EntryData | null> {
    const overlaid = await this.overlay.getEntry(collection, id);
    if (isTombstone(overlaid)) return null;
    if (overlaid) return overlaid;
    return this.base.getEntry(collection, id);
  }

  async listEntryIds(collection: string): Promise<string[]> {
    const [baseIds, overlayIds] = await Promise.all([
      this.base.listEntryIds(collection),
      this.overlay.listEntryIds(collection),
    ]);

    // Resolve overlay entries once so we know which ids are tombstoned.
    const overlayEntries = await Promise.all(
      overlayIds.map(async (id) => ({
        id,
        entry: await this.overlay.getEntry(collection, id),
      })),
    );
    const tombstoned = new Set<string>();
    const liveOverlayIds = new Set<string>();
    for (const { id, entry } of overlayEntries) {
      if (isTombstone(entry)) tombstoned.add(id);
      else liveOverlayIds.add(id);
    }

    const merged = new Set<string>();
    for (const id of baseIds) {
      if (!tombstoned.has(id)) merged.add(id);
    }
    for (const id of liveOverlayIds) merged.add(id);
    return [...merged].sort((a, b) => a.localeCompare(b));
  }

  async listEntries(collection: string): Promise<EntryData[]> {
    const ids = await this.listEntryIds(collection);
    const entries = await Promise.all(ids.map((id) => this.getEntry(collection, id)));
    return entries.filter((entry): entry is EntryData => Boolean(entry));
  }

  async writeEntry(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.overlay.writeEntry(collection, id, data);
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    // Write a tombstone instead of deleting. A plain overlay delete would be
    // a no-op for any entry that lives only in the base, and the next read
    // would resurrect it from the seeded data.
    await this.overlay.writeEntry(collection, id, { [TOMBSTONE_KEY]: true });
  }

  async getRevision(collection: string, id: string): Promise<number> {
    return this.overlay.getRevision(collection, id);
  }

  async bumpRevision(collection: string, id: string): Promise<number> {
    return this.overlay.bumpRevision(collection, id);
  }

  async getHistory(collection: string, id: string): Promise<HistoryEntry[]> {
    return this.overlay.getHistory(collection, id);
  }

  async appendHistory(
    collection: string,
    id: string,
    entry: HistoryEntry,
  ): Promise<void> {
    await this.overlay.appendHistory(collection, id, entry);
  }

  async createCollection(metadata: CollectionMetadata): Promise<void> {
    await this.overlay.createCollection(metadata);
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.overlay.deleteCollection(collection);
  }

  async getCollectionMetadata(
    collection: string,
  ): Promise<CollectionMetadata | null> {
    const overlaid = await this.overlay.getCollectionMetadata(collection);
    if (overlaid) return overlaid;
    return this.base.getCollectionMetadata(collection);
  }

  async listCollectionMetadata(): Promise<CollectionMetadata[]> {
    const [base, ov] = await Promise.all([
      this.base.listCollectionMetadata(),
      this.overlay.listCollectionMetadata(),
    ]);
    const merged = new Map<string, CollectionMetadata>();
    for (const meta of base) merged.set(meta.id, meta);
    for (const meta of ov) merged.set(meta.id, meta);
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
