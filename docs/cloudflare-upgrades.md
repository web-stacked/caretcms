# Upgrading existing Cloudflare storage

The native upgrade suite writes persisted state through the released v0.5.0
Cloudflare adapters and Durable Object class, then reopens it with the current
distribution. It verifies content, versions, history, collection indexes and
metadata, private drafts, rebuild receipts, deployment targets, and live sessions.
It also resumes frozen version-1 publication plans before writing, after data,
after revision, and after history, without applying the transition twice.

Run `npm run test:platform` to exercise this alongside storage conformance,
transaction failures, lost acknowledgments, alarms, and coordinated draft races.
The [frozen implementation](../tests/fixtures/upgrade/cloudflare-v0.5.0/README.md)
is hash-checked before compilation. GitHub's Node CI matrix runs the full native
suite on both Node 22.12.0 and Node 24.

## Keep storage identities stable

Back up runtime data before upgrading and quiesce writers during account-specific
migration work. Backups must include private overlays and recovery plans,
revisions, history, metadata, indexes, rebuild receipts, and deployment targets;
public entry data alone is insufficient. Preserve the deployed bundled baseline
and configuration with the backup.

Keep the existing KV binding and `keyPrefix`, or Durable Object binding, namespace,
class, and `instanceName`, unchanged for an in-place code upgrade. Changing them
selects a different store; it does not import existing runtime content. Reopening
the same local persistence identity is tested. Validate deployment and rollback
with the actual account's class lifecycle and namespace configuration separately.

Deploy the Durable Object class and adapter together. Current coordinated private
commands fail closed against the v0.5.0 class instead of writing into base content.
This does not make a partially deployed application usable: newer snapshot and
draft capabilities require the matching class. The test for this condition uses
the actual frozen old class, rather than a mock rejection.

## Existing private drafts

Unprefixed KV overlays and the default separate Durable Object editor objects
keep their existing locations. Legacy structured drafts without a captured
published baseline remain readable but publication rejects them with
`legacy_draft`. Copy the intended edits, resolve against current published data,
and create a fresh draft. Pending version-1 publication recovery remains available;
finish recovery before discarding or moving its records.

Old prefixed KV deployments wrote private editor and session overlays into global
`draft/<editor>/` and `session/<session>/` keyspaces, omitting the parent prefix.
New overlays live under their full parent prefix. Existing global records are
preserved, but are **not automatically assigned** to any prefixed tenant. The
old format cannot prove ownership, and one tenant may already have overwritten
another's private data. Back up the shared keys, compare ownership and published
baselines, and explicitly recover only records whose owner is known. Do not copy
the same shared private store into every tenant. Unprefixed deployments still
read their original locations. That path alone does not prove ownership when
the binding historically mixed prefixed and unprefixed sites: those records
also need ownership review. Expiring sessions need not be migrated; editors
should start fresh sessions after upgrading.

Keep `editorDrafts: "separate"` until existing separate-object drafts and recovery
are resolved. Opting into `"coordinated"` starts a different private keyspace in
the base object; it does not read or erase the separate objects. The native test
verifies that both layouts remain isolated and persistent. There is no bundled
automatic migrator between these layouts. Publish/discard completed drafts
before switching, or use a separately reviewed operator migration with backups
of each owner's complete private state. Reload clients after any move.

## Deletion intent and versions that cannot be reconstructed

The old Durable Object format retained a collection deletion marker. That marker
survives an upgrade and recreation, so bundled entries stay removed. Old KV had
no such marker: after old collection deletion, bundled content can reappear and
the upgrade cannot infer whether that was intentional. Review and replay the
intended deletion with the new adapter; its retained marker then survives
recreation and restart. Recreating a collection does not re-enable the old seeds.

Both v0.5.0 adapters discarded entry revisions when deleting an entire collection.
Those historical numeric versions cannot be reconstructed from missing keys.
The new adapters retain versions for future deletions, but do not manufacture
lost tokens. Reload old client forms and review saved draft baselines against
current data; an earlier reused numeric version cannot identify every stale
historical draft. Do not prune newly retained revision tombstones while old
client tokens or draft baselines remain usable.

## What still needs deployed validation

The local suite uses real workerd storage and runtime restarts. It does not
establish production regional KV propagation, provider outage behavior, account
migrations, power-loss durability, or arbitrary older formats. Repeat the
content/private-state roundtrip and publication-recovery checks against an
isolated deployment in the target account, including TTL/alarm expiry and
concurrent requests from independent clients. KV retains its documented
single-writer/eventual-consistency limits. Validate deployed Astro SSR separately;
the packed consumer matrix currently covers production Node SSR.
