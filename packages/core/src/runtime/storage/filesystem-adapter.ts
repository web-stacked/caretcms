import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CollectionMetadata, EntryData, HistoryEntry, StorageAdapter } from "../../types.js";

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const HISTORY_LIMIT = 50;

/** workerd (incl. Astro 6's dev server) sets navigator.userAgent to this. */
const WORKERD_USER_AGENT = "Cloudflare-Workers";

/**
 * Return a human-readable runtime name if filesystem storage cannot work here,
 * or null when a real Node filesystem is available.
 *
 * Astro 6's dev server runs on the same workerd runtime as production, so a
 * Workers-targeted project has no filesystem in dev *or* prod — the failure
 * would otherwise surface as silently-empty reads and cryptic write errors.
 */
function detectUnsupportedRuntime(): string | null {
  const g = globalThis as { navigator?: { userAgent?: string }; WebSocketPair?: unknown };
  // navigator.userAgent === "Cloudflare-Workers" only when the `global_navigator`
  // compat flag is on, so also check WebSocketPair — a workerd global present
  // regardless of compat flags — to detect Workers even on an old compat date.
  if (g.navigator?.userAgent === WORKERD_USER_AGENT || typeof g.WebSocketPair === "function") {
    return "Cloudflare Workers (workerd)";
  }
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    return "a non-Node runtime";
  }
  return null;
}

function assertFilesystemRuntime(): void {
  const runtime = detectUnsupportedRuntime();
  if (!runtime) return;
  throw new Error(
    `[caretcms] Filesystem storage is not available on ${runtime}.\n` +
      `Astro 6's dev server also runs on workerd, so this fails in dev as well as production.\n\n` +
      `Targeting Cloudflare Workers? Use the KV adapter from @caretcms/cloudflare in BOTH dev and prod:\n\n` +
      `  import { cloudflareStorage } from '@caretcms/cloudflare';\n` +
      `  // caret({ storage: cloudflareStorage(), ... })\n\n` +
      `Targeting a Node host? Filesystem storage works there — make sure you are not building for an edge runtime.`,
  );
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.ts === "number" &&
    Number.isFinite(obj.ts) &&
    typeof obj.action === "string" &&
    "data" in obj
  );
}

type RevisionMap = Record<string, number>;

function isValidRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Write a file atomically: stream into a sibling temp file, then rename over
 * the target. rename(2) is atomic on the same filesystem, so a crash/SIGKILL
 * mid-write can never leave a truncated or empty JSON file — readers always
 * see either the old contents or the complete new contents. Critical for the
 * single shared revisions.json, where a torn write would lose revision state
 * site-wide. The temp file is a sibling (same dir → same filesystem) so the
 * rename stays atomic and never crosses a device boundary.
 */
async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, contents, "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

const revisionWriteChains = new Map<string, Promise<unknown>>();

function serializeRevisionWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = revisionWriteChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(task, task);
  revisionWriteChains.set(
    filePath,
    next.finally(() => {
      if (revisionWriteChains.get(filePath) === next) {
        revisionWriteChains.delete(filePath);
      }
    }),
  );
  return next;
}

export class FilesystemAdapter implements StorageAdapter {
  private readonly dataRoot: string;
  private readonly metaRoot: string;

  constructor(options?: { dataRoot?: string; metaRoot?: string }) {
    assertFilesystemRuntime();
    this.dataRoot = options?.dataRoot ?? join(process.cwd(), ".caret", "data");
    this.metaRoot = options?.metaRoot ?? join(process.cwd(), ".caretcms");
  }

  private collectionDir(collection: string): string {
    return join(this.dataRoot, collection);
  }

  private revisionStorePath(): string {
    return join(this.metaRoot, "revisions.json");
  }

  private revisionMapKey(collection: string, id: string): string {
    return `${collection}::${id}`;
  }

  private historyFilePath(collection: string, id: string): string {
    return join(this.metaRoot, "history", collection, `${id}.json`);
  }

  // --- Collections ---

  private async discoverFromDir(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && COLLECTION_NAME_RE.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  async discoverCollections(): Promise<string[]> {
    const [fromData, fromMeta] = await Promise.all([
      this.discoverFromDir(this.dataRoot),
      this.discoverFromDir(join(this.metaRoot, "history")),
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
    const filePath = join(this.collectionDir(collection), `${id}.json`);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const data = asObjectRecord(parsed);
      if (!data) return null;
      return { id, data };
    } catch {
      return null;
    }
  }

  async listEntryIds(collection: string): Promise<string[]> {
    try {
      const files = await readdir(this.collectionDir(collection), { withFileTypes: true });
      return files
        .filter((item) => item.isFile() && item.name.endsWith(".json"))
        .map((item) => item.name.slice(0, -".json".length))
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
    const dir = this.collectionDir(collection);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${id}.json`);
    await atomicWrite(filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    const filePath = join(this.collectionDir(collection), `${id}.json`);
    try {
      await unlink(filePath);
    } catch (error) {
      const maybeErr = error as { code?: string };
      if (maybeErr?.code === "ENOENT") return;
      throw error;
    }
  }

  // --- Revisions ---

  private async readRevisionMap(): Promise<RevisionMap> {
    const filePath = this.revisionStorePath();
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const map = parsed as Record<string, unknown>;
      const out: RevisionMap = {};
      Object.entries(map).forEach(([key, value]) => {
        if (isValidRevision(value)) {
          out[key] = value;
        }
      });
      return out;
    } catch {
      return {};
    }
  }

  private async writeRevisionMap(map: RevisionMap): Promise<void> {
    const filePath = this.revisionStorePath();
    await mkdir(this.metaRoot, { recursive: true });
    await atomicWrite(filePath, `${JSON.stringify(map, null, 2)}\n`);
  }

  async getRevision(collection: string, id: string): Promise<number> {
    const map = await this.readRevisionMap();
    const value = map[this.revisionMapKey(collection, id)];
    return isValidRevision(value) ? value : 0;
  }

  async bumpRevision(collection: string, id: string): Promise<number> {
    return serializeRevisionWrite(this.revisionStorePath(), async () => {
      const map = await this.readRevisionMap();
      const key = this.revisionMapKey(collection, id);
      const current = isValidRevision(map[key]) ? map[key] : 0;
      const next = current + 1;
      map[key] = next;
      await this.writeRevisionMap(map);
      return next;
    });
  }

  // --- History ---

  private async readHistoryFile(collection: string, id: string): Promise<HistoryEntry[]> {
    const filePath = this.historyFilePath(collection, id);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isHistoryEntry);
    } catch {
      return [];
    }
  }

  private async writeHistoryFile(
    collection: string,
    id: string,
    entries: HistoryEntry[],
  ): Promise<void> {
    const filePath = this.historyFilePath(collection, id);
    await mkdir(join(this.metaRoot, "history", collection), { recursive: true });
    await atomicWrite(filePath, `${JSON.stringify(entries, null, 2)}\n`);
  }

  async getHistory(collection: string, id: string): Promise<HistoryEntry[]> {
    return this.readHistoryFile(collection, id);
  }

  async appendHistory(collection: string, id: string, entry: HistoryEntry): Promise<void> {
    const current = await this.readHistoryFile(collection, id);
    const next = [entry, ...current].slice(0, HISTORY_LIMIT);
    await this.writeHistoryFile(collection, id, next);
  }

  // --- Collection Management ---

  private collectionsMetaDir(): string {
    return join(this.metaRoot, "collections");
  }

  private collectionMetaPath(collection: string): string {
    return join(this.collectionsMetaDir(), `${collection}.json`);
  }

  async createCollection(metadata: CollectionMetadata): Promise<void> {
    const dir = this.collectionsMetaDir();
    await mkdir(dir, { recursive: true });
    const filePath = this.collectionMetaPath(metadata.id);
    await atomicWrite(filePath, `${JSON.stringify(metadata, null, 2)}\n`);

    // Create empty collection directory
    const collectionDir = this.collectionDir(metadata.id);
    await mkdir(collectionDir, { recursive: true });
  }

  async deleteCollection(collection: string): Promise<void> {
    // unlink has no `force` option, so guard the metadata file against ENOENT.
    const metaPath = this.collectionMetaPath(collection);
    try {
      await unlink(metaPath);
    } catch (error) {
      const maybeErr = error as { code?: string };
      if (maybeErr?.code !== "ENOENT") throw error;
    }

    // rm({ force: true }) is a no-op on missing paths and still throws real errors.
    await rm(this.collectionDir(collection), { recursive: true, force: true });
    await rm(join(this.metaRoot, "history", collection), { recursive: true, force: true });
  }

  async getCollectionMetadata(collection: string): Promise<CollectionMetadata | null> {
    const filePath = this.collectionMetaPath(collection);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as CollectionMetadata;
    } catch {
      return null;
    }
  }

  async listCollectionMetadata(): Promise<CollectionMetadata[]> {
    const dir = this.collectionsMetaDir();
    try {
      const files = await readdir(dir, { withFileTypes: true });
      const metadataFiles = files
        .filter((item) => item.isFile() && item.name.endsWith(".json"))
        .map((item) => item.name.slice(0, -".json".length));

      const metadata = await Promise.all(
        metadataFiles.map((name) => this.getCollectionMetadata(name))
      );

      return metadata.filter((m): m is CollectionMetadata => Boolean(m));
    } catch {
      return [];
    }
  }
}
