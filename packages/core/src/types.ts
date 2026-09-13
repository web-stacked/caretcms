export type EntryData = { id: string; data: Record<string, unknown> };
export type HistoryEntry = {
  /** Idempotency key for a recoverable publication. */
  operationId?: string;
  ts: number;
  data: unknown;
  action: string;
  /**
   * Present on `publish` snapshots that spliced markdown body blocks: the full
   * pre-publish source file, so a restore can put the prose back (`data` alone
   * only covers frontmatter for source-file-backed adapters).
   */
  bodySource?: string;
  /** Named editor/session responsible for the mutation, when available. */
  editor?: EditorIdentity;
};
export type CaretMode = "embedded" | "cloud";
export type CaretProviderKind = "storage" | "uploads" | "identity" | "deployment";

export type RuntimeProviderReference<TKind extends CaretProviderKind = CaretProviderKind> = {
  kind: TKind;
  entrypoint: string;
  exportName?: string;
  options?: Record<string, unknown> | null;
};

export type CaretStorageProvider = RuntimeProviderReference<"storage">;
export type CaretUploadProvider = RuntimeProviderReference<"uploads">;
export type CaretIdentityProvider = RuntimeProviderReference<"identity">;
export type CaretDeploymentProvider = RuntimeProviderReference<"deployment">;

export type EditorIdentity = {
  /** Stable, path-safe id matching /^[A-Za-z0-9_-]{1,64}$/. */
  id: string;
  name?: string;
  email?: string;
  roles?: string[];
};

/** Write permissions. Reading content is not restricted by this interface. */
export type AuthorizationAction = "edit" | "publish" | "delete" | "manageCollections" | "upload";
export interface AuthorizationRequest {
  identity: EditorIdentity;
  request: Request;
  action: AuthorizationAction;
  /** Omitted for global actions (uploads, or an empty publish request). */
  collection?: string;
  /** Omitted for collection-wide actions. */
  id?: string;
}
export interface AuthorizationPolicy {
  /** Only literal true grants access. Throws and other values deny access. */
  authorize(input: AuthorizationRequest): boolean | Promise<boolean>;
}

/**
 * Optional authoritative authentication adapter. Returning an identity grants
 * editor access; returning null denies it. When configured, password mode is
 * disabled rather than used as a fallback.
 */
export interface IdentityAdapter {
  /** Optional write policy. Without one authenticated editors retain full access.
   * With one, content saves use private drafts even in server delivery. */
  authorize?: AuthorizationPolicy["authorize"];
  authenticate(request: Request): Promise<EditorIdentity | null>;
  loginUrl(input: { request: Request; redirectTo: string }): string | Promise<string>;
  logoutUrl?(input: { request: Request; redirectTo: string }): string | Promise<string>;
}

export type CollectionSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  title?: string;
  description?: string;
};

/** Studio presentation and mutation capabilities for a collection. */
export type CollectionStudioConfig = {
  label?: string;
  description?: string;
  icon?: string;
  /** Lower values appear first on the Studio home screen. */
  order?: number;
  creatable?: boolean;
  orderable?: boolean;
  deletable?: boolean;
  /** Fixed entry id for a singleton collection. */
  singletonId?: string;
  /**
   * Same-origin preview path for entries in this collection. A string may use
   * `{id}` (for example `/journal/{id}`); an id-to-path map covers fixed pages
   * such as `{ home: "/", about: "/about" }`.
   */
  previewPath?: string | Record<string, string>;
  /**
   * Make publication a managed collection capability. Public Caret reads only
   * return entries whose configured field is exactly `true`; authenticated
   * editor reads continue to include drafts. The field defaults to `published`
   * and must be declared as a top-level boolean in this collection's schema.
   */
  publication?: {
    field?: string;
  };
};

export type CollectionMetadata = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  creatable?: boolean;
  orderable?: boolean;
  deletable?: boolean;
  singletonId?: string;
  previewPath?: string | Record<string, string>;
  publication?: {
    field?: string;
  };
  order?: number;
  schema: CollectionSchema;
  created_at: number;
  updated_at: number;
};

export interface RebuildReceipt {
  published: Array<{ collection: string; id: string; revision: number; deleted: boolean }>;
  commit: string | null;
}

/** The exact content transition associated with one accepted deployment request. */
export interface DeploymentTarget extends RebuildReceipt {
  /** Correlation id also sent to the rebuild webhook. */
  id: string;
  requestedAt: number;
}

export type DeploymentState = "deploying" | "live" | "failed";

/** Provider evidence for the build associated with a deployment target. */
export interface DeploymentStatusEvidence {
  state: DeploymentState;
  /** Stable provider build/deployment identity, once the provider can resolve it. */
  buildId: string | null;
  /** Optional provider console or public deployment URL. */
  buildUrl?: string;
  /** Short provider-supplied detail suitable for an authenticated editor. */
  message?: string;
  /**
   * Content proven to be included in the live build. Required when state is
   * `live`; core checks it covers every revision in the target before showing
   * the deployment as live.
   */
  deployed?: RebuildReceipt;
}

export interface DeploymentStatusProvider {
  getDeploymentStatus(input: {
    target: DeploymentTarget;
    request: Request;
  }): Promise<DeploymentStatusEvidence>;
}

/** One validated entry transition submitted to an adapter atomically. */
export interface EntryCommit {
  collection: string;
  id: string;
  /** Revision observed while the mutation was prepared. */
  expectedRevision: number;
  /** Whether an entry was visible while the mutation was prepared. */
  expectedExists: boolean;
  /** Replacement data, or null to delete the entry. */
  data: Record<string, unknown> | null;
  /** Optional snapshot appended only when the data transition commits. */
  history?: HistoryEntry;
  /** Lets an overlay preserve body-only draft merge semantics. */
  writeMode?: "entry" | "body";
}

export type EntryCommitResult =
  | {
      ok: true;
      revisions: Array<{ collection: string; id: string; revision: number }>;
    }
  | {
      ok: false;
      conflict: {
        collection: string;
        id: string;
        currentRevision: number;
        exists: boolean;
      };
    };

export interface StorageAdapter {
  /** Optional persistent deploy retry receipt, scoped to this editor overlay. */
  getRebuildReceipt?(): Promise<RebuildReceipt | null>;
  setRebuildReceipt?(receipt: RebuildReceipt | null): Promise<void>;
  /** Latest accepted deployment request, scoped to this editor overlay. */
  getDeploymentTarget?(): Promise<DeploymentTarget | null>;
  setDeploymentTarget?(target: DeploymentTarget | null): Promise<void>;
  discoverCollections(): Promise<string[]>;
  isKnownCollection(collection: string): Promise<boolean>;
  getEntry(collection: string, id: string): Promise<EntryData | null>;
  listEntryIds(collection: string): Promise<string[]>;
  listEntries(collection: string): Promise<EntryData[]>;
  writeEntry(collection: string, id: string, data: Record<string, unknown>): Promise<void>;
  deleteEntry(collection: string, id: string): Promise<void>;
  getRevision(collection: string, id: string): Promise<number>;
  bumpRevision(collection: string, id: string): Promise<number>;
  getHistory(collection: string, id: string): Promise<HistoryEntry[]>;
  appendHistory(collection: string, id: string, entry: HistoryEntry): Promise<void>;

  /**
   * Optional compare-and-commit primitive for distributed adapters. The adapter
   * must compare every revision/existence precondition before changing anything,
   * then atomically apply every entry, revision, history, and index transition.
   * A conflict leaves the entire batch unchanged.
   */
  commitEntries?(changes: readonly EntryCommit[]): Promise<EntryCommitResult>;

  // Collection management
  createCollection(metadata: CollectionMetadata): Promise<void>;
  deleteCollection(collection: string): Promise<void>;
  getCollectionMetadata(collection: string): Promise<CollectionMetadata | null>;
  listCollectionMetadata(): Promise<CollectionMetadata[]>;

  /**
   * Optional: build a write-isolated overlay adapter scoped to a session id.
   * Used by demo / sandbox mode together with `SessionOverlayAdapter`. Adapters
   * that don't support multi-tenant scoping can omit this.
   */
  makeSessionOverlay?(sessionId: string): Promise<StorageAdapter>;

  /**
   * Optional: build a PERSISTENT, write-isolated overlay scoped to an editor id.
   * Backs the drafts / preview-before-publish workflow: an editor's unpublished
   * edits land in this overlay, the public site keeps reading the base, and
   * "Publish" flushes the overlay back into the base. Distinct from
   * `makeSessionOverlay`, which is ephemeral demo isolation (and may carry a TTL).
   * The same `editorId` must return an overlay over the same backing store so a
   * draft survives across requests. Adapters that can't isolate writes may omit it.
   */
  makeEditorOverlay?(editorId: string): Promise<StorageAdapter>;

  /**
   * Optional: the on-disk directory holding this adapter's content, for the
   * git-journal commit-on-publish feature. File-backed adapters return the path
   * git should stage (e.g. the markdown content root); adapters with no
   * filesystem presence (KV/R2, in-memory) omit it, so git-on-publish no-ops.
   */
  committablePath?(): string;

  /**
   * Optional: the raw source text an entry's markdown BODY lives in (the full
   * `.md` file, frontmatter included). Backs body inline editing: the mutation
   * engine hash-checks a block's `data-caret-md-src` range against this before
   * accepting a draft, and publish splices edited blocks back into it. Only
   * source-file-backed adapters (markdown) implement it; overlay wrappers must
   * delegate to their BASE (the body source is always the published file).
   */
  readBodySource?(collection: string, id: string): Promise<string | null>;

  /**
   * Optional: apply drafted body-block edits to the entry's source file,
   * all-or-nothing (see `markdown/splice.ts`). Returns the splice outcome;
   * `stale`/`overlap` failures leave the file untouched. Publish calls this
   * BEFORE the frontmatter write so a failed splice aborts the whole entry.
   */
  spliceBodyBlocks?(
    collection: string,
    id: string,
    blocks: ReadonlyArray<{ md: string; src: { start: number; end: number; hash: string } }>,
  ): Promise<{ ok: true } | { ok: false; reason: "stale" | "overlap" | "missing" }>;

  /**
   * Optional: overwrite an entry's full source file (frontmatter + body).
   * Backs history restore of `bodySource` snapshots. Source-file-backed
   * adapters only.
   */
  writeBodySource?(collection: string, id: string, source: string): Promise<void>;
}

export interface UploadContext {
  sessionId?: string;
}

export interface UploadHandler {
  upload(file: File, ctx?: UploadContext): Promise<{ url: string }>;

  /**
   * Optional: build a per-session wrapper that enforces sandbox quotas
   * (per-file size, total session bytes). Used by demo mode together with
   * `QuotaUploadHandler`. Adapters that don't support quota tracking can
   * omit this.
   */
  makeSessionWrapper?(sessionId: string): Promise<UploadHandler>;
}
