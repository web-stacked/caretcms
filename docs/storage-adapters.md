# Storage adapter guarantees and conformance

`StorageAdapter.guarantees` is an optional, descriptive contract. Existing
custom adapters can omit it; omission leaves their guarantees unspecified.
The runtime continues to use optional methods as before. A declaration neither
adds a method nor upgrades a backing store's consistency. The public
`StorageGuarantees` type is exported from `@caretcms/core`.

| Adapter | Persistence | Snapshots | Commits | Collection deletion |
| --- | --- | --- | --- | --- |
| In-memory | Process lifetime | Process locks | Process locks | Content |
| Filesystem JSON | Durable | Process locks | Process locks | Content |
| Markdown | Durable | Process locks | Process locks | Metadata only; source files retained |
| Cloudflare KV | Durable (or configured expiry) | Eventual | Single writer | Content |
| Cloudflare Durable Object | Durable (or session expiry) | Transactional | Transactional | Content |

`process` means CMS reads/writes coordinate in one process. It does not make a
series of content/revision/history writes atomically visible, and it does not
protect against independent servers or arbitrary source editors. `single-writer`
and `eventual` preserve KV's existing limitations. Expiring stores survive only
until their TTL/alarm removes them.

Transactional guarantees apply to `commitEntries` and `getEntrySnapshot`.
Separate calls to `writeEntry`, `bumpRevision`, and `appendHistory` remain separate
operations, even on a transactional adapter. A conflict returned by
`commitEntries` must leave the entire batch, including indexes, unchanged.

`SessionOverlayAdapter` declares weaker combined guarantees for separate stores:
two separately transactional stores do not atomically compare the published
baseline and write a draft. A wrapper over KV retains single-writer/eventual
semantics. Its persistence comes from the raw overlay. If either component
omits declarations, the wrapper leaves its guarantees unspecified.

A raw private store may implement `coordinateDrafts(base)` and return a bound
`DraftCoordinator` only when both stores share a transaction domain. Its ordered
paired snapshots read published content and private data together. Its commit
compares every captured new baseline, private revision/existence condition, and
`DraftGuard` before changing any data, version, history, or index. Guards include
raw recovery metadata, preventing a prepared edit from replacing a recovery
journal written without a revision bump. Unsupported pairs return `undefined`.
The additive public types are `DraftBaseline`, `DraftGuard`, `DraftSnapshot`, and
`DraftCoordinator`; existing adapters need no changes.

The wrapper uses that capability for tracked editor drafts and declares
transactional snapshots/commits when both stores also declare guarantees.
Cloudflare supplies it with `editorDrafts: "coordinated"`, keeping private editor
keyspaces inside the base object's transaction domain. Demo sessions stay in
separate expiring objects. The default remains `"separate"` for compatibility.
This capability does not make separate `writeEntry`/revision/history calls or
publication and draft cleanup one transaction. A base version guard is captured
for a new draft or body-to-structured conversion; later structured edits retain
the original publication baseline and can continue after base changes.
Publication still rejects a stale captured baseline. Unversioned filesystem or
custom external writes remain outside these guarantees.

## Private Git retry receipts

File-backed private editor overlays also provide optional
`listGitJournalReceipts`, `saveGitJournalReceipt`, and
`deleteGitJournalReceipt` methods. `GitJournalReceipt` and `GitJournalTarget`
are additive public types exported from `@caretcms/core`. Receipts are immutable
retry inputs, separate from content entries, indexes, drafts, and rebuild
receipts. Same-ID saves must be idempotent for identical input and reject changed
input; corrupt records must surface an error. These methods describe private
queue persistence, not an atomic content/Git transaction. See
[durable Git retry](publish-recovery.md#durable-git-history-retry-opt-in) for flags,
permissions, cleanup, and failure limits. Existing custom adapters need no changes.

## Entry version lifetime

Content versions must not reset when an entry or collection is deleted and
recreated. Content-removing collection deletion advances the affected entry
versions and retains revision tombstones; an old conditional save returns 409.
Metadata-only Markdown collection deletion retains the source and its revision.
This difference reflects source files being owned by the project.

CMS collection management now uses an exclusive process barrier. Entry writes,
reads, reorders, publication/recovery, history restore, and Git journaling use
shared barriers before acquiring their entry locks. Collection deletion waits
for an in-flight entry operation, and a queued entry operation observes the
deletion's new revision. Different entries can still proceed concurrently.
These barriers do not coordinate independent processes or KV isolates.

An upgrade cannot reconstruct revisions discarded by earlier collection
deletions. Clients with old open forms should reload after upgrading; numeric
tokens cannot distinguish a historical revision reuse that already happened.
Retained version tombstones use storage proportional to IDs previously written.
Do not prune them while old client versions or draft baselines can still be used.

## Public conformance runner

Import `runStorageConformance` from `@caretcms/core/testing/storage`. It has no
test-framework dependency. Supply a fresh, empty, private fixture for **each**
named check. The runner writes and deletes `caret-conformance` content, editor
overlays, metadata, history, and receipts. Never point it at production content.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemAdapter } from "@caretcms/core";
import { runStorageConformance } from "@caretcms/core/testing/storage";

const results = await runStorageConformance(async () => {
  const root = await mkdtemp(join(tmpdir(), "adapter-check-"));
  const options = {
    dataRoot: join(root, "data"), metaRoot: join(root, "meta"),
    draftsRoot: join(root, "drafts"),
  };
  return {
    adapter: new FilesystemAdapter(options),
    reopen: async () => new FilesystemAdapter(options),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
});
const failures = results.filter(result => result.status === "failed");
if (failures.length) throw new Error(JSON.stringify(failures));
```

Results explicitly report `passed`, `failed`, or `skipped`, with a message for
failures/skips. The runner checks deep clone isolation, indexes, entry and
collection version lifetime, history, metadata, editor isolation, receipt
round trips, transactional batch preflight, independent conditional clients,
and concurrent snapshot coherence. A `reopen` factory enables independent
transactional clients. `settle` can wait for visibility on single-writer
eventually consistent stores; it cannot turn them into concurrent-safe stores.

A skipped check is unverified. This is behavioral coverage, not certification:
restart durability, platform isolation, expiry, injected storage failures, and
cross-store concurrency need provider-specific tests. Repository
`npm run test:storage` runs the same checks on all five built-in adapters and
tests collection races. KV's local fake is strongly consistent; its unit results
do not simulate replication delays. Durable Object unit checks use the real
protocol with a serializing, rollback-capable fake; Playwright separately
exercises concurrent requests through a Worker.

`npm run test:platform` additionally runs the public checks inside
Miniflare/workerd against SQLite Durable Objects (13 pass, one unsupported batch
check skipped) and native local KV (10 pass, four unsupported checks skipped).
It restarts the runtime with persisted storage, injects rollback after actual
data/revision/history writes, simulates a lost commit acknowledgement, tests
prefixed overlay isolation, and verifies Durable Object alarm expiry after a
restart. KV session keys carry native expiry metadata, and invalid short TTLs
are rejected. It does not simulate KV regional replication or deployed host
failures; see [platform coverage](../tests/platform/README.md).

## Optional batch snapshots

`getEntrySnapshots(collection, ids)` returns one snapshot per requested ID, in
the same order, including missing IDs and duplicates. Empty input returns an
empty array. File adapters read the shared revision map once per batch. The
draft wrapper combines base/overlay batches while retaining the same revisions,
baseline tokens, private-state stripping, and tombstone behavior as individual
reads. This does not upgrade their process-only consistency guarantees.

Studio pages and bounded search groups use the method when available. The
runtime holds every involved entry lock before reading a batch and checks its
cardinality, ID order, and versions. A failed/invalid batch falls back to the
existing individual reads, which isolate corrupt entries. Older custom adapters
remain compatible. Cloudflare adapters currently retain their individual read
path; no remote query/batch API or stronger distributed guarantee is implied.

## Collection read baseline

`npm run bench:storage` measures local memory/JSON reference stores at 1k and
10k entries. `npm run bench:storage -- 1` requests a single observation per case.
It reports Node/platform/architecture, sample counts, and min/median/max times
for listing IDs, reading a 25-entry page with revisions, reading all content,
and searching content with revisions in bounded groups of 20. Full search is
always one observation because it is expensive. Setup and cleanup are outside
the timings; fixtures live in OS temporary directories.

These are baselines without hard pass/fail thresholds or remote-latency models.
Use provider-specific costs and distributions before designing optional query
capabilities. The original filesystem fallback parsed the whole shared revision
map for each entry; the new batch method preserves the content/version locks
while avoiding those repeated reads. Local before/after measurements and their
limitations are recorded in the [release notes](product/release-hardening-2026-09.md).
