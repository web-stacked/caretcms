# Frozen Cloudflare v0.5.0 storage implementation

The six source files here are byte-identical copies from release commit
`1191d9f19f96d3aec856412b1a0799ff3d9ff357`. `manifest.json` records their SHA-256
hashes; the native upgrade suite checks them before compilation. Do not update
these files to match current behavior. Add a separate versioned fixture for a
different historical release. These are MIT-licensed test fixtures, excluded
from the published packages and never deployed.

`tests/platform/migrations.mjs` compiles these adapters and the released Durable
Object class into a test Worker. The only runtime contract imports used by the
old KV adapter are resolved to the exact released `id-contracts.ts`; type imports
are erased. Identical test-bundled content replaces `import.meta.glob` for both
historical and current compilations, without editing the frozen files.

The released adapters write actual native KV and SQLite Durable Object state.
The suite disposes the runtime, keeps its persistence directory and binding,
Worker, class, and instance identities unchanged, and starts a Worker compiled
from the current distribution. It also tests current adapters against the old
class to check a partial deployment, then upgrades the class.

The four interrupted-publication records come from the sibling frozen
`pre-hardening-store` fixture. Old storage writes those records without using
current recovery-plan constructors. The current core engine resumes them after
the storage upgrade. This tests local runtime persistence and wire/storage
compatibility; it does not simulate deployed regional KV propagation, account
lifecycle migrations, host power loss, or an automatic data migration.
