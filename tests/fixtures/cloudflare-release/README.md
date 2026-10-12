# Protected Cloudflare Astro release fixture

Run `npm run test:platform:ssr` from the repository root. This builds and runs
actual Astro server output in local Wrangler/workerd, with isolated temporary
secrets and persistent KV/SQLite storage. It creates no account resources and
deletes its temporary storage and secrets when finished.
Both generated Worker artifacts also pass `wrangler deploy --dry-run`; nothing
is uploaded by that command.

The released profile selects the hash-checked v0.5.0 Cloudflare adapter and
Durable Object sources. Astro and core use the current build in both profiles:
this is a storage upgrade check, not a complete historical application build.
The Worker name, class, bindings, instance identities, and persistence directory
stay unchanged across the upgrade and subsequent restart.

The runner verifies four frozen interrupted-publication plans, exact revisions
and history after recovery, SSR/live-loader content, password login with Worker
bindings, concurrent HTTP mutations, private previews, schema rejection,
competing draft publishes, surviving private drafts, session continuity after
restart, and native alarm expiry. Every application/test/asset request requires
a random bearer secret. Test inspection endpoints are never added to production
CaretCMS routes. Uploads are disabled; there is no R2 binding.

`wrangler.jsonc` contains a local placeholder KV identity. Never deploy that
template or substitute an existing application's resources. A deployed check
requires an explicitly selected account and new temporary resources. Local
results do not establish regional KV behavior, remote failures, or account
resource cleanup. CI runs the local fixture on both supported Node versions.
