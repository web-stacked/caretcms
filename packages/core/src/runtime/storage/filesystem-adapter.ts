import { ContentReadError } from "../content-errors.js";
import type { DeploymentTarget, RebuildReceipt } from "../../types.js";
import { mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CollectionMetadata, EntryData, HistoryEntry, StorageAdapter } from "../../types.js";
import { atomicWrite } from "./atomic-write.js";
import { assertFilesystemRuntime } from "./fs-runtime.js";
import { SidecarMetaStore, listCollectionDirs } from "./sidecar-meta-store.js";
import { COLLECTION_NAME_RE, ENTRY_ID_RE, assertSafeEditorId } from "./id-contracts.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Reference StorageAdapter that stores each entry as a JSON file under
 * `.caret/data/<collection>/<id>.json`, delegating all revision, history, and
 * collection-metadata concerns to a shared `SidecarMetaStore` (`.caretcms/`).
 */
export class FilesystemAdapter implements StorageAdapter {
  private readonly dataRoot: string;
  private readonly meta: SidecarMetaStore;
  private readonly draftsRoot: string;

  constructor(options?: { dataRoot?: string; metaRoot?: string; draftsRoot?: string }) {
    assertFilesystemRuntime();
    this.dataRoot = options?.dataRoot ?? join(process.cwd(), ".caret", "data");
    const metaRoot = options?.metaRoot ?? join(process.cwd(), ".caretcms");
    this.meta = new SidecarMetaStore({ metaRoot });
    // Per-editor draft overlays live as sibling JSON stores under `<.caret>/drafts/`.
    this.draftsRoot = options?.draftsRoot ?? join(dirname(this.dataRoot), "drafts");
  }

  getRebuildReceipt(): Promise<RebuildReceipt | null> { return this.meta.getRebuildReceipt(); }
  setRebuildReceipt(receipt: RebuildReceipt | null): Promise<void> { return this.meta.setRebuildReceipt(receipt); }
  getDeploymentTarget(): Promise<DeploymentTarget | null> { return this.meta.getDeploymentTarget(); }
  setDeploymentTarget(target: DeploymentTarget | null): Promise<void> { return this.meta.setDeploymentTarget(target); }

  private collectionDir(collection: string): string {
    return join(this.dataRoot, collection);
  }

  /** The data root — what git stages for commit-on-publish (a no-op if it's
   *  gitignored, e.g. the default `.caret/data`). */
  committablePath(): string {
    return this.dataRoot;
  }

  /** A persistent draft overlay for one editor, as a sibling JSON store under
   *  `<.caret>/drafts/<editorId>/`. Same id → same on-disk store. */
  async makeEditorOverlay(editorId: string): Promise<StorageAdapter> {
    const safe = assertSafeEditorId(editorId);
    return new FilesystemAdapter({
      dataRoot: join(this.draftsRoot, safe, "data"),
      metaRoot: join(this.draftsRoot, safe, "meta"),
      draftsRoot: join(this.draftsRoot, safe, "nested-drafts"),
    });
  }

  // --- Collections ---

  async discoverCollections(): Promise<string[]> {
    const [fromData, fromMeta] = await Promise.all([
      listCollectionDirs(this.dataRoot),
      this.meta.listHistoryCollections(),
    ]);
    const merged = new Set([...fromData, ...fromMeta]);
    return [...merged].sort((a, b) => a.localeCompare(b));
  }

  async isKnownCollection(collection: string): Promise<boolean> {
    if (!COLLECTION_NAME_RE.test(collection)) return false;
    const collections = await this.discoverCollections();
    return collections.includes(collection);
  }

  // --- Entries ---

  async getEntry(collection: string, id: string): Promise<EntryData | null> {
    // Defense in depth, mirroring the markdown adapter: the mutation engine
    // validates before writes, but READS arrive straight from data-caret
    // attributes via the rewrite engine. An unvalidated id here both joins
    // arbitrary segments into a path and lets case-insensitive filesystems
    // (macOS dev) resolve ids that a case-sensitive deploy (Linux) won't —
    // a works-in-dev, breaks-in-prod trap.
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) return null;
    const filePath = join(this.collectionDir(collection), `${id}.json`);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const data = asObjectRecord(parsed);
      if (!data) throw new ContentReadError("invalid_content");
      return { id, data };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      if (error instanceof ContentReadError) throw error;
      throw new ContentReadError(error instanceof SyntaxError ? "invalid_content" : "storage_error");
    }
  }

  async listEntryIds(collection: string): Promise<string[]> {
    if (!COLLECTION_NAME_RE.test(collection)) return [];
    try {
      const files = await readdir(this.collectionDir(collection), { withFileTypes: true });
      return files
        .filter((item) => item.isFile() && item.name.endsWith(".json"))
        .map((item) => item.name.slice(0, -".json".length))
        .filter((stem) => ENTRY_ID_RE.test(stem))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async listEntries(collection: string): Promise<EntryData[]> {
    const ids = await this.listEntryIds(collection);
    const entries = await Promise.all(ids.map((id) => this.getEntry(collection, id)));
    return entries.filter((entry): entry is EntryData => Boolean(entry));
  }

  async writeEntry(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) {
      throw new Error(`[caretcms] invalid entry path ${collection}/${id}`);
    }
    const dir = this.collectionDir(collection);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${id}.json`);
    await atomicWrite(filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) return;
    const filePath = join(this.collectionDir(collection), `${id}.json`);
    try {
      await unlink(filePath);
    } catch (error) {
      const maybeErr = error as { code?: string };
      if (maybeErr?.code === "ENOENT") return;
      throw error;
    }
  }

  // --- Revisions (delegated) ---

  getRevision(collection: string, id: string): Promise<number> {
    return this.meta.getRevision(collection, id);
  }

  bumpRevision(collection: string, id: string): Promise<number> {
    return this.meta.bumpRevision(collection, id);
  }

  // --- History (delegated) ---

  getHistory(collection: string, id: string): Promise<HistoryEntry[]> {
    return this.meta.getHistory(collection, id);
  }

  appendHistory(collection: string, id: string, entry: HistoryEntry): Promise<void> {
    return this.meta.appendHistory(collection, id, entry);
  }

  // --- Collection management ---

  async createCollection(metadata: CollectionMetadata): Promise<void> {
    await this.meta.createCollection(metadata);
    // The JSON adapter owns its data directory, so create it eagerly.
    await mkdir(this.collectionDir(metadata.id), { recursive: true });
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.meta.deleteCollection(collection);
    // The JSON adapter owns its entry files, so removing the collection removes
    // its data directory too.
    await rm(this.collectionDir(collection), { recursive: true, force: true });
  }

  getCollectionMetadata(collection: string): Promise<CollectionMetadata | null> {
    return this.meta.getCollectionMetadata(collection);
  }

  listCollectionMetadata(): Promise<CollectionMetadata[]> {
    return this.meta.listCollectionMetadata();
  }
}
