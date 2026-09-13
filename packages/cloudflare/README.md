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

**Guidance:** treat KV-backed deployments as **single-writer** (one editor at a
time, or the demo/preview overlay which is per-session and isolated). Don't run
multi-editor concurrent editorial workflows against the shared KV store.
