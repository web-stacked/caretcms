import { ContentReadError } from "../content-errors.js";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CollectionMetadata, EntryData, EntrySnapshot, HistoryEntry, StorageAdapter, PublicationSourceSnapshot } from "../../types.js";
import { atomicWrite } from "./atomic-write.js";
import { assertFilesystemRuntime } from "./fs-runtime.js";
import { SidecarMetaStore, listCollectionDirs } from "./sidecar-meta-store.js";
import { COLLECTION_NAME_RE, ENTRY_ID_RE, assertSafeEditorId } from "./id-contracts.js";
import { parseFrontmatter, rewriteFrontmatter } from "./frontmatter-codec.js";
import { spliceBodyBlocks as spliceBodyBlocksInSource } from "../../markdown/splice.js";
import { FilesystemAdapter } from "./filesystem-adapter.js";
import { dataFileIds, parseDataFile, readDataEntry, writeDataEntry, type DataFile } from "./data-file-codec.js";

// .md is preferred over .mdx when both exist for the same id (simpler format,
// and an MDX body is more fragile). Order matters: first match wins on read.
const EXTENSIONS = [".md", ".mdx"] as const;

// Writes to one data file (many entries) are serialized per path, process-wide,
// so two saves to different entries cannot overwrite each other.
const dataFileQueues = new Map<string, Promise<unknown>>();
function queueDataFileWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = dataFileQueues.get(path) ?? Promise.resolve();
  const run = previous.then(task, task);
  dataFileQueues.set(path, run.catch(() => undefined));
  return run;
}

/**
 * StorageAdapter over Astro file-based content collections.
 *
 * Maps `<contentRoot>/<collection>/<id>.{md,mdx}` to entries: YAML frontmatter
 * becomes the entry `data`, and edits are written back IN-PLACE — the markdown
 * body (everything after the closing `---`, including MDX JSX/imports) is
 * spliced through byte-for-byte. Body block drafts publish through prepared,
 * hash-checked source replacements, with sidecar recovery metadata.
 *
 * A collection with no Markdown directory may instead be an Astro `file()`
 * data file, `<contentRoot>/<collection>.json` (an array of objects with `id`,
 * or an object keyed by id). Its entries are read and written in place inside
 * that one file; see `data-file-codec.ts`.
 *
 * Revisions, history, and collection metadata live in the `.caretcms/` sidecar
 * (shared `SidecarMetaStore`), so the source `.md` files stay free of CMS state.
 *
 * v1 boundaries (intentional):
 *  - Flat collection directories only (no nested-slug subdirectories).
 *  - Filenames whose stem fails the entry-id contract are ignored.
 *  - `deleteCollection` never deletes source content — only sidecar state.
 *  - `makeSessionOverlay` is intentionally not implemented: ephemeral demo
 *    overlays make no sense for a source-file-backed adapter. `makeEditorOverlay`
 *    (persistent drafts) IS supported — it delegates to a JSON-backed
 *    `FilesystemAdapter` under `.caret/drafts/`, so the source `.md` files stay
 *    pristine until an explicit Publish flushes a draft back in.
 */
export class MarkdownAdapter implements StorageAdapter {
  readonly guarantees = Object.freeze({ persistence: "durable", snapshots: "process",
    commits: "process", collectionDeletion: "metadata" } as const);

  async getEntrySnapshots(collection: string, ids: readonly string[]): Promise<EntrySnapshot[]> {
    if (!ids.length) return [];
    const [entries, revisions] = await Promise.all([
      Promise.all(ids.map(id => this.getEntry(collection, id))), this.meta.getRevisions(collection, ids),
    ]);
    return entries.map((entry, index) => ({ entry, revision: revisions[index] }));
  }
  private readonly contentRoot: string;
  private readonly meta: SidecarMetaStore;
  private readonly draftsRoot: string;

  constructor(options?: { contentRoot?: string; metaRoot?: string; draftsRoot?: string }) {
    assertFilesystemRuntime();
    this.contentRoot = options?.contentRoot ?? join(process.cwd(), "src", "content");
    const metaRoot = options?.metaRoot ?? join(process.cwd(), ".caretcms");
    this.meta = new SidecarMetaStore({ metaRoot });
    this.draftsRoot = options?.draftsRoot ?? join(process.cwd(), ".caret", "drafts");
  }

  /** A persistent draft overlay for one editor. Drafts are JSON-backed (a
   *  `FilesystemAdapter`) so editing a markdown collection's frontmatter never
   *  touches the source `.md` until Publish. Same id → same on-disk store. */
  async makeEditorOverlay(editorId: string): Promise<StorageAdapter> {
    const safe = assertSafeEditorId(editorId);
    return new FilesystemAdapter({
      dataRoot: join(this.draftsRoot, safe, "data"),
      metaRoot: join(this.draftsRoot, safe, "meta"),
    });
  }

  async makeRecoveryOverlay(editorId: string, purpose: "source-restore"): Promise<StorageAdapter> {
    const safe = assertSafeEditorId(editorId);
    if (purpose !== "source-restore") throw new Error("Invalid recovery purpose");
    const root = join(this.draftsRoot, safe, "recovery", purpose);
    return new FilesystemAdapter({ dataRoot: join(root, "data"), metaRoot: join(root, "meta") });
  }

  private collectionDir(collection: string): string {
    return join(this.contentRoot, collection);
  }

  private dataFilePath(collection: string): string {
    return join(this.contentRoot, `${collection}.json`);
  }

  private async readDataFile(collection: string): Promise<{ path: string; file: DataFile } | null> {
    if (!COLLECTION_NAME_RE.test(collection)) return null;
    const path = this.dataFilePath(collection);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw new ContentReadError("storage_error");
    }
    const file = parseDataFile(source);
    return file ? { path, file } : null;
  }

  /** Markdown documents unless the collection exists only as a data file. */
  async isDocumentCollection(collection: string): Promise<boolean> {
    if ((await this.listDocumentIds(collection)).length > 0) return true;
    return (await this.readDataFile(collection)) === null;
  }

  /** The collection's data file, when it is a data collection. */
  private async dataCollection(collection: string): Promise<{ path: string; file: DataFile } | null> {
    return (await this.isDocumentCollection(collection)) ? null : this.readDataFile(collection);
  }

  /** The content root — what git stages for commit-on-publish. */
  committablePath(): string {
    return this.contentRoot;
  }

  async committableEntryPaths(collection: string, id: string, deleted: boolean): Promise<string[]> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) throw new Error("Invalid entry path");
    const data = await this.dataCollection(collection);
    if (data) return [data.path];
    if (deleted) return EXTENSIONS.map(ext => join(this.collectionDir(collection), `${id}${ext}`));
    return [await this.resolveEntryPath(collection, id) ?? join(this.collectionDir(collection), `${id}.md`)];
  }

  async preparePublicationSources(
    collection: string, id: string, data: Record<string, unknown> | null, preparedSource?: string,
  ): Promise<PublicationSourceSnapshot[]> {
    const dataFile = await this.dataCollection(collection);
    if (dataFile) return [{ path: dataFile.path, content: writeDataEntry(dataFile.file, id, data) }];
    const paths = await this.committableEntryPaths(collection, id, data === null);
    if (data === null) return paths.map(path => ({ path, content: null }));
    if (preparedSource !== undefined) return [{ path: paths[0], content: preparedSource }];
    // The publisher supplies the complete prepared source for existing files.
    // Only a brand-new entry may serialize from an empty source here.
    if (await this.resolveEntryPath(collection, id)) throw new Error("Prepared source is required for Markdown publication");
    const result = rewriteFrontmatter("", data);
    if (!result.ok) throw new Error("Cannot prepare publication source");
    return [{ path: paths[0], content: result.content }];
  }

  /** First existing `<id>.{md,mdx}` path for an entry, honoring .md precedence. */
  private async resolveEntryPath(collection: string, id: string): Promise<string | null> {
    for (const ext of EXTENSIONS) {
      const path = join(this.collectionDir(collection), `${id}${ext}`);
      try {
        if ((await stat(path)).isFile()) return path;
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw new ContentReadError("storage_error");
      }
    }
    return null;
  }

  // --- Collections ---

  async discoverCollections(): Promise<string[]> {
    // Unlike the JSON adapter, createCollection here does NOT create a content
    // directory, so a freshly-created collection is visible only via its sidecar
    // metadata until it has entries — include that as a third discovery source.
    const [fromContent, fromDataFiles, fromHistory, metadata] = await Promise.all([
      listCollectionDirs(this.contentRoot),
      this.listDataFileCollections(),
      this.meta.listHistoryCollections(),
      this.meta.listCollectionMetadata(),
    ]);
    const merged = new Set([...fromContent, ...fromDataFiles, ...fromHistory, ...metadata.map((m) => m.id)]);
    return [...merged].sort((a, b) => a.localeCompare(b));
  }

  private async listDataFileCollections(): Promise<string[]> {
    let files: import("node:fs").Dirent[];
    try {
      files = await readdir(this.contentRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const names = files.filter((file) => file.isFile() && file.name.endsWith(".json"))
      .map((file) => file.name.slice(0, -".json".length)).filter((name) => COLLECTION_NAME_RE.test(name));
    const valid = await Promise.all(names.map(async (name) => (await this.readDataFile(name).catch(() => null)) !== null));
    return names.filter((_, index) => valid[index]);
  }

  async isKnownCollection(collection: string): Promise<boolean> {
    if (!COLLECTION_NAME_RE.test(collection)) return false;
    const collections = await this.discoverCollections();
    return collections.includes(collection);
  }

  // --- Entries ---

  /** Raw source file (frontmatter + body) for body-editing hash checks/splices. */
  async readBodySource(collection: string, id: string): Promise<string | null> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) return null;
    if (!(await this.isDocumentCollection(collection))) return null;
    const path = await this.resolveEntryPath(collection, id);
    if (!path) return null;
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw new ContentReadError("storage_error");
    }
  }

  /** Publish-time body flush: verify + apply drafted block edits to the source
   *  file, all-or-nothing (`markdown/splice.ts`). File untouched on failure. */
  async spliceBodyBlocks(
    collection: string,
    id: string,
    blocks: ReadonlyArray<{ md: string; src: { start: number; end: number; hash: string } }>,
  ): Promise<{ ok: true } | { ok: false; reason: "stale" | "overlap" | "missing" }> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) {
      return { ok: false, reason: "missing" };
    }
    if (!(await this.isDocumentCollection(collection))) return { ok: false, reason: "missing" };
    const path = await this.resolveEntryPath(collection, id);
    if (!path) return { ok: false, reason: "missing" };
    const source = await readFile(path, "utf8");
    const result = spliceBodyBlocksInSource(source, blocks);
    if (!result.ok) return { ok: false, reason: result.reason };
    await atomicWrite(path, result.content);
    return { ok: true };
  }

  /** Restore an entry's full source file (history `bodySource` snapshots). */
  async writeBodySource(collection: string, id: string, source: string): Promise<void> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) {
      throw new Error(`[caretcms] invalid entry path ${collection}/${id}`);
    }
    if (!(await this.isDocumentCollection(collection))) {
      throw new Error(`[caretcms] ${collection} is a data file; its entries have no document source`);
    }
    const dir = this.collectionDir(collection);
    await mkdir(dir, { recursive: true });
    const path = (await this.resolveEntryPath(collection, id)) ?? join(dir, `${id}.md`);
    await atomicWrite(path, source);
  }

  async getEntry(collection: string, id: string): Promise<EntryData | null> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) return null;
    const dataFile = await this.dataCollection(collection);
    if (dataFile) {
      const data = readDataEntry(dataFile.file, id);
      return data ? { id, data } : null;
    }
    const path = await this.resolveEntryPath(collection, id);
    if (!path) return null;

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw new ContentReadError("storage_error");
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed.ok) {
      // Fail loud: returning empty data here would let a later whole-entry write
      // silently overwrite frontmatter we couldn't read.
      throw new ContentReadError(parsed.reason.includes("not supported") ? "unsupported_content" : "invalid_content");
    }
    return { id, data: parsed.data };
  }

  async listEntryIds(collection: string): Promise<string[]> {
    const documents = await this.listDocumentIds(collection);
    if (documents.length) return documents;
    const dataFile = await this.readDataFile(collection);
    return dataFile ? dataFileIds(dataFile.file) : [];
  }

  private async listDocumentIds(collection: string): Promise<string[]> {
    if (!COLLECTION_NAME_RE.test(collection)) return [];
    let files: import("node:fs").Dirent[];
    try {
      files = await readdir(this.collectionDir(collection), { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = new Set<string>();
    for (const file of files) {
      if (!file.isFile()) continue;
      const ext = EXTENSIONS.find((e) => file.name.endsWith(e));
      if (!ext) continue;
      const stem = file.name.slice(0, -ext.length);
      if (ENTRY_ID_RE.test(stem)) ids.add(stem);
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  async listEntries(collection: string): Promise<EntryData[]> {
    const ids = await this.listEntryIds(collection);
    const out: EntryData[] = [];
    for (const id of ids) {
      try {
        const entry = await this.getEntry(collection, id);
        if (entry) out.push(entry);
      } catch (error) {
        // One malformed file must not blank the whole collection on the read
        // path; skip it (single-entry writes still fail loud via getEntry).
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[caretcms] skipping ${collection}/${id}: ${reason}`);
      }
    }
    return out;
  }

  async writeEntry(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) {
      throw new Error(`[caretcms] invalid entry path ${collection}/${id}`);
    }

    if (!(await this.isDocumentCollection(collection))) {
      const path = this.dataFilePath(collection);
      await queueDataFileWrite(path, async () => {
        const current = await this.readDataFile(collection);
        if (!current) throw new Error(`[caretcms] Refusing to overwrite ${collection}: its data file changed shape`);
        await atomicWrite(path, writeDataEntry(current.file, id, data));
      });
      return;
    }

    const existing = await this.resolveEntryPath(collection, id);
    const original = existing ? await readFile(existing, "utf8") : "";
    const serialized = rewriteFrontmatter(original, data);
    if (!serialized.ok) {
      throw new Error(`[caretcms] Refusing to overwrite ${collection}/${id}: ${serialized.reason}`);
    }

    const dir = this.collectionDir(collection);
    await mkdir(dir, { recursive: true });
    const writePath = existing ?? join(dir, `${id}.md`);
    await atomicWrite(writePath, serialized.content);
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) return;
    if (!(await this.isDocumentCollection(collection))) {
      const path = this.dataFilePath(collection);
      await queueDataFileWrite(path, async () => {
        const current = await this.readDataFile(collection);
        if (current && readDataEntry(current.file, id)) await atomicWrite(path, writeDataEntry(current.file, id, null));
      });
      return;
    }
    // Remove every form so a .md delete doesn't merely un-shadow a sibling .mdx.
    for (const ext of EXTENSIONS) {
      const path = join(this.collectionDir(collection), `${id}${ext}`);
      try {
        await unlink(path);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== "ENOENT") throw error;
      }
    }
  }

  // --- Revisions / history (delegated to the sidecar store) ---

  getRevision(collection: string, id: string): Promise<number> {
    return this.meta.getRevision(collection, id);
  }

  bumpRevision(collection: string, id: string): Promise<number> {
    return this.meta.bumpRevision(collection, id);
  }

  getHistory(collection: string, id: string): Promise<HistoryEntry[]> {
    return this.meta.getHistory(collection, id);
  }

  appendHistory(collection: string, id: string, entry: HistoryEntry): Promise<void> {
    return this.meta.appendHistory(collection, id, entry);
  }

  // --- Collection management ---

  /** Sidecar metadata only — the content directory is owned by the project. */
  createCollection(metadata: CollectionMetadata): Promise<void> {
    return this.meta.createCollection(metadata);
  }

  /**
   * Removes only sidecar state (metadata + history). It deliberately does NOT
   * delete `src/content/<collection>/` — destroying version-controlled source
   * content through a CMS runtime call is never acceptable.
   */
  deleteCollection(collection: string): Promise<void> {
    return this.meta.deleteCollection(collection);
  }

  getCollectionMetadata(collection: string): Promise<CollectionMetadata | null> {
    return this.meta.getCollectionMetadata(collection);
  }

  listCollectionMetadata(): Promise<CollectionMetadata[]> {
    return this.meta.listCollectionMetadata();
  }
}
