import { DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY, contentWithoutState, isStaleDraft, readDraftState, rebaseDraft, sameContent, TEMPLATE_TEXT_KEY, type DraftState } from "../draft-state.js";
import { draftTemplateRecord } from "../template-text.js";
import { readAdapterSnapshot, readAdapterSnapshots } from "./read-snapshot.js";
import { commitEntryChanges } from "./entry-commit.js";
import { BODY_OVERLAY_KEY } from "../../markdown/contracts.js";
import { canonicalBody } from "../../markdown/canonical-body.js";
import { reanchorBodyDrafts } from "../../markdown/splice.js";
import type {
  CollectionMetadata,
  EntryCommit,
  EntryCommitResult,
  EntryData,
  EntrySnapshot,
  DraftBaseline,
  DraftGuard,
  DraftCoordinator,
  HistoryEntry,
  DeploymentTarget,
  RebuildReceipt,
  StorageAdapter,
  StorageGuarantees,
} from "../../types.js";

/** A structured draft and the published entry disagree on these fields. */
export interface DraftConflict {
  collection: string;
  id: string;
  /** The published entry was deleted after the draft was started. */
  removed: boolean;
  fields: Array<{ field: string; mine: unknown; site: unknown }>;
  /** The editor's Markdown for each body block that changed in the source since they edited it. */
  body: string[];
}

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
 * Structured editor drafts keep a full snapshot and the published entry they
 * started from. Reads carry the draft over to the current published entry, so
 * a later change to it shows through wherever the editor didn't edit. Body-only
 * drafts and demo overlays merge over base.
 *
 * Deletes write a tombstone sentinel into the overlay rather than removing the
 * overlay key, so deleting a base-only entry stays deleted for the session
 * instead of falling through to the seeded value on the next read.
 */
export class SessionOverlayAdapter implements StorageAdapter {
  private readonly coordinator: DraftCoordinator | undefined;
  /** Separate stores remain weaker unless the adapter supplies a bound coordinator. */
  get guarantees(): Readonly<StorageGuarantees> | undefined {
    const base = this.base.guarantees, overlay = this.overlay.guarantees;
    if (!base || !overlay) return undefined;
    return Object.freeze({ persistence: overlay.persistence, collectionDeletion: overlay.collectionDeletion,
      snapshots: this.coordinator ? "transactional" : base.snapshots === "eventual" || overlay.snapshots === "eventual" ? "eventual" : "process",
      commits: this.coordinator ? "transactional" : base.commits === "single-writer" || overlay.commits === "single-writer" ? "single-writer" : "process" });
  }
  constructor(
    private readonly base: StorageAdapter,
    private readonly overlay: StorageAdapter,
    private readonly trackDrafts = true,
  ) { this.coordinator = trackDrafts ? overlay.coordinateDrafts?.(base) : undefined; }

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

  /**
   * What the editor sees for an entry they hold a draft of. A structured
   * draft is carried over to the current published entry (`rebaseDraft`), so
   * only the fields the editor changed differ from it. Body-only drafts and
   * demo overlays merge over the published entry.
   */
  private view(own: EntryData, base: EntryData | null): EntryData {
    const state = readDraftState(own.data);
    const content = contentWithoutState(own.data);
    if (state?.structured) {
      const { [TEMPLATE_TEXT_KEY]: _own, ...data } = rebaseDraft(state, content, base?.data ?? null).data;
      const record = draftTemplateRecord(data, base?.data ?? null);
      return { ...own, data: record ? { ...data, [TEMPLATE_TEXT_KEY]: record } : data };
    }
    return { ...own, data: base ? { ...base.data, ...content } : content };
  }

  /**
   * A structured save onto a draft whose published entry has moved. When
   * nothing collides, the draft restarts from the current published entry:
   * it keeps only the editor's own changes, and a later published change is
   * compared with what the editor last saw rather than with the first base.
   * A draft in conflict keeps its original baseline until the editor decides.
   */
  private restart(state: DraftState | null, data: Record<string, unknown>, base: EntrySnapshot): { state: DraftState | null; data: Record<string, unknown> } {
    const content = contentWithoutState(data);
    if (!state?.structured || content[TOMBSTONE_KEY] === true) return { state, data: content };
    const published = base.entry?.data ?? null;
    if (!isStaleDraft(state, published)) return { state, data: content };
    const carried = rebaseDraft(state, content, published);
    if (carried.conflicts.length || carried.removed) return { state, data: content };
    return { state: { ...state, baseRevision: base.revision, baseData: published }, data: carried.data };
  }

  async getEntry(collection: string, id: string): Promise<EntryData | null> {
    if (this.coordinator) return (await this.getEntrySnapshot(collection, id)).entry;
    const overlaid = await this.overlay.getEntry(collection, id);
    if (isTombstone(overlaid)) return null;
    if (!overlaid) return this.base.getEntry(collection, id);
    return this.view(overlaid, await this.base.getEntry(collection, id));
  }

  async getEntrySnapshot(collection: string, id: string): Promise<EntrySnapshot> {
    return (await this.getEntrySnapshots(collection, [id]))[0];
  }

  async getEntrySnapshots(collection: string, ids: readonly string[]): Promise<EntrySnapshot[]> {
    const paired = this.coordinator
      ? await this.coordinator.getEntrySnapshots(collection, ids)
      : await this.pairedSnapshots(collection, ids);
    return paired.map(({ overlay: own, base }) => {
      if (isTombstone(own.entry)) return { entry: null, revision: own.revision };
      if (own.entry && readDraftState(own.entry.data)?.structured) {
        return { entry: this.view(own.entry, base.entry), revision: own.revision };
      }
      return { entry: own.entry ? this.view(own.entry, base.entry) : base.entry,
        revision: own.revision, ...(this.trackDrafts || this.coordinator ? { baseRevision: base.revision } : {}) };
    });
  }

  /** Each id's own draft beside its published entry. Tombstones need no published read. */
  private async pairedSnapshots(collection: string, ids: readonly string[]): Promise<Array<{ overlay: EntrySnapshot; base: EntrySnapshot }>> {
    const own = await readAdapterSnapshots(this.overlay, collection, ids);
    const needed = own.map((snapshot, index) => ({ snapshot, index })).filter(({ snapshot }) => !isTombstone(snapshot.entry));
    const base = await readAdapterSnapshots(this.base, collection, needed.map(({ index }) => ids[index]));
    const bases = new Map(needed.map(({ index }, position) => [index, base[position]]));
    return own.map((snapshot, index) => ({ overlay: snapshot, base: bases.get(index) ?? { entry: null, revision: 0 } }));
  }

  /** Body drafts whose block can't be found in the current source: its text changed, or several identical blocks could be meant. */
  private async lostBodyDrafts(collection: string, id: string, own: EntryData): Promise<string[]> {
    const drafts = own.data[BODY_OVERLAY_KEY];
    if (!drafts || typeof drafts !== "object" || !this.base.readBodySource) return [];
    const source = await this.base.readBodySource(collection, id);
    if (source === null) return Object.keys(drafts);
    return reanchorBodyDrafts(canonicalBody(source).body, drafts as Record<string, unknown>).lost;
  }

  /**
   * What stops this editor's draft of an entry from publishing: fields that
   * also changed on the published entry (each with both values), and body
   * text whose block changed in the source. Null when nothing does.
   */
  async draftConflict(collection: string, id: string): Promise<DraftConflict | null> {
    const own = await this.overlay.getEntry(collection, id);
    if (!own || isTombstone(own)) return null;
    const state = readDraftState(own.data);
    const base = (await this.base.getEntry(collection, id))?.data ?? null;
    const carried = state?.structured ? rebaseDraft(state, contentWithoutState(own.data), base) : null;
    const lost = await this.lostBodyDrafts(collection, id, own);
    if (!carried?.conflicts.length && !carried?.removed && !lost.length) return null;
    const drafts = (own.data[BODY_OVERLAY_KEY] ?? {}) as Record<string, { md?: unknown }>;
    return { collection, id, removed: carried?.removed ?? false,
      fields: (carried?.conflicts ?? []).map(field => ({ field, mine: carried!.data[field], site: base?.[field] })),
      body: lost.map(path => (typeof drafts[path]?.md === "string" ? drafts[path].md as string : "")) };
  }

  /**
   * Settle a draft in conflict. "mine" keeps the editor's field values and
   * restarts the draft from the current published entry, so Publish puts them
   * on top. "site" takes the published values for the fields in conflict,
   * drops body text whose block changed, and keeps the editor's other changes;
   * a draft left with no change of its own is dropped. Body text can't be
   * kept over a block that changed, so "mine" leaves it for the editor to copy.
   * Returns false when the draft was not in conflict.
   */
  async resolveDraftConflict(collection: string, id: string, keep: "mine" | "site"): Promise<boolean> {
    const revision = await this.overlay.getRevision(collection, id);
    const own = await this.overlay.getEntry(collection, id);
    if (own?.data[PUBLISH_RECOVERY_KEY]) throw new Error("Finish pending publication before editing this draft");
    if (!own || isTombstone(own)) return false;
    const state = readDraftState(own.data);
    const base = await readAdapterSnapshot(this.base, collection, id);
    const published = base.entry?.data ?? null;
    const content = contentWithoutState(own.data);
    const carried = state?.structured ? rebaseDraft(state, content, published) : null;
    const lost = keep === "site" ? await this.lostBodyDrafts(collection, id, own) : [];
    const fieldsCollide = Boolean(carried?.conflicts.length || carried?.removed);
    if (!fieldsCollide && !lost.length) return false;

    let data: Record<string, unknown> | null = { ...(carried?.data ?? content) };
    if (keep === "site") {
      for (const field of carried?.conflicts ?? []) {
        if (published && Object.hasOwn(published, field)) data[field] = published[field];
        else delete data[field];
      }
      if (lost.length) {
        const body = { ...(data[BODY_OVERLAY_KEY] as Record<string, unknown>) };
        for (const path of lost) delete body[path];
        if (Object.keys(body).length) data[BODY_OVERLAY_KEY] = body;
        else delete data[BODY_OVERLAY_KEY];
      }
      // Nothing of the editor's own is left: the draft is over.
      const own = (entry: Record<string, unknown> | null) => entry && Object.fromEntries(Object.entries(entry).filter(([key]) => key !== TEMPLATE_TEXT_KEY));
      const nothingLeft = state?.structured ? sameContent(own(data), own(published)) : Object.keys(data).length === 0;
      if (carried?.removed || nothingLeft) data = null;
    }
    const nextState = state && fieldsCollide ? { ...state, baseRevision: base.revision, baseData: published } : state;
    const settled = await commitEntryChanges(this.overlay, [{ collection, id, expectedRevision: revision, expectedExists: true,
      data: data && { ...data, ...(nextState ? { [DRAFT_STATE_KEY]: nextState } : {}) } }]);
    if (!settled.ok) throw new Error("Draft changed while it was being settled");
    return true;
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

  /** Ids this session holds its own copy of (edited or deleted), whether or not it still differs from base. */
  draftIds(collection: string): Promise<string[]> {
    return this.overlay.listEntryIds(collection);
  }

  /** Collections this session holds its own copies in. */
  draftCollections(): Promise<string[]> {
    return this.overlay.discoverCollections();
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
    if (this.trackDrafts && (!existing || (state && !state.structured && structured))) {
      const base = await readAdapterSnapshot(this.base, collection, id);
      state = { version: 1, baseRevision: base.revision,
        baseData: base.entry?.data ?? null, structured };
    }
    let content = contentWithoutState(data);
    if (this.trackDrafts && existing && state?.structured && structured) {
      ({ state, data: content } = this.restart(state, content, await readAdapterSnapshot(this.base, collection, id)));
    }
    if (state) state = { ...state, structured: state.structured || structured };
    await this.overlay.writeEntry(collection, id, { ...content,
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
    const baselines: DraftBaseline[] = [];
    const guards: DraftGuard[] = [];
    for (const change of changes) {
      const paired = this.coordinator ? (await this.coordinator.getEntrySnapshots(change.collection, [change.id]))[0] : undefined;
      const existing = paired ? paired.overlay.entry : await this.overlay.getEntry(change.collection, change.id);
      guards.push({ collection: change.collection, id: change.id, data: existing?.data ?? null });
      if (existing?.data[PUBLISH_RECOVERY_KEY]) {
        throw new Error("Finish pending publication before editing this draft");
      }
      let state = existing ? readDraftState(existing.data) : null;
      const structured = change.writeMode !== "body";
      // A body-only view continues to merge current base fields. Its first
      // structured write therefore needs the baseline observed by that client,
      // not the older baseline captured when the body draft was created.
      if (this.trackDrafts && (!existing || (state && !state.structured && structured))) {
        const base = paired?.base ?? await readAdapterSnapshot(this.base, change.collection, change.id);
        if (structured && ((change.requireBaseRevision && change.expectedBaseRevision === undefined) ||
            (change.expectedBaseRevision !== undefined && change.expectedBaseRevision !== base.revision))) {
          return { ok: false, conflict: { collection: change.collection, id: change.id,
            currentRevision: await this.overlay.getRevision(change.collection, change.id),
            currentBaseRevision: base.revision, exists: Boolean(existing) } };
        }
        state = {
          version: 1,
          baseRevision: base.revision,
          baseData: base.entry?.data ?? null,
          structured,
        };
        baselines.push({ collection: change.collection, id: change.id, revision: base.revision });
      }
      let content: Record<string, unknown> = contentWithoutState(change.data === null ? { [TOMBSTONE_KEY]: true } : change.data);
      if (this.trackDrafts && existing && state?.structured && structured && change.data !== null) {
        const base = paired?.base ?? await readAdapterSnapshot(this.base, change.collection, change.id);
        ({ state, data: content } = this.restart(state, content, base));
      }
      if (state) state = { ...state, structured: state.structured || structured };
      prepared.push({
        ...change,
        expectedExists: Boolean(existing),
        data: {
          ...content,
          ...(state ? { [DRAFT_STATE_KEY]: state } : {}),
        },
      });
    }

    if (this.coordinator) return this.coordinator.commitEntries(prepared, baselines, guards);
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

  async isDocumentCollection(collection: string): Promise<boolean> {
    return this.base.isDocumentCollection ? this.base.isDocumentCollection(collection) : true;
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
