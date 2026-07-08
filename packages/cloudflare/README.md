# @caretcms/cloudflare

Cloudflare-native storage, uploads, and runtime helpers for CaretCMS.

## Usage

```js
import { defineConfig } from "astro/config";
import caret from "@caretcms/core";
import { cloudflareStorage, r2Uploads } from "@caretcms/cloudflare";

export default defineConfig({
  output: "server",
  integrations: [
    caret({
      mode: "embedded",
      storage: cloudflareStorage({ binding: "CMS_KV" }),
      uploads: r2Uploads({ binding: "CMS_R2" }),
    }),
  ],
});
```

## Exports

- `cloudflareStorage()`
- `cloudflareStorageProvider()`
- `CloudflareKvStorageAdapter`
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
| `CMS_KV` | KV namespace for content storage (name configurable via `binding`). |
| `CMS_R2` | R2 bucket for uploads (name configurable via `binding`). |
| `CARET_EDIT_PASSWORD` | Editor login password. Without it the editor stays locked. |
| `CARET_SESSION_SECRET` | HMAC secret for session cookies. **Required** in production — generate with `openssl rand -base64 32`. |
| `CARET_DEMO_MODE` | `"true"` to enable the per-visitor demo sandbox. |

The auth layer reads `CARET_EDIT_PASSWORD` / `CARET_SESSION_SECRET` from the Worker
env when they aren't in `process.env`, so a binding-only deployment works.

## Concurrency: single-writer only

> **Important.** The KV adapter provides best-effort optimistic concurrency, but
> it **cannot guarantee** conflict detection across concurrent writers.

CaretCMS serializes writes with an in-process lock and detects conflicts with a
revision counter. On Workers that lock is per-isolate (isolates are numerous and
ephemeral), and KV has no compare-and-swap and is eventually consistent. So two
editors saving the same entry — or two saves to different entries in the same
collection — can read the same revision/index, both pass the check, and the
later write silently wins (a lost update). A durable fix would require Durable
Objects (a compare-and-swap coordinator), which this adapter does not use.

**Guidance:** treat KV-backed deployments as **single-writer** (one editor at a
time, or the demo/preview overlay which is per-session and isolated). Don't run
multi-editor concurrent editorial workflows against the shared KV store.
