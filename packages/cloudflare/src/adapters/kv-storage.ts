import type {
  CollectionMetadata,
  DeploymentTarget,
  EntryData,
  HistoryEntry,
  RebuildReceipt,
  StorageAdapter,
} from "@caretcms/core";
import { COLLECTION_NAME_RE, assertSafeEditorId } from "@caretcms/core/contracts";
import { getCloudflareRuntimeEnv } from "../runtime/env.js";

type KvBindingLike = {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

const HISTORY_LIMIT = 50;
const COLLECTIONS_KEY = "collections";
const META_PREFIX = "meta::";
const SESSION_OVERLAY_TTL_SECONDS = 60 * 60 * 2; // 2h, matches demo cookie

// Bundled-data discovery: Vite transforms the syntactic glob call at build time
// and inlines the result. The try/catch covers the plain-Node import path used by
// astro.config.mjs loaders, where `import.meta.glob` is not defined.
type GlobMap = Record<string, Record<string, unknown>>;
let _bundled: GlobMap | null = null;
function getDataModules(): GlobMap {
  if (_bundled) return _bundled;
  try {
    _bundled = import.meta.glob<Record<string, unknown>>(
      "/.caret/data/**/*.json",
      { eager: true, import: "default" },
    );
  } catch {
    _bundled = {};
  }
  return _bundled;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCollectionMetadata(value: unknown): value is CollectionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.label === "string" &&
    typeof obj.created_at === "number" &&
    typeof obj.updated_at === "number" &&
    !!obj.schema &&
    typeof obj.schema === "object"
  );
}

function readBundledEntry(collection: string, id: string): Record<string, unknown> | null {
  const key = `/.caret/data/${collection}/${id}.json`;
  const data = getDataModules()[key];
  return data && isObjectRecord(data) ? structuredClone(data) : null;
}

function listBundledEntryIds(collection: string): string[] {
  const prefix = `/.caret/data/${collection}/`;
  return Object.keys(getDataModules())
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length, -".json".length))
    .sort((a, b) => a.localeCompare(b));
}

function discoverBundledCollections(): string[] {
  const collections = new Set<string>();
  for (const key of Object.keys(getDataModules())) {
    const match = /^\/\.caret\/data\/([^/]+)\/[^/]+\.json$/.exec(key);
    if (match && COLLECTION_NAME_RE.test(match[1])) {
      collections.add(match[1]);
    }
  }
  return [...collections].sort((a, b) => a.localeCompare(b));
}

async function getKvBinding(binding: string): Promise<KvBindingLike | null> {
  const env = await getCloudflareRuntimeEnv();
  const candidate = env?.[binding];
  if (!candidate || typeof candidate !== "object") return null;

  const kv = candidate as { get?: unknown; put?: unknown; delete?: unknown };
  if (
    typeof kv.get !== "function" ||
    typeof kv.put !== "function" ||
    typeof kv.delete !== "function"
  ) {
    return null;
  }

  return candidate as KvBindingLike;
}

export interface CloudflareKvStorageOptions extends Record<string, unknown> {
  binding?: string;
  /** Prepended to every KV key. Used by session overlays. */
  keyPrefix?: string;
  /** Applied to every put. Used by session overlays for native expiry. */
  expirationTtl?: number;
  /** Disables the bundled .caret/data fallback (overlays don't want it). */
  bundledFallback?: boolean;
}

export class CloudflareKvStorageAdapter implements StorageAdapter {
  private readonly binding: string;
  private readonly keyPrefix: string;
  private readonly expirationTtl: number | undefined;
  private readonly bundledFallback: boolean;

  constructor(options: CloudflareKvStorageOptions = {}) {
    this.binding = options.binding ?? "CMS_KV";
    this.keyPrefix = options.keyPrefix ?? "";
    this.expirationTtl = options.expirationTtl;
    this.bundledFallback = options.bundledFallback ?? true;
  }

  async getRebuildReceipt(): Promise<RebuildReceipt | null> {
    const kv = await this.requireKv();
    return await kv.get(this.k("rebuild-receipt"), "json") as RebuildReceipt | null;
  }

  async setRebuildReceipt(receipt: RebuildReceipt | null): Promise<void> {
    const kv = await this.requireKv();
    if (receipt === null) await kv.delete(this.k("rebuild-receipt"));
    else await this.put(kv, this.k("rebuild-receipt"), JSON.stringify(receipt));
  }

  async getDeploymentTarget(): Promise<DeploymentTarget | null> {
    const kv = await this.requireKv();
    return await kv.get(this.k("deployment-target"), "json") as DeploymentTarget | null;
  }

  async setDeploymentTarget(target: DeploymentTarget | null): Promise<void> {
    const kv = await this.requireKv();
    if (target === null) await kv.delete(this.k("deployment-target"));
    else await this.put(kv, this.k("deployment-target"), JSON.stringify(target));
  }

  // --- key helpers -------------------------------------------------------

  private k(suffix: string): string {
    return `${this.keyPrefix}${suffix}`;
  }
  private revisionKey(c: string, id: string) { return this.k(`rev::${c}::${id}`); }
  private indexKey(c: string)               { return this.k(`index::${c}`); }
  private historyKey(c: string, id: string) { return this.k(`history::${c}::${id}`); }
  private entryKey(c: string, id: string)   { return this.k(`${c}::${id}`); }
  private metaKey(c: string)                { return this.k(`${META_PREFIX}${c}`); }
  private collectionsKey()                  { return this.k(COLLECTIONS_KEY); }

  private async put(kv: KvBindingLike, key: string, value: string): Promise<void> {
    if (this.expirationTtl) {
      await kv.put(key, value, { expirationTtl: this.expirationTtl });
    } else {
      await kv.put(key, value);
    }
  }

  private async requireKv(): Promise<KvBindingLike> {
    const kv = await getKvBinding(this.binding);
    if (!kv) {
      throw new Error(
        `[caretcms] Cloudflare KV binding "${this.binding}" is not available.`,
      );
    }
    return kv;
  }

  // --- collection / index plumbing --------------------------------------

  private async getRevisionRaw(kv: KvBindingLike, c: string, id: string): Promise<number> {
    const raw = await kv.get(this.revisionKey(c, id), "json");
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  }

  private async setRevisionRaw(kv: KvBindingLike, c: string, id: string, rev: number): Promise<void> {
    await this.put(kv, this.revisionKey(c, id), JSON.stringify(rev));
  }

  private async getCollectionIndex(kv: KvBindingLike, c: string): Promise<string[]> {
    const existing = await kv.get(this.indexKey(c), "json");
    if (Array.isArray(existing)) {
      return existing.filter((value): value is string => typeof value === "string");
    }

    if (!this.bundledFallback) return [];

    const bundled = listBundledEntryIds(c);
    await this.put(kv, this.indexKey(c), JSON.stringify(bundled));
    return bundled;
  }

  private async getKnownCollections(kv: KvBindingLike): Promise<string[]> {
    const existing = await kv.get(this.collectionsKey(), "json");
    if (Array.isArray(existing)) {
      return existing
        .filter((v): v is string => typeof v === "string" && COLLECTION_NAME_RE.test(v))
        .sort((a, b) => a.localeCompare(b));
    }

    if (!this.bundledFallback) return [];

    const bundled = discoverBundledCollections();
    await this.put(kv, this.collectionsKey(), JSON.stringify(bundled));
    return bundled;
  }

  private async addKnownCollection(kv: KvBindingLike, c: string): Promise<void> {
    const collections = await this.getKnownCollections(kv);
    if (collections.includes(c)) return;
    collections.push(c);
    collections.sort((a, b) => a.localeCompare(b));
    await this.put(kv, this.collectionsKey(), JSON.stringify(collections));
  }

  private async removeKnownCollection(kv: KvBindingLike, c: string): Promise<void> {
    const collections = await this.getKnownCollections(kv);
    if (!collections.includes(c)) return;
    await this.put(
      kv,
      this.collectionsKey(),
      JSON.stringify(collections.filter((value) => value !== c)),
    );
  }

  private async addToIndex(kv: KvBindingLike, c: string, id: string): Promise<void> {
    const ids = await this.getCollectionIndex(kv, c);
    if (ids.includes(id)) return;
    ids.push(id);
    ids.sort((a, b) => a.localeCompare(b));
    await this.put(kv, this.indexKey(c), JSON.stringify(ids));
  }

  private async removeFromIndex(kv: KvBindingLike, c: string, id: string): Promise<void> {
    const ids = await this.getCollectionIndex(kv, c);
    await this.put(
      kv,
      this.indexKey(c),
      JSON.stringify(ids.filter((value) => value !== id)),
    );
  }

  // --- StorageAdapter ----------------------------------------------------

  async discoverCollections(): Promise<string[]> {
    const kv = await this.requireKv();
    const known = await this.getKnownCollections(kv);
    if (!this.bundledFallback) return known;
    const bundled = discoverBundledCollections();
    return [...new Set([...known, ...bundled])].sort((a, b) => a.localeCompare(b));
  }

  async isKnownCollection(collection: string): Promise<boolean> {
    if (!COLLECTION_NAME_RE.test(collection)) return false;
    const collections = await this.discoverCollections();
    return collections.includes(collection);
  }

  async getEntry(collection: string, id: string): Promise<EntryData | null> {
    const kv = await this.requireKv();
    const raw = await kv.get(this.entryKey(collection, id), "json");
    if (isObjectRecord(raw)) {
      return { id, data: structuredClone(raw) };
    }

    if (!this.bundledFallback) return null;
    const bundled = readBundledEntry(collection, id);
    return bundled ? { id, data: bundled } : null;
  }

  async listEntryIds(collection: string): Promise<string[]> {
    const kv = await this.requireKv();
    return this.getCollectionIndex(kv, collection);
  }

  async listEntries(collection: string): Promise<EntryData[]> {
    const ids = await this.listEntryIds(collection);
    const entries = await Promise.all(ids.map((id) => this.getEntry(collection, id)));
    return entries.filter((entry): entry is EntryData => Boolean(entry));
  }

  async writeEntry(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    const kv = await this.requireKv();
    await this.addKnownCollection(kv, collection);
    await this.put(kv, this.entryKey(collection, id), JSON.stringify(data));
    await this.addToIndex(kv, collection, id);
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    const kv = await this.requireKv();
    await kv.delete(this.entryKey(collection, id));
    await this.removeFromIndex(kv, collection, id);
  }

  async getRevision(collection: string, id: string): Promise<number> {
    const kv = await this.requireKv();
    return this.getRevisionRaw(kv, collection, id);
  }

  async bumpRevision(collection: string, id: string): Promise<number> {
    const kv = await this.requireKv();
    const next = (await this.getRevisionRaw(kv, collection, id)) + 1;
    await this.setRevisionRaw(kv, collection, id, next);
    return next;
  }

  async getHistory(collection: string, id: string): Promise<HistoryEntry[]> {
    const kv = await this.requireKv();
    const raw = await kv.get(this.historyKey(collection, id), "json");
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((entry): entry is HistoryEntry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const c = entry as Record<string, unknown>;
        return (
          typeof c.ts === "number" &&
          Number.isFinite(c.ts) &&
          typeof c.action === "string" &&
          "data" in c
        );
      })
      .slice(0, HISTORY_LIMIT)
      .map((entry) => structuredClone(entry));
  }

  async appendHistory(collection: string, id: string, entry: HistoryEntry): Promise<void> {
    const kv = await this.requireKv();
    const current = await this.getHistory(collection, id);
    const next = [structuredClone(entry), ...current].slice(0, HISTORY_LIMIT);
    await this.put(kv, this.historyKey(collection, id), JSON.stringify(next));
  }

  async createCollection(metadata: CollectionMetadata): Promise<void> {
    if (!COLLECTION_NAME_RE.test(metadata.id)) {
      throw new Error(
        `[caretcms] Invalid collection id "${metadata.id}". Must match ${COLLECTION_NAME_RE}.`,
      );
    }
    const kv = await this.requireKv();
    await this.put(kv, this.metaKey(metadata.id), JSON.stringify(metadata));
    await this.addKnownCollection(kv, metadata.id);
    const existingIndex = await kv.get(this.indexKey(metadata.id), "json");
    if (!Array.isArray(existingIndex)) {
      await this.put(kv, this.indexKey(metadata.id), JSON.stringify([]));
    }
  }

  async deleteCollection(collection: string): Promise<void> {
    if (!COLLECTION_NAME_RE.test(collection)) return;
    const kv = await this.requireKv();

    const ids = await this.getCollectionIndex(kv, collection);
    await Promise.all(
      ids.map((id) =>
        Promise.all([
          kv.delete(this.entryKey(collection, id)),
          kv.delete(this.revisionKey(collection, id)),
          kv.delete(this.historyKey(collection, id)),
        ]),
      ),
    );

    await kv.delete(this.indexKey(collection));
    await kv.delete(this.metaKey(collection));
    await this.removeKnownCollection(kv, collection);
  }

  async getCollectionMetadata(collection: string): Promise<CollectionMetadata | null> {
    if (!COLLECTION_NAME_RE.test(collection)) return null;
    const kv = await this.requireKv();
    const raw = await kv.get(this.metaKey(collection), "json");
    return isCollectionMetadata(raw) ? structuredClone(raw) : null;
  }

  async listCollectionMetadata(): Promise<CollectionMetadata[]> {
    const kv = await this.requireKv();
    const collections = await this.getKnownCollections(kv);
    const entries = await Promise.all(
      collections.map((c) => this.getCollectionMetadata(c)),
    );
    return entries.filter((value): value is CollectionMetadata => Boolean(value));
  }

  async makeSessionOverlay(sessionId: string): Promise<StorageAdapter> {
    return new CloudflareKvStorageAdapter({
      binding: this.binding,
      keyPrefix: `session/${sessionId}/`,
      expirationTtl: SESSION_OVERLAY_TTL_SECONDS,
      bundledFallback: false,
    });
  }

  async makeEditorOverlay(editorId: string): Promise<StorageAdapter> {
    assertSafeEditorId(editorId);
    // No expirationTtl: a draft persists until the editor publishes or discards it
    // (unlike the 2h ephemeral demo session overlay above).
    return new CloudflareKvStorageAdapter({
      binding: this.binding,
      keyPrefix: `draft/${editorId}/`,
      bundledFallback: false,
    });
  }
}
