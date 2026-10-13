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
  /** Singular noun used by creation actions, for example "post". */
  entryLabel?: string;
  description?: string;
  icon?: string;
  /** Fields used to recognize entries in Studio lists and creation. */
  titleField?: string;
  thumbnailField?: string;
  subtitleField?: string;
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
  entryLabel?: string;
  description?: string;
  icon?: string;
  titleField?: string;
  thumbnailField?: string;
  subtitleField?: string;
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

/** Repository identity captured before an opt-in durable journal publication. */
export interface GitJournalTarget {
  root: string;
  gitDir: string;
  ref: string;
  /** Captured HEAD; detached-head retries cannot follow an unrelated checkout. */
  head: string | null;
}

/** Private immutable retry input. Never include sources or paths in API responses. */
export interface GitJournalReceipt {
  version: 1;
  operationId: string;
  collection: string;
  id: string;
  revision: number;
  deleted: boolean;
  sources: PublicationSourceSnapshot[];
  target: GitJournalTarget;
  authorName: string;
  authorEmail: string;
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

/** Immutable UTF-8 source bytes approved by publication; null records deletion. */
export interface PublicationSourceSnapshot {
  path: string;
  content: string | null;
  mode?: "100644" | "100755";
}

/** A revision for the visible entry, plus the base revision for a merged draft view. */
export interface EntrySnapshot {
  entry: EntryData | null;
  revision: number;
  baseRevision?: number;
}

/** One validated entry transition submitted to an adapter atomically. */
export interface EntryCommit {
  collection: string;
  id: string;
  /** Revision observed while the mutation was prepared. */
  expectedRevision: number;
  /** Base version observed by a client editing a merged/fallback draft view. */
  expectedBaseRevision?: number;
  /** A whole-entry client replacement must not invent its first draft baseline. */
  requireBaseRevision?: boolean;
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
        currentBaseRevision?: number;
        exists: boolean;
      };
    };

/** A published version captured while a new draft baseline was prepared. */
export interface DraftBaseline {
  collection: string;
  id: string;
  revision: number;
}

/** Raw private draft and published content read in the same transaction. */
export interface DraftSnapshot {
  overlay: EntrySnapshot;
  base: EntrySnapshot;
}

/** Raw private data captured during preparation, including publication recovery metadata. */
export interface DraftGuard {
  collection: string;
  id: string;
  data: Record<string, unknown> | null;
}

/** Capability bound to one base/private-store pair in a shared transaction domain. */
export interface DraftCoordinator {
  /** Ordered snapshots, including missing IDs and duplicates, from one transaction. */
  getEntrySnapshots(collection: string, ids: readonly string[]): Promise<DraftSnapshot[]>;
  /** Compare all baseline and draft preconditions, then commit the whole batch atomically. */
  commitEntries(changes: readonly EntryCommit[], baselines: readonly DraftBaseline[], guards: readonly DraftGuard[]): Promise<EntryCommitResult>;
}

/** Descriptive guarantees, not a substitute for the corresponding methods. */
export interface StorageGuarantees {
  /** Expiring stores survive requests/restarts only until their configured TTL. */
  persistence: "process" | "durable" | "expiring";
  /** Process snapshots coordinate CMS writes only; eventual stores cannot promise coherence. */
  snapshots: "process" | "transactional" | "eventual";
  /** Process commits require runtime locks; single-writer stores cannot arbitrate remote writers. */
  commits: "process" | "transactional" | "single-writer";
  /** Source-backed stores may delete only CMS metadata while retaining project files. */
  collectionDeletion: "content" | "metadata";
}

export interface StorageAdapter {
  /** Optional, additive declarations. Omission means guarantees are unspecified. */
  readonly guarantees?: Readonly<StorageGuarantees>;
  /** Optional persistent deploy retry receipt, scoped to this editor overlay. */
  getRebuildReceipt?(): Promise<RebuildReceipt | null>;
  setRebuildReceipt?(receipt: RebuildReceipt | null): Promise<void>;
  /** Latest accepted deployment request, scoped to this editor overlay. */
  getDeploymentTarget?(): Promise<DeploymentTarget | null>;
  setDeploymentTarget?(target: DeploymentTarget | null): Promise<void>;
  /** Private durable journal queue, scoped to the raw editor overlay. */
  listGitJournalReceipts?(): Promise<GitJournalReceipt[]>;
  /** Idempotent insert: an existing operation's immutable input must not change. */
  saveGitJournalReceipt?(receipt: GitJournalReceipt): Promise<void>;
  deleteGitJournalReceipt?(operationId: string): Promise<void>;
  discoverCollections(): Promise<string[]>;
  isKnownCollection(collection: string): Promise<boolean>;
  getEntry(collection: string, id: string): Promise<EntryData | null>;
  /** Coherent content/revision read. Distributed adapters must read in one transaction. */
  getEntrySnapshot?(collection: string, id: string): Promise<EntrySnapshot>;
  /** Ordered one-for-one snapshots for IDs (including missing IDs). Same consistency scope as single snapshots. */
  getEntrySnapshots?(collection: string, ids: readonly string[]): Promise<EntrySnapshot[]>;
  listEntryIds(collection: string): Promise<string[]>;
  listEntries(collection: string): Promise<EntryData[]>;
  writeEntry(collection: string, id: string, data: Record<string, unknown>): Promise<void>;
  deleteEntry(collection: string, id: string): Promise<void>;
  /** Content version, retained across entry/collection deletion and recreation. */
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

  /**
   * Optional on raw editor overlays. Return a coordinator only when this exact
   * base/overlay pair shares transactional reads and commits. Return undefined
   * for unsupported pairs; separate transactional stores are not sufficient.
   */
  coordinateDrafts?(base: StorageAdapter): DraftCoordinator | undefined;

  // Collection management
  createCollection(metadata: CollectionMetadata): Promise<void>;
  /** Content deletion invalidates affected entry versions; metadata-only deletion retains source versions. */
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
   * legacy filesystem journal integration. This remains a directory, not an
   * approved publication snapshot. Git-on-publish requires preparePublicationSources.
   * Adapters with no filesystem presence (KV/R2, in-memory) omit it.
   */
  committablePath?(): string;
  /** Exact source files affected by publishing one entry; deletion includes all source variants. */
  committableEntryPaths?(collection: string, id: string, deleted: boolean): Promise<string[]>;

  /** Private durable recovery store, isolated by editor and purpose from normal drafts. */
  makeRecoveryOverlay?(editorId: string, purpose: "source-restore"): Promise<StorageAdapter>;

  /** Prepare exact source bytes before publication, without reading back mutated files. */
  preparePublicationSources?(
    collection: string, id: string, data: Record<string, unknown> | null, preparedSource?: string,
  ): Promise<PublicationSourceSnapshot[]>;

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
   * Optional: whether entries in this collection are whole source documents
   * (Markdown with a body). Adapters that also store data files, such as one
   * JSON file holding many entries, return false for those collections so
   * publication writes the entry instead of a document source. Absent means
   * true whenever `readBodySource` and `writeBodySource` exist.
   */
  isDocumentCollection?(collection: string): Promise<boolean>;

  /**
   * Optional: apply drafted body-block edits to the entry's source file,
   * all-or-nothing (see `markdown/splice.ts`). Returns the splice outcome;
   * `stale`/`overlap` failures leave the file untouched. The current publisher
   * prepares the full source in its recovery plan and uses writeBodySource.
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
