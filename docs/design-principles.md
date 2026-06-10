# Design principles

The north star, and the rules that keep CaretCMS from drifting back into being
"a CMS bolted onto a site."

## The thesis

> **The repository is the CMS, and the running site is the editing UI.**

Traditional CMSes split **content** (a DB/SaaS) from **presentation** (your code),
and editing happens in an admin UI divorced from the result. CaretCMS collapses
all three: content is versioned files in the repo, the schema is largely the
component tree, and editing happens in-context on the rendered page.

## 1. In-context editing is the primary surface

Click-to-edit on the live page is the default way to edit. For a live collection
(`caretLoader`), an authenticated editor gets stega-encoded strings — click-to-edit
with **zero** `data-caret` markup. The component tree already declares what's editable.

**Studio is the fallback, not the destination.** It earns its keep for:
- **Structural** operations: list / create / reorder / delete entries.
- **Non-visual** fields with no on-page representation: SEO metadata, draft flags,
  ordering keys.

**Review norm:** when a change adds a Studio form for something that already renders
on the page, ask first whether it should be in-context instead. Bias new work toward
making more of the site directly editable rather than adding admin forms.

## 2. The core stays dependency-free and storage-agnostic

`@caretcms/core` has **zero runtime dependencies** and never imports a validation
library — schemas arrive as plain JSON Schema. This is the property that makes
everything else composable:
- Zod stays in an optional `@caretcms/zod` helper (peer dep), used only in
  `astro.config`. Core never sees it.
- Platform code (Cloudflare KV/R2) lives in `@caretcms/cloudflare`, meeting core
  only through the `StorageAdapter` / `UploadHandler` interfaces.

Don't add a runtime dep to core. Don't import platform code into core. New
capabilities that need either belong in a sibling package behind an interface.

## 3. Content location is a swappable detail

The same content code runs over filesystem, markdown, in-memory, or Cloudflare
KV/R2 — because it only talks to `StorageAdapter`. Treat where content lives as a
first-class, documented choice (see [deployment.md](./deployment.md)), not an
implementation footnote. A feature that only works for one backend should degrade
gracefully (no-op) on the others, not break them — e.g. git-on-publish no-ops on KV.

## 4. Edits should be reviewable, not just saved

Because content is files, an edit can be a git commit (commit-on-publish) and a
publish can be a reviewable diff. Lean into the version-control model the repo
already has — blame, revert, branch-per-draft, PR review of content — instead of
reinventing it inside the CMS. The sidecar (`.caretcms/`) holds only what git
can't: monotonic revision counters for optimistic concurrency, and the fast
restore-history cache.

## 5. Codemods earn trust through verification

`caretize` writes to source files, so every transform is gated: a subsequence
check (nothing deleted), an inverse check for deletion-bearing rewrites, and a
final re-parse. A new tier ships only with the same rigor. When a transform is
ambiguous, it stays a **flag**, never a guess — an incorrect binding corrupts
user source.
