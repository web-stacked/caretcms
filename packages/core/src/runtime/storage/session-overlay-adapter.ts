import { DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY, contentWithoutState, readDraftState } from "../draft-state.js";
import type {
  CollectionMetadata,
  EntryCommit,
  EntryCommitResult,
  EntryData,
  HistoryEntry,
  DeploymentTarget,
  RebuildReceipt,
  StorageAdapter,
} from "../../types.js";

/** Sentinel marking a deleted-in-overlay entry. Exported so the publish flow can
 *  recognize a draft deletion and apply it to the base as a real delete. */
export const TOMBSTONE_KEY = "__caret_tombstone__";

function isTombstone(entry: EntryData | null): boolean {
  return Boolean(entry && entry.data?.[TOMBSTONE_KEY] === true);
}

/**
 * Overlay adapter for demo / multi-tenant sandbox use. Reads check the overlay
 * first and fall back to the shared base adapter; writes go only to the overlay.
 *
 * Structured editor drafts retain a full snapshot and the first published base
 * for conflict detection. Body-only drafts and demo overlays merge over base.
 *
 * Deletes write a tombstone sentinel into the overlay rather than removing the
 * overlay key, so deleting a base-only entry stays deleted for the session
 * instead of falling through to the seeded value on the next read.
 */
export class SessionOverlayAdapter implements StorageAdapter {
  constructor(
    private readonly base: StorageAdapter,
    private readonly overlay: StorageAdapter,
    private readonly trackDrafts = true,
  ) {}

  getRebuildReceipt(): Promise<RebuildReceipt | null> {
    return this.overlay.getRebuildReceipt?.() ?? Promise.resolve(null);
  }

  setRebuildReceipt(receipt: RebuildReceipt | null): Promise<void> {
    return this.overlay.setRebuildReceipt?.(receipt) ?? Promise.resolve();
  }

  getDeploymentTarget(): Promise<DeploymentTarget | null> {
    return this.overlay.getDeploymentTarget?.() ?? Promise.resolve(null);
  }

  setDeploymentTarget(target: DeploymentTarget | null): Promise<void> {
    return this.overlay.setDeploymentTarget?.(target) ?? Promise.resolve();
  }

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
    if (!overlaid) return this.base.getEntry(collection, id);
    // Structured snapshots preserve removed fields. Body-only drafts and demo
    // overlays merge over base so untouched fields remain current.
    const base = await this.base.getEntry(collection, id);
    const state = readDraftState(overlaid.data);
    const content = contentWithoutState(overlaid.data);
    return { ...overlaid, data: state?.structured || !base ? content : { ...base.data, ...content } };
  }

  /** The overlay's OWN entry (draft deltas only), with no base fallback or
   *  merge. The md_block mutation reads this so a body draft writes back just
   *  its delta plus `__body` — never a base frontmatter snapshot that a later
   *  publish would flush over fields edited straight to base in the meantime. */
  async getOwnEntry(collection: string, id: string): Promise<EntryData | null> {
    const overlaid = await this.overlay.getEntry(collection, id);
    if (isTombstone(overlaid)) return null;
    return overlaid ? { ...overlaid, data: contentWithoutState(overlaid.data) } : null;
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
    await this.writeDraft(collection, id, data, true);
  }

  async writeBodyDraft(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.writeDraft(collection, id, data, false);
  }

  private async writeDraft(collection: string, id: string, data: Record<string, unknown>, structured: boolean): Promise<void> {
    const existing = await this.overlay.getEntry(collection, id);
    if (existing?.data[PUBLISH_RECOVERY_KEY]) throw new Error("Finish pending publication before editing this draft");
    let state = existing ? readDraftState(existing.data) : null;
    // Legacy drafts retain their unknown baseline and are rejected at publish.
    if (this.trackDrafts && !existing) {
      state = { version: 1, baseRevision: await this.base.getRevision(collection, id),
        baseData: (await this.base.getEntry(collection, id))?.data ?? null, structured };
    }
    if (state) state = { ...state, structured: state.structured || structured };
    await this.overlay.writeEntry(collection, id, { ...contentWithoutState(data),
      ...(state ? { [DRAFT_STATE_KEY]: state } : {}) });
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    // Write a tombstone instead of deleting. A plain overlay delete would be
    // a no-op for any entry that lives only in the base, and the next read
    // would resurrect it from the seeded data.
    await this.writeDraft(collection, id, { [TOMBSTONE_KEY]: true }, true);
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

  async commitEntries(changes: readonly EntryCommit[]): Promise<EntryCommitResult> {
    const prepared: EntryCommit[] = [];
    for (const change of changes) {
      const existing = await this.overlay.getEntry(change.collection, change.id);
      if (existing?.data[PUBLISH_RECOVERY_KEY]) {
        throw new Error("Finish pending publication before editing this draft");
      }
      let state = existing ? readDraftState(existing.data) : null;
      const structured = change.writeMode !== "body";
      if (this.trackDrafts && !existing) {
        state = {
          version: 1,
          baseRevision: await this.base.getRevision(change.collection, change.id),
          baseData: (await this.base.getEntry(change.collection, change.id))?.data ?? null,
          structured,
        };
      }
      if (state) state = { ...state, structured: state.structured || structured };
      const content = change.data === null ? { [TOMBSTONE_KEY]: true } : change.data;
      prepared.push({
        ...change,
        expectedExists: Boolean(existing),
        data: {
          ...contentWithoutState(content),
          ...(state ? { [DRAFT_STATE_KEY]: state } : {}),
        },
      });
    }

    if (this.overlay.commitEntries) return this.overlay.commitEntries(prepared);

    for (const change of prepared) {
      const [revision, entry] = await Promise.all([
        this.overlay.getRevision(change.collection, change.id),
        this.overlay.getEntry(change.collection, change.id),
      ]);
      if (revision !== change.expectedRevision || Boolean(entry) !== change.expectedExists) {
        return { ok: false, conflict: {
          collection: change.collection,
          id: change.id,
          currentRevision: revision,
          exists: Boolean(entry),
        } };
      }
    }

    const revisions: Array<{ collection: string; id: string; revision: number }> = [];
    for (const change of prepared) {
      await this.overlay.writeEntry(change.collection, change.id, change.data!);
      const revision = await this.overlay.bumpRevision(change.collection, change.id);
      if (change.history) {
        await this.overlay.appendHistory(change.collection, change.id, change.history);
      }
      revisions.push({ collection: change.collection, id: change.id, revision });
    }
    return { ok: true, revisions };
  }

  /** Body source always comes from the BASE — drafts shadow entry data, never
   *  the published `.md` file (the splice happens at publish, not draft, time). */
  async readBodySource(collection: string, id: string): Promise<string | null> {
    return this.base.readBodySource ? this.base.readBodySource(collection, id) : null;
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
