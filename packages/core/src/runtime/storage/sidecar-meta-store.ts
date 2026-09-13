import type { DeploymentTarget, RebuildReceipt } from "../../types.js";
import { mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CollectionMetadata, HistoryEntry } from "../../types.js";
import { atomicWrite, serializeWrite } from "./atomic-write.js";
import { COLLECTION_NAME_RE } from "./id-contracts.js";

const HISTORY_LIMIT = 50;

type RevisionMap = Record<string, number>;

function isValidRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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

/** Directory names under `dir` that are valid collection names. */
export async function listCollectionDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && COLLECTION_NAME_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Owns all `.caretcms/` sidecar I/O — the single shared revisions map, per-entry
 * history files, and collection-metadata JSON. It knows nothing about how the
 * entries themselves are stored, so any filesystem-backed StorageAdapter (JSON
 * blobs, markdown files, …) can compose it for its revision/history/collection-
 * metadata concerns rather than reimplementing this safety-critical logic.
 *
 * Crash-safe via `atomicWrite`; the revisions store is additionally serialized
 * per-path via `serializeWrite` so concurrent `bumpRevision` calls never tear
 * the read-increment-write sequence.
 */
export class SidecarMetaStore {
  private readonly metaRoot: string;

  constructor(options: { metaRoot: string }) {
    this.metaRoot = options.metaRoot;
  }

  async getRebuildReceipt(): Promise<RebuildReceipt | null> {
    try { return JSON.parse(await readFile(join(this.metaRoot, "rebuild.json"), "utf8")) as RebuildReceipt; }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
  }

  async setRebuildReceipt(receipt: RebuildReceipt | null): Promise<void> {
    const path = join(this.metaRoot, "rebuild.json");
    if (receipt === null) { await rm(path, { force: true }); return; }
    await mkdir(this.metaRoot, { recursive: true });
    await atomicWrite(path, JSON.stringify(receipt));
  }

  async getDeploymentTarget(): Promise<DeploymentTarget | null> {
    try { return JSON.parse(await readFile(join(this.metaRoot, "deployment.json"), "utf8")) as DeploymentTarget; }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
  }

  async setDeploymentTarget(target: DeploymentTarget | null): Promise<void> {
    const path = join(this.metaRoot, "deployment.json");
    if (target === null) { await rm(path, { force: true }); return; }
    await mkdir(this.metaRoot, { recursive: true });
    await atomicWrite(path, JSON.stringify(target));
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

  private collectionsMetaDir(): string {
    return join(this.metaRoot, "collections");
  }

  private collectionMetaPath(collection: string): string {
    return join(this.collectionsMetaDir(), `${collection}.json`);
  }

  // --- Revisions ---

  private async readRevisionMap(): Promise<RevisionMap> {
    const filePath = this.revisionStorePath();
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      // A missing file is the normal greenfield state: no revisions recorded
      // yet, so every entry is at 0.
      if ((error as { code?: string })?.code === "ENOENT") return {};
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      // A corrupt revisions file must NOT silently read as "{}" → every entry
      // at revision 0, which would let stale writers clobber newer data and
      // defeat optimistic concurrency. Surface it so the operator can recover
      // rather than losing edits silently. Atomic writes make this rare.
      throw new Error(
        `[caretcms] revisions store is corrupt and could not be parsed: ${filePath}. ` +
          `Repair or remove the file to recover.`,
        { cause },
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map = parsed as Record<string, unknown>;
    const out: RevisionMap = {};
    Object.entries(map).forEach(([key, value]) => {
      if (isValidRevision(value)) {
        out[key] = value;
      }
    });
    return out;
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
    return serializeWrite(this.revisionStorePath(), async () => {
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
      if (!Array.isArray(parsed) || !parsed.every(isHistoryEntry)) {
        throw new Error("Invalid history store");
      }
      return parsed;
    } catch (error) {
      // Recovery deduplicates by operationId. Treating a failed read as empty
      // could append a second copy or overwrite existing history.
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
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

  /** Collection names that have sidecar history recorded. */
  async listHistoryCollections(): Promise<string[]> {
    return listCollectionDirs(join(this.metaRoot, "history"));
  }

  // --- Collection metadata ---

  /**
   * Persist a collection's metadata JSON. Sidecar-only: this never creates an
   * entry-storage directory — that is the concrete adapter's concern (and for
   * source-backed adapters, the directory is owned by the project, not the CMS).
   */
  async createCollection(metadata: CollectionMetadata): Promise<void> {
    const dir = this.collectionsMetaDir();
    await mkdir(dir, { recursive: true });
    await atomicWrite(this.collectionMetaPath(metadata.id), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  /**
   * Remove a collection's sidecar state (metadata JSON + history). It does NOT
   * touch entry storage — the concrete adapter decides whether deleting a
   * collection should remove its entries (the JSON adapter does; a source-file
   * adapter must not destroy version-controlled content).
   */
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
        metadataFiles.map((name) => this.getCollectionMetadata(name)),
      );

      return metadata.filter((m): m is CollectionMetadata => Boolean(m));
    } catch {
      return [];
    }
  }
}
