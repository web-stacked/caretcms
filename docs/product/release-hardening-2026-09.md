# Release hardening implementation

The September 17 review was verified against commit `3616421`. The
implementation passes address the reproduced request paths and add regressions.
It does not complete every architectural improvement proposed for the major
release. Core still has no runtime dependencies.

| Finding | Implemented behavior |
| --- | --- |
| R1 | HTML bindings are discovered from element tokens, excluding comments, quoted attributes, raw text, and foreign content. Ambiguous double-escaped script content is skipped conservatively. Nested replacements use original spans. |
| R2 | Editor, overlay, Studio, and API responses receive private/no-store caching. Changed bodies lose stale validators; editor conditionals are removed before downstream rendering. Anonymous public cache directives remain intact. |
| R3 | Schema alternatives have independent validation results, recursively resolve references, retain sibling constraints, and enforce exactly one match for `oneOf`. Cyclic references are bounded. |
| R4 | The middleware's shared binding probe recognizes Markdown-only pages. |
| R5 | Layout writes validate the resulting schema and publication field before committing. Invalid writes leave content, revision, and history unchanged. |
| R6 | Real-editor collection create/delete routes use base storage in preview/static/policy modes. Demo management remains isolated. |
| R7 | Login and upload enforce byte limits while consuming streams, before buffering JSON or form parsers. Oversized streams are canceled. |
| R8 | Git publication commits immutable approved source bytes retained in recovery plans, uses exact paths and a separate index, and preserves working-file edits and staging. Busy indexes and changed refs fail closed. |
| R9 | Caretize preflights the whole batch, rechecks each source before replacement, writes atomically with preserved modes, and avoids rollback over later external edits. |
| R10 | KV persists deletion markers in a keyspace that cannot collide with valid content keys. Deleted collections disable bundled fallback even after explicit recreation. |
| R11 | Entries reads coordinate content/revision with CMS mutation locks. Durable Objects provide a single transactional snapshot operation, including deleted revisions; merged draft views carry independent base versions and first conditional whole-entry draft saves enforce them. |
| R12 | Flow and block quoted YAML scalars share a strict escape decoder, including Unicode. Unsupported escapes fail explicitly. |
| R13 | Sanitization decodes one entity layer and escapes once. Markdown conversion shares the decoder; decoded URLs reject unsafe schemes, controls, and backslashes. |
| R14 | Content-removing collection deletion advances and retains entry revisions; recreation cannot reuse stale versions. Markdown metadata-only deletion preserves source versions. |
| R15 | A shared/exclusive collection barrier coordinates management with entry writes, reads, recovery, restore, and Git journaling while retaining parallel writes to different entries. |
| R16 | Optional ordered batch snapshots avoid reading the file adapters' whole revision map for each result. Studio pages/search and draft wrappers use batches under CMS entry locks, with per-entry fallback for corrupt content. |
| R17 | Durable Object collection recreation retains deletion intent, so bundled seed entries stay removed. Seed-only revisions are invalidated, and atomic commits reject removed seed baselines. Legacy deletion markers survive recreation. |
| R18 | KV editor/session overlays retain their parent site prefix, preventing private content, versions, indexes, and history from being shared between prefixed sites with the same identity. Legacy unprefixed keys remain readable. |
| R19 | Git subprocess input handling waits for the real process status. A successful Git command closing an unused empty pipe no longer skips journaling on Linux; nonempty source-input errors still fail closed. |
| R20 | Opt-in coordinated Durable Object drafts compare captured published baselines, private revisions, existence, and raw private data in one transaction. Raced saves change no entry in the batch, and same-version recovery journals cannot be overwritten. Legacy separate-object mode remains the default. |
| R21 | Opt-in Git retry records immutable private receipts before draft cleanup. Git branch advancement and idempotency markers share a ref transaction; retries never republish content or rerun deployment hooks and refuse stale revisions or changed checkouts. |
| R22 | Worker session cookies are verified inside a scope containing the Worker environment before private overlays are selected. Valid preview requests stay private; forged cookies fail closed. |

The HTML5 entity table is generated at development time by
`scripts/generate-html-entities.py`; Python is not a runtime or build dependency.
The scanner intentionally declines uncertain contexts instead of acting as a
complete HTML tree parser. Markdown save responses are consumed before signaling
success, which also prevents an unread private fetch response from remaining
alive after the save.

The second implementation pass adds validation of the final entry before a
new publication, checks current requirements before history restore, and rejects
source snapshots whose frontmatter differs from their recorded entry data.
Pending recovery plans revalidate before writing content. Plans whose content
has already been applied finish revision/history/cleanup even if a schema changed
in the meantime, preserving forward recovery.

## Compatibility and upgrades

- `StorageAdapter.getEntrySnapshot`, `committableEntryPaths`, and
  `preparePublicationSources` are optional, additive capabilities. The snapshot fallback coordinates only CMS writes in
  one process; it cannot coordinate arbitrary external writes or KV isolates.
- Entries in merged/fallback editor draft views include `baseRevision`. Copy it
  into `expectedBaseRevision` on the mutation together with `expectedRevision`.
  Conditional whole-entry replacements require both versions when creating the
  first structured draft or converting a body-only draft. A missing/stale base
  version returns 409 with `currentBaseRevision`; reload the entry and resolve
  the conflict before retrying. Structured drafts keep their original baseline,
  so later base changes still conflict at publish. Inline, layout, and Studio
  clients carry the new version. Legacy unconditional writes remain
  unconditional; they do not provide protection against stale client reads.
- Publish conflicts now include `invalid_entry` when current schema/publication
  requirements fail. The draft is retained, with no new recovery plan or base
  write. Restore validation failures return 400 with issues and leave source,
  revision, and history unchanged.
- Single-entry API responses include a top-level revision even when no entry
  exists. Inline and Studio initialization use it instead of assuming zero.
- Deploy the updated Durable Object class together with the Cloudflare adapter
  so its snapshot command, bundled-fallback markers, and seed-only revision
  invalidation are supported. Existing collection deletion markers are retained
  on recreation. If an older release already discarded a marker by recreating
  the collection, replay the intended deletion; its original intent cannot be
  reconstructed automatically.
- `committablePath` keeps its existing directory meaning, and
  `committableEntryPaths` remains available. Git-on-publish now requires
  `preparePublicationSources`, which returns the exact UTF-8 source bytes and
  paths for a planned publication (`content: null` represents deletion).
  Filesystem JSON and Markdown adapters implement it. Path-only custom adapters
  and older recovery plans without source snapshots finish publication but skip
  Git journaling; the route never reads current files to reconstruct approval.
- The immutable journal uses Git object/tree/ref operations rather than commit
  hooks or clean filters, so hooks cannot change approved bytes. Configured
  commit signing is honored. Ignored untracked files are not force-added.
  Separately staged edits, including edits to an approved file, retain their
  blobs; later working-file edits and recreations remain on disk. A busy index,
  unresolved merge, overlapping paths, or concurrent ref update skips journaling.
  Git failures remain best effort and do not undo content publication.
- New Markdown entries retain their full prepared source in the publication
  plan, allowing recovery after a source write loses its acknowledgement.
- File adapters implement `makeRecoveryOverlay(editorId, "source-restore")`.
  These stores are private to an editor and purpose, outside normal drafts.
  Custom source-backed adapters must provide this durable, isolated store before
  history can replace full source files. Source restore persists its plan first,
  then resumes content/revision/history/cleanup with a stable operation ID.
  Retry the same history timestamp after an interruption; a different target or
  changed current content returns 409. Completed exact-source retries are no-ops.
  Pending plans can recover even if normal history retention trimmed their target.
  The Studio displays the curated retry/error response.
- Collection management changes are immediate for real editors. See
  [saving and visibility](../saving-and-visibility.md). Existing orphan collection
  metadata in editor overlays is not silently promoted or discarded. For file
  storage, back up `.caret/drafts` and inspect the affected editor's
  `meta/collections` directory; recreate the intended collection through the
  management API using the saved metadata. For remote adapters, export it through
  the raw editor overlay's metadata methods first. Existing entry drafts remain
  subject to normal publication and conflict checks.
- Historic absent KV keys do not encode deletion intent. Replay intended old
  deletions after upgrading. New deletion markers inherit overlay TTL rules;
  base markers are permanent.
- KV overlays retain a configured parent `keyPrefix`. Unprefixed deployments
  keep their existing private keys. Older prefixed sites wrote to global
  `draft/<editor>/` and `session/<session>/` paths. Back up those keys and explicitly
  assign intended drafts to each owning site's new prefixed editor overlay;
  shared historical paths do not record ownership and are not copied automatically.
  Ephemeral sessions can start fresh.
- Existing entity corruption is not repaired automatically because literal
  entity text can be intentional. Repair affected entries individually with
  backups.
- Unknown YAML escapes now cause read errors rather than silently altered data.
  Caretize refuses stale inputs and symlink replacement rather than overwriting
  later work.

## Remaining major-release work

1. Validate deployed distributed storage, regional KV replication, abrupt host
   failures, expiry, and historical remote migrations. Public conformance,
   persisted runtime restart, rollback after actual transaction writes, lost
   acknowledgement, and alarm expiry now pass in local Miniflare/workerd. Local
   platform results do not establish production regional/failure guarantees.
   Built-in guarantees are explicit, and local 1k/10k read benchmarks justify the file
   batch capability. Evaluate provider-specific latency/cost before introducing
   optional remote query/batch capabilities; no remote defaults were changed.
2. Confirm the configured matrix in GitHub's Ubuntu CI before releasing, then
   extend production SSR coverage to deployed Cloudflare and other supported
   providers. Packed consumers now pass development, static production, and
   production Node SSR on macOS and Linux arm64 with Astro 6.0.0 and pinned
   Astro 7.2.4 on Node 22.12.0 and 24.18.0. Container results are not a completed
   GitHub CI run. Frozen
   pre-hardening disk fixtures cover existing draft/recovery formats, and native
   upgrade tests now reopen actual persisted state written by v0.5.0 Cloudflare
   storage code. Deployed account migrations and additional historical releases
   still need dedicated cases.

Git retry is now available with `CARET_GIT_JOURNAL_RETRY=true` alongside
`CARET_GIT_ON_PUBLISH=true` for built-in file storage. It protects approved input
through process interruption and recognizes an already completed Git operation.
It remains opt-in, uses per-entry commits, has no background worker, and does not
make content publication and Git atomic. Ref advancement and index refresh are
still separate. See [the retry contract](../publish-recovery.md#durable-git-history-retry-opt-in)
before enabling it.

Caretize's atomic rename prevents partial-file writes. Its checks do not provide
filesystem compare-and-swap against arbitrary concurrent editors; a narrow
check-to-rename window remains.

## Validation

The regression additions cover real middleware/mutation/read/publish routes,
temporary source files and Git repositories, seeded KV, concurrent Durable
transactions, and browser execution/rendering. Existing property-based rewrite
and sanitizer tests remain part of the unit gate.

Run `npm run check`, then `npm run build:examples` and
`npm run test:e2e:all`, followed by `npm run test:platform`, in an isolated checkout.
Browser tests reset example
content and must remain serial. The implementation validation passed:

| Gate | Result |
| --- | --- |
| `npm run check` | Version policy, all package/browser typechecks and builds; 125 unit files / 1,186 tests passed on macOS and Debian Linux arm64, each on Node 24.18.0 and 22.12.0 |
| `npm run build:examples` | Starter, content-site, and demo passed |
| Browser suites | 77 distinct cases passed: 49 standard, 2 CSP, 15 Markdown, 7 static, 2 permissions, 2 Cloudflare. Complete 76-case run followed by both Cloudflare cases after the final adapter fix. |
| Packed consumer | Astro 6.0.0 / 7.2.4 × Node 22.12.0 / 24.18.0: all four HTTP/package smoke tests, static production builds, and production Node SSR tests passed on each OS |
| Local Cloudflare platform | Nine tests passed on both Node versions on each OS; 13 Durable Object and 10 KV conformance checks passed, with explicit unsupported-feature skips |

Browser/example runs used `/tmp/caretcms-release-tetudb_l`, keeping reset routines
away from workspace content. The second-pass regressions include independent
base/draft versions, stale first replacements, body-only baseline conversion,
batch preflight, changed-schema publish/restore, source-snapshot integrity,
interrupted-operation recovery, and Studio's explicit conflict retry.
The latest pass adds immutable-source Git tests (including ref races, signing
failure, split indexes, independent staging, and journal ordering), plus source
restore failure/restart/isolation/history-retention regressions. The journal's
entry locks and version checks prevent an older delayed CMS publication from
replacing a newer one in Git; Git subprocesses have a 10-second timeout. Latest
logs are `implementation-journal-restore-check.log`,
`implementation-journal-restore-examples.log`, and
`implementation-journal-restore-e2e.log` in the sibling local
`caretcms-review-2026-09-17` directory. These checks do not replace the pending
Linux CI and production SSR compatibility runs.

The compatibility pass adds 23 upgrade regressions over frozen source, JSON,
sidecar, and private editor metadata from the pre-hardening formats. They
exercise publication interrupted before/after content, revision, and history;
old additions/deletions (including Markdown creation plans without prepared
source); legacy body and structured drafts; corrupt plans; external changes;
rebuild receipts; and editor isolation. Tests copy the historical files without
regenerating them through current code. See
[upgrade fixtures](../../tests/fixtures/upgrade/README.md).

`npm run test:compat -- 6.0.0` tests the declared peer lower bound and
`npm run test:compat` uses the root's exact Astro pin. Both install the packed
core tarball outside the workspaces, exercise real live collections and CMS
HTTP routes, request shipped assets, and verify a static production build.
Development and production run in separate processes. CI now repeats both
consumers on Node 22.12.0 and Node 24; the existing latest-Astro-6 typecheck job
remains. Dependency pins, the lockfile, and example content are unchanged.
The fresh consumer dependency resolutions currently emit an upstream
`undici@8.10.2` engine warning on Node 22.12.0 (requires 22.19.0); the exercised
paths pass. This does not establish compatibility for that dependency's own
API or for installations using `engine-strict`.

Compatibility logs are `implementation-upgrade-check-node22.log`,
`implementation-upgrade-fixtures.log`, and
`implementation-consumer-astro{6,7}-node{22,24}.log` in the sibling review
directory. The earlier example and 76-test browser results still apply: this
pass changes fixtures, the test runner, CI, and documentation, with no new
runtime code changes.

The adapter pass adds optional `StorageGuarantees` declarations and the public,
framework-independent `@caretcms/core/testing/storage` runner. All five built-in
adapters use the same applicable checks, with explicit skips for unsupported
features. Wrapper declarations retain weaker base/overlay semantics. See
[adapter contracts and conformance](../storage-adapters.md).

Shared regressions reproduced revision reuse after collection deletion in
memory, KV, and Durable Objects: an old conditional replacement overwrote a
recreated entry. Filesystem storage preserved versions but did not invalidate
the deleted entry until recreation. Deletion now advances retained versions;
filesystem collection invalidation replaces the revision map once, rather than
rewriting it for every ID. Historical discarded versions cannot be recovered,
so open clients should reload after upgrading. Version tombstones must not be
pruned while stale clients/draft baselines can still reference them.

Entry operations acquire shared collection barriers before their entry locks;
management acquires an exclusive barrier. Regressions cover deletion before and
after an in-flight save, coherent reads during deletion, parallel distinct-entry
writes, and releasing barriers on storage errors. This is process coordination,
not a distributed lock or filesystem compare-and-swap.

An optional `getEntrySnapshots` preserves order, missing/deleted versions,
duplicates, and draft baseline behavior while reading file revision metadata
once per batch. Studio search retains groups of 20 and normal pagination limits.
Invalid batches or corrupt source files fall back to isolated individual reads;
custom adapters without the method retain their old path. Tests verify all entry
locks remain held through reads and that batch output cannot misidentify IDs.

The final adapter review reproduced bundled seed resurrection after explicit
Durable Object collection recreation. Persistent fallback-disable markers now
survive both explicit and implicit recreation, including legacy deletion
markers and later builds with new seeds. Deletion advances seed-only revisions
inside the transaction, and commit preflight excludes disabled seeds. Six unit
regressions cover these paths; the native Worker suite also verifies retained
versions, stale-save rejection, and removed seed baseline rejection. The updated
adapter and Durable Object class must be deployed together. Historical markers
already discarded by older recreation cannot be reconstructed automatically.

The local reference-store benchmark on macOS arm64 / Node 24.18.0 measured one
observation per case, including the same seeded revision map before and after:

| Filesystem operation | Entries | Before | Batched |
| --- | --- | --- | --- |
| Search with revisions (groups of 20) | 10,000 | 40,797.82 ms | 1,735.23 ms |
| First page with revisions (25 entries) | 10,000 | 83.82 ms | 10.92 ms |

The 10k search observation improved about 23.5×. These are local measurements,
not latency guarantees or remote storage models. `npm run bench:storage`
reproduces 1k/10k memory/JSON cases and reports sample counts; full search remains
a single observation. The API still scans all candidate entries for search;
provider query capabilities remain future work.

Latest artifacts in the sibling review directory are
`implementation-conformance-check.log`, `implementation-conformance-check-node22.log`,
`implementation-conformance-e2e.log`, `implementation-conformance-examples.log`,
`implementation-conformance-cloudflare-e2e.log`, `implementation-conformance-demo-final.log`,
`implementation-conformance-consumer-astro{6,7}-node{22,24}.log`, and
`implementation-storage-benchmark-{baseline,batched}.json`.
The adapter-pass example and serial browser suites ran in
`/tmp/caretcms-adapter-release-74eumuhc`; workspace example content remains intact.

## Platform and production SSR pass

The local Cloudflare platform suite uses persisted Miniflare/workerd stores,
not memory fakes. All applicable public checks run inside the Worker. Tests
destroy/recreate the runtime and verify content, revisions, history, metadata,
indexes, editor drafts, rebuild receipts, and collection-deletion markers.
Fault injection throws after the first entry's data/revision/history and the
second entry's content were actually written; the enclosing native transaction
rolls back the entire batch. A lost commit acknowledgement leaves one committed
version/history record, and an old conditional retry conflicts. Session alarm
refresh and complete expiry work after a persisted runtime restart. KV tests
check native TTL metadata and rejection below its minimum. This is local
platform coverage, not regional KV replication, deployed migrations, or abrupt
host-failure testing. See [platform fixtures](../../tests/platform/README.md).

Two unit regressions reproduced the KV prefix isolation bug; editor and session
overlays now inherit the parent's prefix. Two additional unit checks preserve
legacy unprefixed reads/writes, and native Worker checks verify tenant isolation.
Prefixed historical drafts need explicit ownership assignment as described
above; the adapter does not guess which site owns a formerly shared draft.

Packed consumers now build and launch the emitted Node standalone server in
production, exercise live loads, private drafts, schema rejection, stale saves,
publish without rebuilding, and shipped assets, then restart the process to
verify persistent published content. All four local combinations pass. Astro
6.0.0 uses Node adapter 10.0.2; later 10.0.x imports a missing lower-bound Astro
export despite its broader peer declaration. The fixture pin avoids changing
CaretCMS's peer range or workspace dependencies. CI includes production SSR
in its existing consumer matrix and runs `test:platform` after browser suites.
`check:all` also includes the platform suite.

Linux validation reproduced intermittent `EPIPE` errors after successful
`commit-tree -m` calls closed stdin without reading it. The input helper now
waits for Git's exit status, permits only an empty-input `EPIPE` on success,
and rejects any source-input failure. The real negative `check-ignore` status
also takes precedence over a pipe error. Four deterministic regressions exercise
these cases with real Git subprocesses and injected pipe errors, preserving
approved content and staging checks. Existing signing, timeout, ref-race,
source-integrity, and index-isolation tests remain in the full gate.

Latest host logs in the sibling review directory are
`implementation-platform-check{,-node22}.log`,
`implementation-platform-native{,-node22}.log`,
`implementation-ssr-consumer-astro{6,7}-node{22,24}.log`,
`implementation-kv-prefix-baseline.log`, and `implementation-git-pipe-{baseline,focused}.log`.

The isolated Debian Linux arm64 container used the official
`node:22.12.0-bookworm-slim` image and Git 2.39.5, installed from the committed
lockfile, and reran both complete Node gates, both platform suites, and all four
packed-consumer cases (including production SSR). Node 24.18.0 was selected
through npm's exact-version executable package. These passed without modifying
workspace dependencies or example content. The temporary validation container
was removed afterward. Linux logs are
`implementation-linux-check-node{22,24}.log`,
`implementation-linux-platform-node{22,24}.log`, and
`implementation-linux-consumer-astro{6,7}-node{22,24}.log` in the sibling review
directory. `implementation-linux-check-baseline.log` and
`implementation-linux-git-input-full-baseline.log` preserve the reproduced
Git failures. GitHub Ubuntu CI, regional remote-platform behavior, and deployed
SSR provider checks remain release gates.


## Atomic private draft pass

Two pre-fix regressions reproduced a base edit between first-draft preparation
and the private store's commit, including a later entry in a batch. Both saves
previously succeeded. Core now accepts an optional bound `DraftCoordinator` from
the raw private store; unsupported pairs retain their existing behavior.
`editorDrafts: "coordinated"` enables it in Cloudflare by colocating isolated
private keyspaces and base content in one Durable Object. The default remains
`"separate"`, preserving historical objects. Migration is explicit; finish
recovery and publish/discard or migrate backed-up private records with ownership,
versions, history, and receipts before switching modes. Reload clients.

Paired reads are transactional and preserve missing entries, deleted versions,
ordered duplicates, and bundled fallback intent. Commits compare every captured
new baseline and private precondition before updating the complete batch.
Structured edits retain the original publication baseline; body-to-structured
conversion captures the current baseline. `DraftGuard` checks also prevent a
prepared edit from overwriting a recovery journal inserted without a content
revision bump. Nested overlay factories retain their parent scope. Scope command
envelopes fail closed against older object classes, and scoped commands cannot
schedule expiry on the shared object. Adapter/class updates must ship together.

This closes the reproduced distributed draft race for the opt-in Durable Object
layout. Two independent objects, KV, and unversioned filesystem writes do not
gain a shared transaction. Separate low-level write/revision/history calls and
publication/cleanup remain separate operations with their existing limitations.
Local native tests exercise the real core wrapper, actual persisted rollback,
lost acknowledgements, restart, isolation, recovery guards, and public conformance
for both layouts. Remote migration and deployed failure checks remain release
work.


Final validation for this pass:

- `npm run check`: 126 unit files / 1,205 tests, including 19 coordinated-draft
  regressions, on Node 22.12.0 and 24.18.0 on both macOS and Debian Linux arm64.
- Native platform suite: 14 tests on both Nodes and both operating systems,
  including public conformance for separate/coordinated Durable Object stores
  (13 applicable checks each) and KV (10 applicable checks).
- Packed Astro 6.0.0 / 7.2.4 consumers: all four Node combinations on both
  operating systems, covering development, static production, and Node SSR.
- Serial browser suites: all 78 cases (49 standard, 2 CSP, 15 Markdown, 7 static,
  2 permissions, 3 Cloudflare). All three example builds pass.
- `git diff --check` passes. Workspace example content and dependencies remain
  intact; work remains uncommitted. Both temporary Linux containers were removed.

The sibling review directory contains `implementation-coordinated-*` logs,
including the pre-fix two-race baseline, a controlled recovery regression with
its data guard removed, final gates/platform tests, consumer matrices, browser
suites, and example builds. The recovery baseline returned success and overwrote
the protected record before the guard; the fixed unit and native cases conflict
and retain it. Browser/example validation used the isolated source copy named
in `/tmp/caretcms-draft-browser-current-path`; Linux validation used the separate
copy named in `/tmp/caretcms-draft-linux-current-path`.

## Durable Git retry implementation and verification (R21)

The original recovery path retained approved sources only in the publication
plan, then cleared that plan before invoking Git. An isolated regression that
disables the new receipt-save step reproduces the lost input: content and
cleanup finish, but there is no record to retry. The fixed path persists an
immutable receipt before cleanup. Receipt failures preserve the publication plan
for forward recovery, including a write that succeeded but lost its acknowledgment.

Git creates an operation marker and advances the branch in one ref transaction.
A real-Git fault test loses the acknowledgment after that transaction completes;
retry finds the existing commit without adding another. Another test kills a
separate publishing process with SIGKILL after draft cleanup and recovers the
receipt using reopened adapters. These verify process interruption, not power
loss or distributed storage durability.

The pass adds **31 unit cases** and **3 browser cases**. It covers Markdown and
JSON receipts, deletions, failed receipt writes and cleanup, abandoned temporary
files, corrupt records, immutable-ID enforcement, busy indexes, preserved working
edits and staging, changed branches, rewritten history, stale published revisions,
same-publication cleanup guards, permissions, editor isolation, scoped retries,
and the unchanged default best-effort path. Real publish-route tests verify that
Git retry does not republish, advance versions, add history, or trigger rebuilds.
Browser cases use intercepted API responses to exercise the retry button and
password-session sign-out notice; real queue/Git behavior is tested separately.

Latest verification:

- Exact version validation, all package typechecks/builds, and **129 unit files /
  1,236 tests** pass on Node 22.12.0 and 24.18.0 on macOS and Debian Linux arm64.
- All **14 native platform tests** pass on both Node versions and operating
  systems. Cloudflare defaults and dependency versions are unchanged.
- Packed Astro 6.0.0 / 7.2.4 consumers pass all four Node combinations on both
  systems, covering development, static production, production Node SSR, and restart.
- All **81 serial browser cases** pass: 52 standard, 2 CSP, 15 Markdown,
  7 static, 2 permissions, and 3 Cloudflare. All three example builds pass.

The sibling review archive contains `implementation-journal-*` logs: the
controlled missing-receipt baseline, real-Git acknowledgment tests, full gates,
native platform checks, packed consumers, browser suites, and example builds.
Browser validation uses the isolated copy in
`/tmp/caretcms-journal-browser-current-path`; Linux uses the separate copy in
`/tmp/caretcms-journal-linux-current-path`. Workspace examples and dependencies
remain intact. This pass does not bump versions, commit, push, or deploy.
All three Linux containers used by this pass were removed after successful
completion; isolated source copies and archived logs remain available for review.

## Historical Cloudflare upgrade gate

Eight new native cases write actual persistent KV/SQLite Durable Object state
through the exact storage implementation from release commit `1191d9f` (v0.5.0),
dispose the runtime, and reopen the same bindings and class/instance identities
using the current distribution. Six frozen source files are SHA-256 checked
before compilation. This does not regenerate historical records with current
adapters or mock the old protocol.

The gate verifies base content, numeric versions, entry deletion, history,
collection indexes/metadata, private drafts and their metadata/history,
rebuild receipts, deployment targets, and live sessions across code upgrade and
another restart. Legacy structured drafts are retained and reject publication.
Frozen version-1 publication plans finish each of their four bookkeeping
boundaries without a duplicate revision or history record on both providers.

Actual historical execution also confirms the upgrade limits: prefixed KV
overlays were globally shared and lack reliable tenant ownership; old collection
deletion discarded numeric versions; and old KV recorded no collection deletion
intent. The upgrade preserves ambiguous records instead of assigning owners or
manufacturing lost versions. Operators must review ownership and replay intended
KV deletions. Old Durable Object deletion markers remain effective after
recreation. Current adapters against the actual old class reject coordinated
private commands without modifying base data. Old separate drafts remain intact
when coordinated mode selects its new private keyspace.

`npm run test:platform` now runs every platform file. The native step moves from
the single-Node Playwright job into both Node CI matrix entries after builds and
unit tests. `actionlint` v1.7.12 validates the workflow (optional external
shellcheck/pyflakes integrations disabled). This is configuration validation,
not a completed GitHub run of the new working tree. The last committed baseline
`3616421` has a [successful CI run](https://github.com/web-stacked/caretcms/actions/runs/35229049881);
all hardening changes remain uncommitted and have not been pushed.

Validation: all **22 native tests** and `npm run check` (**129 unit files /
1,236 tests**, exact pins, all package typechecks/builds) pass on Node 22.12.0 and
24.18.0 on both macOS and Debian Linux arm64. The suite adds no runtime API or
dependency change. Browser/packed-consumer code is unchanged from the preceding
81-case and eight-consumer gates; those suites were not unnecessarily repeated.
See [Cloudflare upgrades](../cloudflare-upgrades.md) for the operational procedure
and remaining deployed/regional/account-lifecycle limits.

The sibling review archive contains `implementation-migration-*` logs and the
validation record. Linux uses the isolated source copy identified by
`/tmp/caretcms-migration-linux-current-path`. Workspace examples, package versions,
and dependency lockfile remain unchanged in this pass. The owned Linux container
was removed after successful completion; no account resources were created.

## R22 — Verify Worker sessions before choosing private overlays

The actual Astro Cloudflare SSR gate exposed an additional authentication-order
bug. When `CARET_SESSION_SECRET` exists only as a Worker binding, middleware
verified the session cookie before installing the request context that supplies
that binding. The early check returned no editor ID, so an authenticated preview
request selected published storage. Authentication succeeded later inside the
final context, producing an inconsistent request: signed in, but without the
requested private overlay. Preview mutations could therefore write directly to
published content when their published revision matched.

Middleware now scopes preparation with the resolved Worker environment before
verifying cookies and selecting overlays. The final context still holds the
resolved identity, policy, and selected adapter. Both scopes use AsyncLocalStorage
and end with their request; no secret or editor ID becomes global request state.
The regression checks a real signed cookie with no process environment secret,
private writes leaving base data intact, forged cookies failing closed, and scope
cleanup. Removing only this preparation scope reproduces the failure.

`npm run test:platform:ssr` builds actual Astro server output with hash-checked
released Cloudflare storage sources, seeds four frozen version-1 publication
plans, restarts against current storage code, and restarts again. Astro/core are
current in both profiles; this verifies historical storage upgrade through an
application, not a complete historical application build. The runner checks
exact recovery revisions/history, Worker-binding login, public SSR/live loaders,
concurrent HTTP writes, private preview isolation, schema rejection, competing
draft publication with the losing draft retained, cookies/drafts after restart,
and actual alarm expiry in a separate temporary object instance.

The protected fixture rejects unauthenticated application and asset requests.
It creates random temporary secrets, uses local isolated persistence, disables
uploads, and removes its scratch state at completion. Both compiled profiles
pass Wrangler deployment dry-run checks without uploading. The local SSR gate
is included in both Node CI matrix entries and `check:all`. Actual deployed
validation still requires an account selection and fresh temporary resources;
local checks and dry runs do not establish regional behavior or resource cleanup.

Validation: `npm run check` passes on Node 22.12.0 and 24.18.0 on macOS and
Debian Linux arm64: exact pins, all package typechecks/builds, **130 unit files /
1,237 tests**. The actual Astro Cloudflare SSR gate and both deployment dry runs
pass in each of those four environments. All **52 standard browser cases** and
both **permissions cases** pass in the isolated browser copy. The remaining
browser suites and packed-consumer/native storage gates retain their preceding
results and were not repeated in this pass. The new fix is covered by the
Worker-only-secret regression, four SSR runs, and the 54 browser cases above.
`actionlint` v1.7.12 validates the updated workflow.

The sibling review archive contains `implementation-worker-auth-*` logs and the
validation record, including the controlled failing baseline and passing
regression. The owned Linux validation container was removed. The shared
dependency lockfile, package versions, and example data remain unchanged.
No account resources were created, and nothing was committed, pushed, or
deployed. The deployment account question remains pending.

## Installed-package release gate

The packed-core Astro matrix already exercises the integration in development,
static production, and Node SSR. A new `npm run test:packages` gate covers the
other published artifacts and their cross-package contracts. It cleans and
builds all four packages, packs their actual distributions without publishing,
and installs those tarballs into a consumer outside the workspace. Consumer
Astro, TypeScript, Zod, and Node types use exact versions from the repository.

All 20 JavaScript/declaration export targets are checked after installation;
the consumer typechecks public imports and use across packages with strict
NodeNext and the repository's `skipLibCheck` policy. The gate requires license
and README files, rejects source/test/private-storage payloads, verifies core
has no runtime dependencies and Caretize has no core dependency, and confirms
installed packages resolve within the consumer rather than workspace links.

Execution covers public filesystem conformance, installed Caretize parsing and
planning, its executable permissions and help command with core removed from
module resolution, Zod date/label conversion,
and bundling the published browser/editor JavaScript and CSS. The installed
Cloudflare adapter package and public Durable Object class also run through
native workerd with actual local KV, SQLite, and R2. KV passes 10 checks with
four explicit optional-capability skips; separate and coordinated Durable Object
modes each pass 13 checks with one optional-capability skip. Uploaded PNG bytes
and verified MIME metadata are compared against the native R2 object.

The standalone Worker uses compatibility date 2026-01-01 and `nodejs_compat`,
empty bundled content, and empty unused Astro virtual modules. Those controls
do not replace actual application/provider/schema injection, which has separate
SSR coverage. No application defaults or runtime/dependency APIs change.
The new gate runs in both Node CI entries and `check:all`. It needs network
access for pinned consumer dependencies; it creates no remote account resources.

Validation passes on Node 22.12.0 and 24.18.0 on macOS and Debian Linux arm64,
including clean package builds and all 20 installed exports. The final four
consumer runs additionally remove core from module resolution while exercising
Caretize's executable and planning API, then restore it for adapter checks.
No packaging defects were found by this gate. `actionlint` v1.7.12 validates the
workflow, and exact version validation passes. Runtime/unit/browser code is
unchanged in this pass; the preceding 1,237-unit/54-browser/SSR results remain
the relevant implementation verification and were not repeated.

The sibling review archive contains `implementation-packages-*` logs and the
validation record. All temporary consumers/native storage and the owned Linux
container were removed. Package versions, shared lockfile, and example data
remain unchanged. Nothing was committed, pushed, deployed, or published. The
remaining release gates are hosted CI against the actual changes and deployed
Cloudflare/regional/account-lifecycle validation; the account choice is pending.
