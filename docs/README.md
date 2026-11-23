# CaretCMS Documentation

CaretCMS adds inline editing, Markdown prose editing, and a content Studio to any Astro 6 or 7 site — with zero SaaS lock-in and pluggable storage.

## Capabilities at a glance

- **Edit on the real page:** click any `data-caret` element, rendered Markdown paragraph (`data-caret-md`), image, or section layout directly on your site.
- **Edit together safely:** per-editor drafts, 3-way nested-object merging (`hero.headline` and `hero.subtext` never collide), on-page **Changes** dots (amber / blue / conflict ring), per-field undo, and **Since you were last here** change tours.
- **Publish with confidence:** choose which drafts ship via checkboxes, **Undo** a publish for 30 minutes (as a new forward commit, never rewriting Git history), and scrub **Tools → Page history** (fields, images, rich text, and Markdown body text) right on the page.
- **Clean source files:** edits write back to Markdown frontmatter, Markdown prose, and JSON data files with minimal diffs — keeping compact YAML lists, single-line JSON items, straight quotes, and sub-folder entries (`en/post-1.md`).
- **Flexible delivery & storage:** static build-time HTML baking (`output: 'static'`) or per-request server rewriting (`output: 'server'`), backed by Markdown/JSON files, filesystem storage, or Cloudflare Durable Objects / KV / R2.
- **Clean exit anytime:** `npx @caretcms/caretize init` sets up an existing site, `doctor` audits it, and `remove` takes CaretCMS back out while keeping your work.

---

## Documentation map

### Authoring, drafts & collaboration
- [Saving, drafts, and visibility](./saving-and-visibility.md) — Live vs. draft rules, Changes dots, Since you were last here, selective Publish, Undo, Page history, and `__caret_template__`.
- [Draft conflicts and publish recovery](./publish-recovery.md) — 3-way nested-object rebasing, conflict resolution, body-draft re-anchoring, crash-safe publication recovery, and durable Git retry.
- [Markdown paragraph editing](./markdown-paragraph-editing.md) — Multi-paragraph editing, Enter/Backspace/paste rules, quote preservation, and boundaries.
- [Multiline Markdown frontmatter](./markdown-frontmatter.md) — Supported YAML block scalars, compact lists, and source-preserving serialization.

### Delivery, auth & deployment
- [Static delivery](./static-delivery.md) — Authoring locally in `astro dev` and baking published edits into `dist/` at `astro build`.
- [Deployment](./deployment.md) — Production topologies, required env vars, `CARET_GIT_ON_PUBLISH`, and upload handling.
- [Deployment completion status](./deployment-status.md) — Tracking rebuild webhooks through `githubDeployment()` and custom providers.
- [Authorization policy](./authorization-policy.md) — Authoritative identity providers, role-based `authorize` hooks, and forced draft review workflows.

### Storage adapters & Cloudflare
- [Storage adapter guarantees and conformance](./storage-adapters.md) — Adapter matrix, `ENTRY_ID_RE` sub-folder paths, `DraftCoordinator`, data-file collections, and `runStorageConformance`.
- [Coordinated Cloudflare storage](./cloudflare-durable-storage.md) — SQLite Durable Objects, atomic commits, and `editorDrafts: "coordinated"`.
- [Cloudflare upgrades](./cloudflare-upgrades.md) — Upgrading existing KV and Durable Object deployments safely.

### Architecture & releases
- [Design principles](./design-principles.md) — Core constraints and product philosophy.
- [Browser maintenance](./browser-maintenance.md) — Browser runtime structure, asset delivery, and `typecheck:browser`.
- [Changelog](../CHANGELOG.md) — Full version history.
- Latest release notes: [0.7.2](./releases/0.7.2.md) · [0.7.1 (full 0.7 notes)](./releases/0.7.1.md) · [0.6.3](./releases/0.6.3.md) · [0.6.0](./releases/0.6.0.md)
