# Draft conflicts and publish recovery

Structured drafts in static authoring retain the published revision and data
from their first write. Publication compares both before changing base content.
Any intervening entry change rejects the whole structured draft with
`stale_entry`, including changes to different fields, nested objects, arrays,
and deletions. This deliberately preserves the newer publication; automatic
field merging is not implemented. Server delivery still saves structured fields
live. Markdown body drafts continue to validate their source ranges and hashes.

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
