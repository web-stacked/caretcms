# Changelog

All notable changes to CaretCMS are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions track the publishable `@caretcms/core` package.

## [Unreleased]

### Added

- **Astro 7 live-collection cache tags.** `caretLoader()` now attaches Astro 7
  `cacheHint` tags (`caret:<collection>`, `caret:<collection>::<id>`) to published
  content so routes/CDNs can cache it and a publish can purge it by tag. Editor
  and draft requests carry no hint — they must always render the latest edit.

### Security

- **Auth: no forgeable sessions in a locked deployment.** When no editor password
  is configured, production builds no longer sign sessions with the public dev
  fallback secret — a "locked" (read-only) deployment could otherwise be unlocked
  with an attacker-forged `caret_session` cookie. The fallback is now gated on a
  build-time dev signal (reliable on Cloudflare Workers, unlike `NODE_ENV`).
- **Auth: Worker env bindings honored.** `CARET_EDIT_PASSWORD` /
  `CARET_SESSION_SECRET` are now read from the Cloudflare Worker `env`, not just
  `process.env`, so binding-only deployments authenticate (and don't silently
  fall through to the public fallback secret).
- **Rich-text links** reject protocol-relative URLs (`//evil.com`), closing an
  open-redirect/phishing vector; embedded config JSON and theme-token CSS are now
  escaped/validated before injection.

### Changed

- **Astro 7 support (toolchain modernized).** Verified and pinned to Astro 7.0.6 /
  Vite 8 / `@astrojs/compiler` 4 / Vitest 4.1.10 / fast-check 4 / Tailwind 4.3.2.
  Core's Astro peer range is now `^6.0.0 || ^7.0.0` (**Astro 5 is no longer
  supported**), and **Node 20 is dropped** — Astro 7 requires Node `>=22.12.0`.
  caretize's `.astro` source parsing works unchanged against compiler 4; the e2e
  harness was adapted to Astro 7's new managed **background dev server** (`astro
  dev` now daemonizes) via a small foreground wrapper.
- **Embedded delivery defaults to `auto`.** `caret()` now resolves delivery mode
  automatically for embedded setups.
- **Inline editor: 409 conflicts no longer destroy your edit.** A save conflict
  keeps your text in the field and offers an explicit "Keep mine / Load latest"
  choice instead of silently overwriting it (inline and in the Studio).
- **Studio panel is an overlay drawer** and no longer reflows host layout or
  depends on a hard-coded `#main-header` selector (opt back into content-push
  with the `caret-push-content` body class).

### Fixed

- Mutation write path: unhandled promise rejection from the per-key locks on
  adapter failure; `mutate` / history-restore routes now return curated JSON
  errors instead of leaking a framework 500.
- `create_collection` / `delete_collection` now run under the collection lock
  (TOCTOU + serialization against `reorder_entries`).
- Rewrite scope-stack no longer mis-tracks bindings across HTML comments,
  `<script>`/`<style>` bodies, or `>`-in-attribute values.
- Editor a11y: `aria-live` status + `role="alert"` toasts, keyboard-visible image
  "Replace", higher-contrast toolbar text, Studio panel loading state + focus
  management; no-JS login shows its error; Studio object-array edits keep field
  types.

### Internal

- `@caretcms/cloudflare` gains a MemoryKV conformance test suite; its
  single-writer / eventual-consistency limitation is now documented.
- `@caretcms/caretize` and `@caretcms/zod` gain `prepublishOnly` version guards;
  `validate:versions` now enforces cross-package `@caretcms/*` peer lockstep; CI
  builds the example apps (API-drift guard) and adds an informational Astro 7
  compatibility job.

## [0.1.2] - 2026-06-24

### Added

- **Static delivery** — `caret({ delivery: "static" })` for static Astro sites: dev
  authoring routes in `astro dev`, build-time HTML bake in `astro build`, optional
  `delivery.publish.webhookUrl` after Publish. Documented in
  [docs/static-delivery.md](docs/static-delivery.md).
- caretize `init` defaults to static delivery wiring for static Astro projects (no
  SSR adapter); server projects still get adapter + `output: 'server'` when needed.
- caretize: **named-import loop binding** — loops sourced from a named import
  (`import { services } from "../data/site"`) are now wrapped with `editable()`;
  previously only default imports were, so most real-site loops
  (cards/testimonials/FAQs/nav/footer) were flagged but never bound. Pre-aliased
  named imports (`import { data as items }`) are skipped (renaming them would
  emit invalid JS); the `classifyConstUsage` safety gate is unchanged.
- caretize: **`astro:assets` `<Image>` / `<Picture>` binding** — these components
  now receive `data-caret`, which Astro forwards to the rendered `<img>` whose
  `src` the rewrite engine already swaps (no engine change). Recognized only when
  imported from `"astro:assets"`; `src`-only (the engine can't swap `alt`/`href`).
- caretize: per-file storage-key registry threads used keys across all tiers
  (existing `data-caret` attrs + prior-run `editable()` keys pre-claimed; tags,
  then wraps, then hoisted props; collisions take a `_2` field suffix), so one run
  can no longer mint the same `collection::id::field` twice with two value shapes.
- core: `astro:routes:resolved` warns when a project route overlaps the injected
  CMS route space (`/admin`, `/api/cms`, `/__caret`), naming the
  `mountPath`/`apiBasePath` remedy.
- core: unknown `caret()` option keys warn with a did-you-mean suggestion instead
  of silently using defaults; `locals.isEditor` is now typed `boolean` in user code
  via an `App.Locals` augmentation.

### Fixed

- core: **data-caret resolver parity** — a parity test holds all four resolvers
  (rewrite engine, browser-runtime, editor `helpers.js`, dev-toolbar) to one
  fixture corpus. Fixed two real drifts: browser-runtime scoped from `closest()`
  (self-inclusive) where the server scopes from ancestors only, and the static JS
  copies resolved scope on malformed empty-segment triples (`"::x::y"`) the server
  rejects.
- core: the browser rich-text sanitizer (`static/cms/editor/sanitize.js`) allowlist
  is now guarded against drift from `rich-allowlist.ts` by a parity test — it was
  hand-mirrored with no automated check, a latent XSS hole.
- caretize: identifiers are escaped wherever interpolated into a `RegExp`
  (`$post`/`$state` no longer silently never-match), with `$`-aware boundaries
  replacing `\b`; `frontmatterRange` tolerates a leading BOM (frontmatter tiers
  used to silently no-op on BOM files); `--dry-run` reports would-fail-verification
  files instead of hiding them; explicit targets inside skip dirs
  (`node_modules`/`dist`) are refused rather than walked.
- studio: empty-state copy is adapter-agnostic (no more `.caret/data` advice for
  markdown/KV users) and points at caretize.

### Documentation

- Static delivery guide ([docs/static-delivery.md](docs/static-delivery.md)); README,
  core/caretize READMEs, and [docs/deployment.md](docs/deployment.md) updated for
  static-first setup (server delivery still documented for instant visitor updates).

## [0.1.1] - 2026-06-11

### Added

- First npm publish of `@caretcms/caretize` (the `data-caret` auto-tagger CLI,
  with a README) and `@caretcms/zod` (Zod → JSON Schema bridge).
- `@caretcms/core/contracts` subpath exporting the shared contract surface:
  identifier grammar (`COLLECTION_NAME_RE`, `ENTRY_ID_RE`, `EDITOR_ID_RE`),
  the rewrite engine's `REWRITABLE_TEXT_TAGS`, and the rich-text allowlist.
  `@caretcms/cloudflare` now imports these instead of carrying copies; a
  cross-package parity test holds caretize's deliberate mirrors byte-identical.
- caretize: skipped-candidate hints now cover collection loops
  (`--bind-collections`) and dynamic routes (`--bind-routes`), not just `--rich`.

### Fixed

- **Inert bindings**: caretize no longer tags elements the rewrite engine
  cannot render (`div`, `code`, `cite`, `b`, `i`, `mark`, `q`), and the
  `--bind-collections` / `--bind-routes` tiers now filter by the same tag
  allowlist — previously such bindings saved through the editor but never
  appeared for visitors.
- caretize `--bind-*`: a declaration preceding `getCollection()` no longer
  steals the receiver capture (which minted bindings like
  `` blog::${undefined}::field `` or silently found zero targets), and
  template loops whose callback parameter shadows the entry variable are
  skipped instead of bound to the wrong collection.
- caretize: failed writes roll back only the current run's files — previously
  the rollback could restore a *previous* run's backups over newer hand edits.
- caretize: Ctrl-C at a prompt aborts cleanly (exit 130) instead of hanging;
  unrecognized review input re-prompts instead of accepting (`n` now skips);
  `--scope` labels are validated against the runtime grammar; `--report`
  requires a file path; quitting or a zero-change run no longer prints the
  success footer.
- Missing `CARET_SESSION_SECRET` in production no longer 500s every request
  carrying a session cookie: session checks fail closed as signed-out (logged
  once) and the login route returns an explanatory configuration error.
- `FilesystemAdapter` validates collection/entry ids on reads and filters
  invalid stems from listings — uppercase bindings now fail consistently
  everywhere instead of resolving only on case-insensitive (macOS) dev
  filesystems; `create_collection` normalizes ids (lowercase) like every
  other mutation instead of rejecting what `save_field` accepts.
- Middleware binding probe matches attribute syntax, so pages that merely
  mention "data-caret" in prose no longer run the rewrite engine or lose the
  signed-in empty-state hint.
- Collection auto-detection pins `markdownStorage()` to the detected
  `config.root` instead of `process.cwd()`.
- Cloud live-sync resolves array dot-paths (`items.0.title`) the same as the
  server rewrite engine; Studio entry templates no longer differ between
  user-created and inferred collections (single `buildTemplate`, with
  `integer` seeding `0`).

### Documentation

- Quick starts now include the required SSR adapter; core README documents the
  production env vars (`CARET_SESSION_SECRET`), what gets written to disk +
  recommended `.gitignore`, markdownStorage/localUploads production caveats,
  and the `/admin` · `/admin/cms` entry points.

## [0.1.0] - 2026-05-26

### Added

- Initial public release of `@caretcms/core` and `@caretcms/cloudflare`.
- Inline canvas editing via `data-caret` attributes — text, images, and
  section layout edited directly on the page.
- Live content collections through `caretLoader` for Astro 6 `getLiveEntry` /
  `getLiveCollection`.
- Content Studio admin for structured entry editing.
- Pluggable storage via the `StorageAdapter` interface — filesystem and
  in-memory adapters built in, Cloudflare KV/R2 adapter in `@caretcms/cloudflare`.
- Editor authentication with `HttpOnly` / `SameSite=Lax` session cookies,
  optimistic-locking conflict handling, and revision history.

[0.1.2]: https://github.com/web-stacked/caretcms/releases/tag/v0.1.2
[0.1.1]: https://github.com/web-stacked/caretcms/releases/tag/v0.1.1
[0.1.0]: https://github.com/web-stacked/caretcms/releases/tag/v0.1.0
