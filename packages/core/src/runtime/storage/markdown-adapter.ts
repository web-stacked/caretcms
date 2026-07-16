import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CollectionMetadata, EntryData, HistoryEntry, StorageAdapter } from "../../types.js";
import { atomicWrite } from "./atomic-write.js";
import { assertFilesystemRuntime } from "./fs-runtime.js";
import { SidecarMetaStore, listCollectionDirs } from "./sidecar-meta-store.js";
import { COLLECTION_NAME_RE, ENTRY_ID_RE, assertSafeEditorId } from "./id-contracts.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter-codec.js";
import { spliceBodyBlocks as spliceBodyBlocksInSource } from "../../markdown/splice.js";
import { FilesystemAdapter } from "./filesystem-adapter.js";

// .md is preferred over .mdx when both exist for the same id (simpler format,
// and an MDX body is more fragile). Order matters: first match wins on read.
const EXTENSIONS = [".md", ".mdx"] as const;

/**
 * StorageAdapter over Astro file-based content collections.
 *
 * Maps `<contentRoot>/<collection>/<id>.{md,mdx}` to entries: YAML frontmatter
 * becomes the entry `data`, and edits are written back IN-PLACE — the markdown
 * body (everything after the closing `---`, including MDX JSX/imports) is
 * spliced through byte-for-byte. The body is NOT editable in v1.
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

  private collectionDir(collection: string): string {
    return join(this.contentRoot, collection);
  }

  /** The content root — what git stages for commit-on-publish. */
  committablePath(): string {
    return this.contentRoot;
  }

  /** First existing `<id>.{md,mdx}` path for an entry, honoring .md precedence. */
  private async resolveEntryPath(collection: string, id: string): Promise<string | null> {
    for (const ext of EXTENSIONS) {
      const path = join(this.collectionDir(collection), `${id}${ext}`);
      try {
        if ((await stat(path)).isFile()) return path;
      } catch {
        // not present — try the next extension
      }
    }
    return null;
  }

  // --- Collections ---

  async discoverCollections(): Promise<string[]> {
    // Unlike the JSON adapter, createCollection here does NOT create a content
    // directory, so a freshly-created collection is visible only via its sidecar
    // metadata until it has entries — include that as a third discovery source.
    const [fromContent, fromHistory, metadata] = await Promise.all([
      listCollectionDirs(this.contentRoot),
      this.meta.listHistoryCollections(),
      this.meta.listCollectionMetadata(),
    ]);
    const merged = new Set([...fromContent, ...fromHistory, ...metadata.map((m) => m.id)]);
    return [...merged].sort((a, b) => a.localeCompare(b));
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
    const path = await this.resolveEntryPath(collection, id);
    if (!path) return null;
    try {
      return await readFile(path, "utf8");
    } catch {
      return null; // disappeared between stat and read, or unreadable encoding
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
    const dir = this.collectionDir(collection);
    await mkdir(dir, { recursive: true });
    const path = (await this.resolveEntryPath(collection, id)) ?? join(dir, `${id}.md`);
    await atomicWrite(path, source);
  }

  async getEntry(collection: string, id: string): Promise<EntryData | null> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) return null;
    const path = await this.resolveEntryPath(collection, id);
    if (!path) return null;

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null; // disappeared between stat and read, or unreadable encoding
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed.ok) {
      // Fail loud: returning empty data here would let a later whole-entry write
      // silently overwrite frontmatter we couldn't read.
      throw new Error(
        `[caretcms] Failed to parse frontmatter in ${collection}/${id}: ${parsed.reason}`,
      );
    }
    return { id, data: parsed.data };
  }

  async listEntryIds(collection: string): Promise<string[]> {
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

    const existing = await this.resolveEntryPath(collection, id);
    let body = "";
    if (existing) {
      const original = await readFile(existing, "utf8");
      const parsed = parseFrontmatter(original);
      if (!parsed.ok) {
        throw new Error(
          `[caretcms] Refusing to overwrite ${collection}/${id} with unparseable frontmatter: ${parsed.reason}`,
        );
      }
      body = original.slice(parsed.bodyStart);
    }

    const serialized = serializeFrontmatter(data);
    if (!serialized.ok) {
      throw new Error(`[caretcms] Cannot serialize ${collection}/${id}: ${serialized.reason}`);
    }

    const dir = this.collectionDir(collection);
    await mkdir(dir, { recursive: true });
    const writePath = existing ?? join(dir, `${id}.md`);
    await atomicWrite(writePath, `---\n${serialized.content}---\n${body}`);
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    if (!COLLECTION_NAME_RE.test(collection) || !ENTRY_ID_RE.test(id)) return;
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
