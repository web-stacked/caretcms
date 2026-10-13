# Draft conflicts and publish recovery

Structured drafts in static authoring retain the published revision and data
from their first write. Publication compares both before changing base content.
Any intervening entry change rejects the whole structured draft with
`stale_entry`, including changes to different fields, nested objects, arrays,
and deletions. This deliberately preserves the newer publication; automatic
field merging is not implemented. Server delivery still saves structured fields
live. Markdown body drafts continue to validate their source ranges and hashes.

## Versions when saving the first draft

Merged/fallback draft entries include both `revision` (the editor overlay) and
`baseRevision` (the published content used in that view). Custom clients should
copy both into `expectedRevision` and `expectedBaseRevision` on their mutation.
The response includes the versions at top level for a missing single entry.

A conditional `put_entry` that starts a structured draft must supply the base
version. The same rule applies when converting a body-only draft into a
structured draft. A missing or changed base version returns 409 with
`currentRevision` and `currentBaseRevision`, without changing the draft. Reload
and resolve the conflict before retrying. The first structured edit of a
body-only draft captures the newly observed base; later structured saves retain
that baseline for publication conflict checks. Unconditional commands without
`expectedRevision` retain their unconditional semantics.

These checks do not make two independent base/overlay Durable Objects a single
transaction. The base can change after comparison and before the overlay write;
publication checks the captured baseline again. Numeric versions also cannot
identify filesystem edits that do not advance a revision.

## Existing drafts and conflicts

Structured drafts created before baseline tracking are retained but rejected
with `legacy_draft`. Body-only legacy drafts can still publish if their source
hashes match. Private baseline and recovery keys never become public entry data
and cannot be supplied through mutation commands.

On a conflict, copy the draft edits somewhere safe before discarding them,
reload the latest content, and reapply the intended changes. The toolbar's
Discard button removes **all** of the editor's drafts. The authenticated
`DELETE /api/cms/draft?collection=…&id=…` endpoint can discard a single entry.
A conflicted draft is not automatically discarded or overwritten.

New publications validate the final entry against current schema and managed
publication requirements before creating a recovery plan or changing content.
`invalid_entry` preserves the draft for repair. History restore validates the
snapshot under the same requirements and returns 400 with issues on failure.
Source-backed restores also verify that the source frontmatter matches the
snapshot's recorded data.

## Interrupted publication

Publication persists a plan in the editor's overlay before writing base content.
The plan contains the before/after data and, for Markdown, the original and
prepared source, plus a stable history operation ID. Under the entry lock it:

1. Writes the prepared content.
2. Advances the base revision once.
3. Appends the original state to history once.
4. Clears the draft and recovery plan.

A failed step retains the plan. Restore storage access and click Publish again.
A retry checks stored content, source, revision, and history to finish the
remaining steps without reapplying a Markdown splice or incrementing twice.
Edits and discards of that draft are blocked until recovery finishes.
If the schema changes while a plan is pending, a retry validates again before
writing content. If the planned content was already written, recovery finishes
its revision, history, and cleanup even if the new schema would reject it. This
keeps an already applied operation recoverable without applying its content
again.
Filesystem overlays persist this state across adapter/server restarts;
in-memory overlays last only as long as the process.

If another writer or source edit intervened during recovery, the response reports
`recovery_conflict` and leaves the plan untouched. An operator must compare the
stored before/after plan with current content and restore a consistent state
before retrying. Preserve a backup of both before making that repair; there is
no automatic merge or force-publish command.

`POST /api/cms/publish` returns separate `published`, `conflicts`, and `failed`
arrays. HTTP 200 / `ok: true` means the request was processed, not that every
entry succeeded. A failed entry may already have changed base content. The
browser reports that distinction and keeps recovery available. Bulk publishing
continues to other entries and reports completed entries even if another fails.
Git journaling and rebuild hooks receive only the entries whose publication
finished.

These are forward-recovery semantics, not atomic visibility across content,
revision, and history, and not an all-or-nothing bulk transaction. Guarantees
require serialized writers and storage that durably preserves acknowledged
writes and supports consistent reads. The built-in filesystem implementation
uses atomic file replacement. Cloudflare KV retains its documented single-writer
and eventual-consistency limitations; this change adds no distributed lock.

## Immutable Git publication journal

With `CARET_GIT_ON_PUBLISH=true`, built-in file adapters retain exact planned
source paths and bytes in the private recovery plan before modifying base
content. The Git journal builds its tree from those bytes rather than staging
the working files after publication. Later edits and file recreations remain on
disk, and unrelated staging stays intact. Separately staged changes to the
approved files retain their blobs as well.

The journal holds the CMS entry locks while checking the approved revisions
and committing, so an older delayed request cannot overwrite a newer CMS
publication in Git. It cooperates with Git's index lock and advances the
captured ref only if its old commit still matches. Busy indexes, unresolved Git operations, unsafe
paths, and failed signing skip the journal; content publication still succeeds.
It respects ignored untracked sources and configured commit signing. Git commit
hooks and clean filters are bypassed to keep the approved bytes unchanged.
Custom adapters need `preparePublicationSources`; legacy path-only adapters and
older recovery plans without retained bytes skip Git rather than re-reading
mutable files. Source bytes and paths are not returned in the publish API.

Without durable retry enabled, the journal remains best effort: a crash after
content cleanup can omit it. Git ref advancement and index refresh are separate
steps. A completed Git tree contains only approved snapshots; this is not an
atomic content/Git transaction.

## Durable Git history retry (opt-in)

For built-in filesystem JSON or Markdown storage, enable both environment flags:

```sh
CARET_GIT_ON_PUBLISH=true
CARET_GIT_JOURNAL_RETRY=true
```

This mode records one private immutable receipt per entry, after content,
revision, and history finish and **before** clearing its recovery plan. Receipts
retain the approved source bytes, stable operation ID, author, and original Git
working tree and branch. They persist in the editor overlay's
`meta/git-journal/<sha256-operation-id>.json` files. Keep the drafts directory
private, excluded from Git, and included in recovery backups. Neither entry
reads nor the publish response expose these bytes, paths, or operation IDs.

Publication requires an available Git working tree and captured source snapshots
in this mode. An unavailable checkout is rejected before content changes. A
snapshot failure retains the draft; a receipt-write failure retains publication
recovery, and content may already be applied. Retry Publish to finish that plan.
Existing recovery plans without receipts still finish through their original
best-effort path. Default grouped Git commits remain unchanged; this opt-in mode
uses a separate commit for each entry to permit independent recovery.

After cleanup, a failed Git operation leaves its receipt pending. The editor
shows **Retry Git history** independently of whether any drafts remain.
Authenticated, CSRF-protected `POST /api/cms/publish` with
`{ "retryJournal": true }` retries this editor's records; optional `collection`
and `id` scope the retry. This never republishes content, advances its revisions,
adds content history, or calls deployment hooks. Normal publication also attempts
pending records in its scope. There is no background retry. Publish and delete
permissions are checked for all selected records before any Git commit.

The response's `journal` reports `completed`, `pending`, `blocked`, and the last
acknowledged `commit`; `journalRetryAvailable` indicates remaining records.
`GET /api/cms/draft` includes `journalPending` and permission-aware `retryJournal`
when records remain. Pending Git history is separate from published content and
deployment status. Password sessions receive a new editor ID after signing out,
so their next login cannot reopen this queue. The toolbar warns before sign-out;
records remain for operator recovery. Stable named identities can reopen their
private records after signing in again.

Each completed journal atomically records a Git marker at
`refs/caretcms/journal/<sha256-operation-id>` together with branch advancement.
If Git succeeds but its acknowledgment or queue cleanup is lost, retry recognizes
the marker in the original branch's ancestry and only clears the receipt. An
already matching approved tree receives a marker without an empty commit.
Markers are local refs, are not automatically pushed or pruned, and should be
retained while matching receipts or recovery plans can still be retried.

An unmarked receipt whose content revision has advanced is held as `blocked`;
retry will not replace newer published content in Git. A different working tree,
branch, detached checkout, or rewritten history also leaves the record pending.
Return to the original checkout or have an operator compare current content,
receipt sources, and Git history with backups. After manually recording or
deliberately abandoning a record, the isolated raw overlay's
`deleteGitJournalReceipt(operationId)` can remove it. There is no force retry or
automatic stale-record discard.

Custom adapters may implement the optional private-overlay methods
`listGitJournalReceipts`, `saveGitJournalReceipt`, and `deleteGitJournalReceipt`,
alongside base `preparePublicationSources`. Saving must durably insert immutable
input, accept an identical retry, and reject a changed receipt for the same ID;
listing must not silently discard corruption. Without these capabilities the
existing best-effort path remains available, and explicit journal retry is
unsupported. Cloudflare adapters do not journal a local Git checkout.

These guarantees assume serialized CMS writers and acknowledged file writes
surviving a process restart. Atomic replacement does not establish survival of
host power loss. Git ref advancement and index refresh remain separate: a crash
or lost Git acknowledgment between them can leave an old index even though the
approved commit and marker exist. Retry acknowledgment does not restage files.
Content and Git are still separate operations.

## Interrupted source restore

History restore of a full Markdown source persists a private recovery plan
before replacing the file. It reuses forward recovery for source, revision,
history, and plan cleanup, with a stable operation ID. On a storage failure,
retry the **same snapshot**. The Studio shows this retry instruction. A pending
plan survives adapter/server restart with built-in file storage and can finish
even if recording history trimmed the original target snapshot.

Recovery checks current data/source and revision before proceeding. A newer
edit or a different requested snapshot returns 409 and preserves the plan.
Schema changes reject writes that have not yet applied; already applied source
finishes its bookkeeping. If the full desired source is already current after
successful cleanup, retrying it changes neither revision nor history.

File adapters implement `makeRecoveryOverlay(editorId, "source-restore")` in
`<draftsRoot>/<editorId>/recovery/source-restore/{data,meta}`. This store is
separate from normal editor drafts and other editors' recovery data. Custom
source-backed adapters must provide a durable, isolated recovery store before
full-source history restore is enabled. Preserve a backup of the plan and
current source when resolving a recovery conflict; there is no automatic merge
or force restore.

A plain entry-data restore uses the adapter's existing commit primitive.
Source restore provides forward recovery, not atomic visibility across source
and metadata or a distributed lock against arbitrary external writers.

## Upgrade verification

The unit gate copies frozen pre-hardening JSON/Markdown stores and resumes old
version-1 recovery records without regenerating them through current adapters.
It verifies every bookkeeping boundary, additions/deletions, legacy body-only
drafts, retained structured-draft conflicts, and private metadata/receipt
isolation. See [the fixture format](../tests/fixtures/upgrade/README.md).

After `npm run build:core`, run `npm run test:compat -- 6.0.0` for the exact
Astro peer lower bound, or `npm run test:compat` for the root's pinned version.
The temporary packed consumer exercises live loading, authenticated draft
publication, version conflicts, shipped assets, and production static baking.
CI runs both consumers on Node 22.12.0 and Node 24. These checks supplement the
Playwright suites; they do not establish distributed transaction guarantees.

## Rebuild timeout and manual retry

`delivery.publish.timeoutMs` defaults to **5000 ms**, clamped to 1–30000 ms.
Timeouts, network failures, and non-success HTTP responses do not roll back
published content. Browser errors never include configured authorization headers
or the hook URL.

After publication, adapters with `getRebuildReceipt()` / `setRebuildReceipt()`
retain the hook payload in editor-specific metadata before calling the hook.
The built-in filesystem, in-memory, and Cloudflare KV editor overlays implement
these optional methods. Existing third-party adapters remain compatible; without
these methods, retry the deployment through your deployment service.

Retry deploy sends authenticated, CSRF-protected
`POST /api/cms/publish` with `{ "retryRebuild": true }`. It reuses the pending
payload without republishing content, changing revisions, or adding history.
It works after drafts are cleared and, with persistent storage, after reload.
A later successful publish also includes pending entries in its hook payload.

Delivery is **not exactly once**. A timeout may occur after the receiver accepted
the request; a receipt-clear failure may also leave an already accepted request
available to retry. Receivers should deduplicate using collection/ID/revision or
commit. Receipts are stored after content publication, so a crash before receipt
persistence, or a receipt write failure (`receiptError: true`), can require a
manual deployment outside Caret. There is no automatic background retry.
Hook success confirms HTTP acceptance only, not a completed/live deployment.
