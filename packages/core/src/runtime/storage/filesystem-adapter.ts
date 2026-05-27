import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CollectionMetadata, EntryData, HistoryEntry, StorageAdapter } from "../../types.js";

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const HISTORY_LIMIT = 50;

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
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
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
    await writeFile(filePath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  }

  async getRevision(collection: string, id: string): Promise<number> {
    const map = await this.readRevisionMap();
    const value = map[this.revisionMapKey(collection, id)];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  }

  async bumpRevision(collection: string, id: string): Promise<number> {
    return serializeRevisionWrite(this.revisionStorePath(), async () => {
      const map = await this.readRevisionMap();
      const key = this.revisionMapKey(collection, id);
      const current =
        typeof map[key] === "number" && Number.isInteger(map[key]) && map[key] >= 0
          ? map[key]
          : 0;
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
    await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
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
    await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    // Create empty collection directory
    const collectionDir = this.collectionDir(metadata.id);
    await mkdir(collectionDir, { recursive: true });
  }

  async deleteCollection(collection: string): Promise<void> {
    // Delete metadata
    const metaPath = this.collectionMetaPath(collection);
    try {
      await unlink(metaPath);
    } catch (error) {
      const maybeErr = error as { code?: string };
      if (maybeErr?.code !== "ENOENT") throw error;
    }

    // Delete collection directory and all entries
    const collectionDir = this.collectionDir(collection);
    try {
      await rm(collectionDir, { recursive: true, force: true });
    } catch (error) {
      const maybeErr = error as { code?: string };
      if (maybeErr?.code !== "ENOENT") throw error;
    }

    // Delete history for this collection
    const historyDir = join(this.metaRoot, "history", collection);
    try {
      await rm(historyDir, { recursive: true, force: true });
    } catch (error) {
      const maybeErr = error as { code?: string };
      if (maybeErr?.code !== "ENOENT") throw error;
    }
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
