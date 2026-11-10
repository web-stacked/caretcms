import type {
  CollectionMetadata,
  DeploymentTarget,
  EntryCommit,
  EntryCommitResult,
  EntryData,
  HistoryEntry,
  RebuildReceipt,
  StorageAdapter,
} from "@caretcms/core";
import { getCloudflareRuntimeEnv } from "../runtime/env.js";

const COLLECTION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const SESSION_OVERLAY_TTL_SECONDS = 2 * 60 * 60;

interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

type GlobMap = Record<string, Record<string, unknown>>;
let bundled: GlobMap | null = null;

function getDataModules(): GlobMap {
  if (bundled) return bundled;
  try {
    bundled = import.meta.glob<Record<string, unknown>>(
      "/.caret/data/**/*.json",
      { eager: true, import: "default" },
    );
  } catch {
    bundled = {};
  }
  return bundled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readBundledEntry(collection: string, id: string): Record<string, unknown> | null {
  const value = getDataModules()[`/.caret/data/${collection}/${id}.json`];
  return isRecord(value) ? structuredClone(value) : null;
}

function listBundledEntryIds(collection: string): string[] {
  const prefix = `/.caret/data/${collection}/`;
  return Object.keys(getDataModules())
    .filter(key => key.startsWith(prefix) && key.endsWith(".json"))
    .map(key => key.slice(prefix.length, -5))
    .sort((a, b) => a.localeCompare(b));
}

function discoverBundledCollections(): string[] {
  const result = new Set<string>();
  for (const key of Object.keys(getDataModules())) {
    const match = /^\/\.caret\/data\/([^/]+)\/[^/]+\.json$/.exec(key);
    if (match && COLLECTION_NAME_RE.test(match[1])) result.add(match[1]);
  }
  return [...result].sort((a, b) => a.localeCompare(b));
}

async function getNamespace(binding: string): Promise<DurableObjectNamespaceLike | null> {
  const env = await getCloudflareRuntimeEnv();
  const candidate = env?.[binding] as Partial<DurableObjectNamespaceLike> | undefined;
  return candidate && typeof candidate.idFromName === "function" && typeof candidate.get === "function"
    ? candidate as DurableObjectNamespaceLike
    : null;
}

export interface CloudflareDurableStorageOptions extends Record<string, unknown> {
  /** Durable Object namespace binding. */
  binding?: string;
  /** Stable site/tenant name used to select the object instance. */
  instanceName?: string;
  /** Include build-bundled .caret/data as the initial read-only baseline. */
  bundledFallback?: boolean;
}

type StoredEntryResponse = {
  value: null | { state: "deleted" } | { state: "entry"; data: Record<string, unknown> };
  collectionDeleted: boolean;
};

export class CloudflareDurableStorageAdapter implements StorageAdapter {
  private readonly binding: string;
  private readonly instanceName: string;
  private readonly bundledFallback: boolean;
  private readonly expirationTtl?: number;

  constructor(options: CloudflareDurableStorageOptions = {}, expirationTtl?: number) {
    this.binding = options.binding ?? "CMS_CONTENT";
    this.instanceName = options.instanceName ?? "default";
    this.bundledFallback = options.bundledFallback ?? true;
    this.expirationTtl = expirationTtl;
  }

  private async call<T>(command: Record<string, unknown>): Promise<T> {
    const namespace = await getNamespace(this.binding);
    if (!namespace) {
      throw new Error(`[caretcms] Cloudflare Durable Object binding "${this.binding}" is not available.`);
    }
    const stub = namespace.get(namespace.idFromName(this.instanceName));
    const response = await stub.fetch("https://caretcms.internal/storage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.expirationTtl ? { "x-caret-ttl-seconds": String(this.expirationTtl) } : {}),
      },
      body: JSON.stringify(command),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof body?.error === "string" ? body.error : `Storage request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }

  async getRebuildReceipt(): Promise<RebuildReceipt | null> {
    return (await this.call<{ value: RebuildReceipt | null }>({ type: "get_rebuild_receipt" })).value;
  }

  async setRebuildReceipt(receipt: RebuildReceipt | null): Promise<void> {
    await this.call({ type: "set_rebuild_receipt", receipt });
  }

  async getDeploymentTarget(): Promise<DeploymentTarget | null> {
    return (await this.call<{ value: DeploymentTarget | null }>({ type: "get_deployment_target" })).value;
  }

  async setDeploymentTarget(target: DeploymentTarget | null): Promise<void> {
    await this.call({ type: "set_deployment_target", target });
  }

  private async collectionState(): Promise<{ known: string[]; deleted: string[] }> {
    return this.call({ type: "collections" });
  }

  async discoverCollections(): Promise<string[]> {
    const state = await this.collectionState();
    const known = new Set(state.known);
    if (this.bundledFallback) {
      for (const collection of discoverBundledCollections()) known.add(collection);
    }
    for (const collection of state.deleted) known.delete(collection);
    return [...known].sort((a, b) => a.localeCompare(b));
  }

  async isKnownCollection(collection: string): Promise<boolean> {
    return COLLECTION_NAME_RE.test(collection) && (await this.discoverCollections()).includes(collection);
  }

  async getEntry(collection: string, id: string): Promise<EntryData | null> {
    const state = await this.call<StoredEntryResponse>({ type: "get_entry", collection, id });
    if (state.collectionDeleted) return null;
    const { value } = state;
    if (value?.state === "deleted") return null;
    if (value?.state === "entry") return { id, data: structuredClone(value.data) };
    if (!this.bundledFallback) return null;
    const data = readBundledEntry(collection, id);
    return data ? { id, data } : null;
  }

  async listEntryIds(collection: string): Promise<string[]> {
    const state = await this.call<{ ids: string[]; deleted: string[]; collectionDeleted: boolean }>({ type: "list_entry_ids", collection });
    if (state.collectionDeleted) return [];
    const ids = new Set(state.ids);
    if (this.bundledFallback) {
      for (const id of listBundledEntryIds(collection)) ids.add(id);
    }
    for (const id of state.deleted) ids.delete(id);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  async listEntries(collection: string): Promise<EntryData[]> {
    const entries = await Promise.all((await this.listEntryIds(collection)).map(id => this.getEntry(collection, id)));
    return entries.filter((entry): entry is EntryData => Boolean(entry));
  }

  async writeEntry(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.call({ type: "write_entry", collection, id, data });
  }

  async deleteEntry(collection: string, id: string): Promise<void> {
    await this.call({ type: "delete_entry", collection, id });
  }

  async getRevision(collection: string, id: string): Promise<number> {
    return (await this.call<{ value: number }>({ type: "get_revision", collection, id })).value;
  }

  async bumpRevision(collection: string, id: string): Promise<number> {
    return (await this.call<{ value: number }>({ type: "bump_revision", collection, id })).value;
  }

  async getHistory(collection: string, id: string): Promise<HistoryEntry[]> {
    return (await this.call<{ value: HistoryEntry[] }>({ type: "get_history", collection, id })).value;
  }

  async appendHistory(collection: string, id: string, entry: HistoryEntry): Promise<void> {
    await this.call({ type: "append_history", collection, id, entry });
  }

  async commitEntries(changes: readonly EntryCommit[]): Promise<EntryCommitResult> {
    const seeded = changes.map(change => {
      const seedData = this.bundledFallback ? readBundledEntry(change.collection, change.id) : null;
      return { ...change, ...(seedData ? { seedData } : {}) };
    });
    return this.call({ type: "commit_entries", changes: seeded });
  }

  async createCollection(metadata: CollectionMetadata): Promise<void> {
    await this.call({ type: "create_collection", metadata });
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.call({ type: "delete_collection", collection });
  }

  async getCollectionMetadata(collection: string): Promise<CollectionMetadata | null> {
    return (await this.call<{ value: CollectionMetadata | null }>({ type: "get_collection_metadata", collection })).value;
  }

  async listCollectionMetadata(): Promise<CollectionMetadata[]> {
    return (await this.call<{ value: CollectionMetadata[] }>({ type: "list_collection_metadata" })).value;
  }

  async makeSessionOverlay(sessionId: string): Promise<StorageAdapter> {
    return new CloudflareDurableStorageAdapter({
      binding: this.binding,
      instanceName: `${this.instanceName}:session:${sessionId}`,
      bundledFallback: false,
    }, SESSION_OVERLAY_TTL_SECONDS);
  }

  async makeEditorOverlay(editorId: string): Promise<StorageAdapter> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(editorId)) throw new Error("Invalid editor id");
    return new CloudflareDurableStorageAdapter({
      binding: this.binding,
      instanceName: `${this.instanceName}:draft:${editorId}`,
      bundledFallback: false,
    });
  }
}
