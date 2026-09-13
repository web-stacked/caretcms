# Coordinated Cloudflare storage

`cloudflareDurableStorage()` stores each CaretCMS site in a SQLite-backed
Cloudflare Durable Object. The object is the authority for entry data,
revisions, history, collection indexes, and collection metadata.

This closes the distributed race that the KV adapter cannot close. Core submits
a validated entry transition through the optional `StorageAdapter.commitEntries`
contract. The Durable Object compares every entry revision and existence state,
then commits the complete batch. A conflict changes nothing. Single-entry saves
and deletes update data, revision, history, and indexes together; a reorder
commits every participating entry together.

## Astro configuration

Use the Durable Object provider for content. R2 remains the upload store.

```js
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import caret from "@caretcms/core";
import { cloudflareDurableStorage, r2Uploads } from "@caretcms/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [
    caret({
      storage: cloudflareDurableStorage({
        binding: "CMS_CONTENT",
        instanceName: "production",
      }),
      uploads: r2Uploads({ binding: "CMS_R2" }),
    }),
  ],
});
```

Astro applications with custom Cloudflare exports need a Worker entrypoint.

```ts
// src/worker.ts
import { handle } from "@astrojs/cloudflare/handler";
export { CaretCmsContent } from "@caretcms/cloudflare/durable-object";

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};
```

Point Wrangler at that entrypoint, bind the namespace, and declare the class as
a SQLite-backed Durable Object. Cloudflare's current configuration also supports
legacy migrations for applications that already use them; do not mix the two
lifecycle formats.

```toml
main = "./src/worker.ts"

[[durable_objects.bindings]]
name = "CMS_CONTENT"
class_name = "CaretCmsContent"

[exports.CaretCmsContent]
type = "durable-object"
storage = "sqlite"
```

Run `astro build` before Wrangler. Astro bundles the custom entrypoint and emits
`dist/server/wrangler.json`; deploy that generated configuration so Wrangler
uses Astro's resolved virtual modules and asset paths.

```sh
astro build
wrangler deploy --config dist/server/wrangler.json
```

See Cloudflare's documentation for [Durable Object class lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
and Astro's [custom Cloudflare entrypoint](https://docs.astro.build/en/guides/integrations-guide/cloudflare/#changed-custom-entrypoint-api).

## Object boundaries and overlays

`instanceName` selects the site's coordination object. Use a stable, unique name
per tenant or independently managed site. Caret creates separate object names
for each persistent editor draft and each temporary demo session, so unrelated
drafts do not serialize through the published-content object. Demo-session
objects refresh a two-hour alarm and erase their storage when it fires.

Bundled `.caret/data` remains a read-only baseline by default. The first edit
materializes the changed entry in the object; deletions use durable tombstones so
the build-bundled entry does not reappear. Set `bundledFallback: false` for an
empty object-backed site.

The adapter does not copy existing runtime values from `CloudflareKvStorageAdapter`.
Changing providers keeps build-bundled seed content but requires an explicit
export/import plan for entries that exist only in KV.

## Guarantees and limits

The local suite sends simultaneous browser requests through Wrangler to two
independent adapter clients and one real local Durable Object binding. It verifies
same-revision conflicts, concurrent collection-index additions, batch rollback,
and retry detection. Unit tests exercise the protocol with transaction scheduling
and isolated draft objects.

Cloudflare documents Workers KV as eventually consistent and unsuitable for
atomic read/write transactions. It recommends Durable Objects for stronger
consistency. Each Durable Object is a single, globally unique coordination unit;
its storage is strongly consistent and serializable. See [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
and [Durable Object design rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

The deployed-resource gate was completed on 2026-09-13 with a temporary Astro
Worker using the custom Worker export, SQLite lifecycle declaration, Durable
Object namespace, and existing KV/R2 bindings. The live site loaded in Chromium;
same-session state and history persisted, a fresh demo session remained isolated,
and simultaneous same-revision requests produced one success and one 409
conflict. The temporary Worker was deleted after validation. Repeat this gate for
each independently configured production account or environment. The KV adapter
remains explicitly single-writer.
