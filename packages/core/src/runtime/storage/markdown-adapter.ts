import { ContentReadError } from "../content-errors.js";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CollectionMetadata, EntryData, EntrySnapshot, HistoryEntry, StorageAdapter, PublicationSourceSnapshot } from "../../types.js";
import { atomicWrite } from "./atomic-write.js";
import { assertFilesystemRuntime } from "./fs-runtime.js";
import { SidecarMetaStore, listCollectionDirs } from "./sidecar-meta-store.js";
import { COLLECTION_NAME_RE, ENTRY_ID_RE, assertSafeEditorId } from "./id-contracts.js";
import { parseFrontmatter, rewriteFrontmatter } from "./frontmatter-codec.js";
import { spliceBodyBlocks as spliceBodyBlocksInSource } from "../../markdown/splice.js";
import { FilesystemAdapter } from "./filesystem-adapter.js";
import { dataFileIds, parseDataFile, readDataEntry, writeDataEntry, type DataFile } from "./data-file-codec.js";
import { contentConfigDataFiles } from "./content-config.js";

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
 * Maps `<contentRoot>/<collection>/<id>.{md,mdx}` to entries, where the id may
 * be a path into sub-folders (`en/post-1`) as Astro names them: YAML frontmatter
 * becomes the entry `data`, and edits are written back IN-PLACE — the markdown
 * body (everything after the closing `---`, including MDX JSX/imports) is
 * spliced through byte-for-byte. Body block drafts publish through prepared,
 * hash-checked source replacements, with sidecar recovery metadata.
 *
 * A collection with no Markdown directory may instead be an Astro `file()`
 * data file: the JSON file its `file("…")` loader names in the project's
 * content config (wherever it lives, e.g. `src/data/menu.json`), or else
 * `<contentRoot>/<collection>.json`. A `file()` file is an array of objects
 * with `id` or an object keyed by id. Its entries are read and written in
 * place inside that one file; see `data-file-codec.ts`.
 *
 * Revisions, history, and collection metadata live in the `.caretcms/` sidecar
 * (shared `SidecarMetaStore`), so the source `.md` files stay free of CMS state.
 *
 * v1 boundaries (intentional):
 *  - Files and folders whose name fails the entry-id contract are ignored.
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
  private readonly projectRoot: string;
  private readonly meta: SidecarMetaStore;
  private readonly draftsRoot: string;

  constructor(options?: { contentRoot?: string; metaRoot?: string; draftsRoot?: string; projectRoot?: string }) {
    assertFilesystemRuntime();
    this.projectRoot = options?.projectRoot ?? process.cwd();
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

  /** JSON files the content config's `file()` loaders name, by collection. */
  private configuredDataFiles(): Map<string, string> {
    return contentConfigDataFiles(this.projectRoot);
  }

  private dataFilePath(collection: string): string {
    return this.configuredDataFiles().get(collection) ?? join(this.contentRoot, `${collection}.json`);
  }

  private async readDataFile(collection: string): Promise<{ path: string; file: DataFile } | null> {
    if (!COLLECTION_NAME_RE.test(collection)) return null;
    const configured = this.configuredDataFiles().get(collection);
    const path = configured ?? join(this.contentRoot, `${collection}.json`);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw new ContentReadError("storage_error");
    }
    const file = parseDataFile(source, collection);
    // A `file()` loader reads only an array of entries or an object of them;
    // anything else (a parser that picks a nested key) can't be mapped safely.
    if (!file || (configured && file.shape === "single")) return null;
    return { path, file };
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
    if (deleted) return this.entryPaths(collection, id);
    return [await this.resolveEntryPath(collection, id) ?? this.newEntryPath(collection, id)];
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

  /**
   * Every file an entry can live in, in reading order: `<id>.md` before
   * `<id>.mdx`, then `<id>/index.*`, which Astro gives the same id.
   */
  private entryPaths(collection: string, id: string): string[] {
    const base = join(this.collectionDir(collection), ...id.split("/"));
    return [...EXTENSIONS.map(ext => `${base}${ext}`), ...EXTENSIONS.map(ext => join(base, `index${ext}`))];
  }

  /** Where an entry that has no file yet is written. */
  private newEntryPath(collection: string, id: string): string {
    return this.entryPaths(collection, id)[0];
  }

  /** The existing file of an entry, or null. */
  private async resolveEntryPath(collection: string, id: string): Promise<string | null> {
    for (const path of this.entryPaths(collection, id)) {
      try {
        if ((await stat(path)).isFile()) return path;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw new ContentReadError("storage_error");
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
    let files: import("node:fs").Dirent[] = [];
    try {
      files = await readdir(this.contentRoot, { withFileTypes: true });
    } catch {
      // no content root; configured data files may still exist
    }
    const names = [...new Set([
      ...files.filter((file) => file.isFile() && file.name.endsWith(".json")).map((file) => file.name.slice(0, -".json".length)),
      ...this.configuredDataFiles().keys(),
    ])].filter((name) => COLLECTION_NAME_RE.test(name));
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
    const path = (await this.resolveEntryPath(collection, id)) ?? this.newEntryPath(collection, id);
    await mkdir(dirname(path), { recursive: true });
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
    const ids = new Set<string>();
    /** Collect the folder at `prefix` (an id path ending in "/", or ""). */
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let files: import("node:fs").Dirent[];
      try {
        files = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const file of files) {
        if (file.isDirectory()) {
          if (ENTRY_ID_RE.test(prefix + file.name)) await walk(join(dir, file.name), `${prefix}${file.name}/`);
          continue;
        }
        if (!file.isFile()) continue;
        const ext = EXTENSIONS.find((e) => file.name.endsWith(e));
        if (!ext) continue;
        const stem = file.name.slice(0, -ext.length);
        // Astro names `guides/index.md` "guides".
        const id = stem === "index" && prefix ? prefix.slice(0, -1) : prefix + stem;
        if (ENTRY_ID_RE.test(id)) ids.add(id);
      }
    };
    await walk(this.collectionDir(collection), "");
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

    const writePath = existing ?? this.newEntryPath(collection, id);
    await mkdir(dirname(writePath), { recursive: true });
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
    for (const path of this.entryPaths(collection, id)) {
      try {
        await unlink(path);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
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
