# Local Cloudflare storage validation

Run `npm run test:platform` after `npm ci`. The command builds core and Cloudflare,
then runs the public conformance suite against KV and SQLite Durable Objects in
Miniflare/workerd. It uses the compiler and runtime shipped with the demo's pinned
Wrangler, temporary persistence directories, and test-only Worker controls.
It requires no account, credentials, deployment, or existing data.

The suite destroys and recreates the runtime to check persistence, injects a
failure after actual transaction writes to verify rollback, simulates a lost
commit acknowledgement, and checks native alarm expiry after a restart. KV tests
check session expiry metadata and the platform's minimum TTL.

The opt-in coordinated-draft checks run the real core overlay wrapper inside the
Worker. Independent clients change base content after preparation; the draft
transaction rejects every change in the batch. Private scopes survive restart
without leaking data or receipts into base, other editors, tenants, or sessions.
Mid-transaction rollback and lost acknowledgements also exercise draft commands.
A recovery journal inserted without a revision bump remains intact when the
prepared edit conflicts. Public conformance runs for separate and coordinated
Durable Object layouts as well as KV.

The historical upgrade suite first writes native persistent KV and Durable
Object data using hash-checked copies of the released v0.5.0 storage code, then
restarts with the current distribution and unchanged storage identities.
It verifies base/private state, deployment receipts, live sessions, and all four
boundaries of frozen version-1 publication recovery. It also checks current
adapters against the old object class, separate/coordinated draft isolation,
ambiguous old prefixed KV overlays, and deletion intent/version values discarded
by the old release. KV uses independent reads; these do not claim an atomic
snapshot. See [Cloudflare upgrades](../../docs/cloudflare-upgrades.md).

GitHub's Node CI job runs all platform files after builds and unit tests on each
Node matrix entry. Local validation uses `npm run test:platform` to build first.

`npm run test:platform:ssr` also builds actual Astro Cloudflare server bundles
and runs their HTTP routes through local Wrangler. It checks authentication
using Worker-only secrets, private SSR previews and CMS drafts, concurrent writes
and publishes, and historical storage recovery through application restarts.
See the [protected SSR fixture](../fixtures/cloudflare-release/README.md).

These are local platform tests. They do not model KV replication between regions,
remote latency or rate limits, network partitions, abrupt host power loss, or
production Durable Object migrations. KV remains single-writer. A stale retry
after an acknowledged-or-unacknowledged commit still requires reading the current
version; this suite does not claim an idempotent success receipt.
