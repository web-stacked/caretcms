# @caretcms/cloudflare

Cloudflare-native Durable Object/KV storage, uploads, and runtime helpers for CaretCMS.

## Usage

```js
import { defineConfig } from "astro/config";
import caret from "@caretcms/core";
import { cloudflareDurableStorage, r2Uploads } from "@caretcms/cloudflare";

export default defineConfig({
  output: "server",
  integrations: [
    caret({
      mode: "embedded",
      storage: cloudflareDurableStorage({ binding: "CMS_CONTENT" }),
      uploads: r2Uploads({ binding: "CMS_R2" }),
    }),
  ],
});
```

## Exports

- `cloudflareStorage()`
- `cloudflareStorageProvider()`
- `CloudflareKvStorageAdapter`
- `cloudflareDurableStorage()`
- `cloudflareDurableStorageProvider()`
- `CloudflareDurableStorageAdapter`
- `CaretCmsContent` from `@caretcms/cloudflare/durable-object`
- `r2Uploads()`
- `r2UploadsProvider()`
- `R2UploadHandler`
- `getCloudflareRuntimeEnv()`

## Worker environment / bindings

On Cloudflare, values are read from the Worker `env` (via
`context.locals.runtime.env`), not just `process.env`. Provide these as Worker
bindings/secrets (`wrangler secret put …` or `[vars]` in `wrangler.toml`):

| Binding | Purpose |
| --- | --- |
| `CMS_CONTENT` | Durable Object namespace for coordinated content storage (name configurable via `binding`). |
| `CMS_KV` | KV namespace for content storage (name configurable via `binding`). |
| `CMS_R2` | R2 bucket for uploads (name configurable via `binding`). |
| `R2_PUBLIC_DOMAIN` | Public R2 hostname (for example `assets.example.com` or the bucket's enabled `r2.dev` hostname). Required for uploads unless `publicBaseUrl` is configured explicitly. |
| `CARET_EDIT_PASSWORD` | Editor login password. Without it the editor stays locked. |
| `CARET_SESSION_SECRET` | HMAC secret for session cookies. **Required** in production — generate with `openssl rand -base64 32`. |
| `CARET_DEMO_MODE` | `"true"` to enable the per-visitor demo sandbox. |

The auth layer reads `CARET_EDIT_PASSWORD` / `CARET_SESSION_SECRET` from the Worker
env when they aren't in `process.env`, so a binding-only deployment works.

R2 objects are not served by Caret's API routes. `r2Uploads()` therefore rejects
an upload before writing when neither `publicBaseUrl` nor `R2_PUBLIC_DOMAIN` is
available; it never returns a relative URL that points at a nonexistent proxy.
`devServePath` is an explicit escape hatch only for hosts that mount their own
matching local image route.

## Coordinated writes with Durable Objects

Use `cloudflareDurableStorage()` for concurrent editors. It routes a site's
validated writes through one SQLite-backed Durable Object and implements core's
atomic compare-and-commit contract. Entry data, revisions, history, and collection
indexes change together; stale revisions and stale reorder batches change nothing.

Cloudflare setup requires a custom Worker entrypoint that re-exports
`CaretCmsContent`, a Durable Object binding, and a SQLite class lifecycle
declaration. See [coordinated Cloudflare storage](../../docs/cloudflare-durable-storage.md).

### Atomic editor draft baseline checks

For a new deployment, enable coordinated private drafts:

```js
cloudflareDurableStorage({
  binding: "CMS_CONTENT",
  instanceName: "production",
  editorDrafts: "coordinated",
})
```

Base content and each editor's private records remain distinct, but share one
object's transactions. A base edit racing a new draft save or body-to-structured
conversion rejects the entire batch. Paired preview snapshots are transactional.
Private data, revisions, history, metadata, indexes, and receipts are scoped by
editor. Session overlays retain separate expiring objects and cannot schedule
expiry on the shared base object. Publication and subsequent cleanup remain
separate operations with the existing recovery journal.

The default `editorDrafts: "separate"` preserves existing object names and drafts.
Before changing modes, back up existing private drafts and finish pending
publication recovery, then publish/discard drafts or explicitly migrate each
owner's raw records and associated revision/history/receipt metadata. Reload
clients after switching. There is no automatic copy or dual read; switching
modes with pending drafts leaves them in the previous object layout.
Deploy the updated adapter and `CaretCmsContent` together. Scoped operations use
new command envelopes so an older class rejects them rather than treating a
private write as a base write. There is no fallback after rejection.

## KV concurrency: single-writer only

> **Important.** The KV adapter provides best-effort optimistic concurrency, but
> it **cannot guarantee** conflict detection across concurrent writers.

CaretCMS serializes writes with an in-process lock and detects conflicts with a
revision counter. On Workers that lock is per-isolate (isolates are numerous and
ephemeral), and KV has no compare-and-swap and is eventually consistent. So two
editors saving the same entry — or two saves to different entries in the same
collection — can read the same revision/index, both pass the check, and the
later write silently wins (a lost update). The separate Durable Object adapter
addresses this; the KV adapter deliberately retains its existing behavior.

KV now records entry and collection deletions separately from content. These
markers prevent bundled `.caret/data` content from reappearing after a delete.
Recreating a deleted collection starts empty, including after later builds add
bundled entries. Old raw entry keys remain readable. A missing key from an older
release cannot reveal whether it was intentionally deleted; replay those
deletions after upgrading if necessary.

The Durable Object adapter also implements a transactional content/revision
snapshot read. Deploy the updated `CaretCmsContent` class together with the
adapter so the snapshot command and persistent bundled-fallback markers are
available. Deleted Durable Object collections stay empty after explicit or
implicit recreation, including when a later build adds bundled entries. Deletion
also invalidates revisions for bundled entries that never had stored records.
Existing deletion markers are retained during recreation; an older release that
already discarded its marker cannot reveal the original deletion intent, so
replay those intended deletions after upgrading.

Both adapters declare their guarantees: KV remains eventual/single-writer,
while Durable Object entry snapshots and batch commits are transactional.
Session stores declare configured expiry; editor drafts are durable. Combined
base/draft wrappers do not claim atomic comparison across separate objects.
Opt-in `editorDrafts: "coordinated"` places private editor keyspaces in the
base object and supplies an atomic paired-snapshot/draft-commit capability.
Collection deletion retains and advances affected entry revisions so recreation
cannot make an old conditional save valid again. Historical discarded versions
cannot be reconstructed; reload open clients when upgrading. See
[adapter guarantees and the public conformance runner](../../docs/storage-adapters.md).

KV overlays now retain their parent `keyPrefix`, isolating the same editor or
session identity between prefixed sites sharing one binding. Unprefixed stores
keep their existing `draft/<editor>/` and `session/<session>/` keys. Older
prefixed deployments wrote overlays into those global paths. Back them up and
assign each intended draft to its owning site's new prefixed editor overlay
explicitly; ownership cannot be inferred safely, so there is no automatic copy.
Ephemeral sessions can start fresh.

Repository `npm run test:platform` runs conformance, restart, rollback,
lost-acknowledgement, isolation, and alarm-expiry checks in local Miniflare/workerd
without an account or deployment. See [platform tests](../../tests/platform/README.md)
for the remaining remote-platform limits.

For existing deployments, see [Cloudflare upgrades](../../docs/cloudflare-upgrades.md)
for historical format checks, ambiguous old KV overlay ownership, retained
deletion intent, and the separate/coordinated draft transition. The native suite
now upgrades persisted state written by the exact released v0.5.0 storage code.

**Guidance:** treat KV-backed deployments as **single-writer** (one editor at a
time, or the demo/preview overlay which is per-session and isolated). Don't run
multi-editor concurrent editorial workflows against the shared KV store.
