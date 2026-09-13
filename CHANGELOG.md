# Changelog

All notable changes to CaretCMS are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions track the publishable `@caretcms/core` package.

## [Unreleased]

### Changed

- Studio now uses a compact collection switcher, title-first entry creation,
  configured titles, thumbnails, and supporting metadata, clearer singleton
  screens, and explicit collection-arrangement controls.
- Entry forms now support schema-defined field groups and descriptions,
  sanitized formatted-text editing, consolidated image replacement, and compact
  repeatable records with secondary technical metadata.
- Save and visibility states now distinguish unsaved changes, private drafts,
  live content, and entry publication. Product dialogs cover live saves,
  conflicts, restores, deletion, publishing, discarding, and sign-out choices.
- The inline toolbar now provides explicit Edit and Preview modes plus a
  movable, expandable Studio drawer that preserves unfinished form state.
- Section editing keeps movement and insertion controls visible, moves
  occasional actions into a More menu, uses clear spacing labels, and keeps
  pickers reachable above the fixed toolbar on desktop and mobile.

### Added

- Collection Studio configuration accepts `entryLabel`, `titleField`,
  `thumbnailField`, and `subtitleField` for project-specific navigation and
  entry presentation.
- Added documentation for Studio saving, drafts, publication, delivery modes,
  permission behavior, and sign-out retention.

## [0.4.0] - 2026-09-13

### Changed

- Studio deletion now opens a named modal dialog, focuses the safe Cancel action,
  contains keyboard traversal, restores the invoking control when dismissed,
  and consumes Escape before an embedded Studio drawer can close. Its heading
  order and destructive-action contrast pass an open-dialog axe scan.
- Studio history now exposes a named disclosure region with expanded state,
  moves focus into and back out of the panel, and contains Escape inside an
  embedded Studio drawer. The open region passes axe.
- Studio entry creation now opens a named modal dialog, retains keyboard focus
  within its controls, restores the invoking create button when dismissed, and
  consumes Escape before an embedded Studio drawer can close. The open dialog
  passes axe.
- Collection reordering now exposes a named disclosure region and native Move
  up and Move down controls alongside drag-and-drop. Entry, row movement,
  cancellation, saving, and embedded Escape preserve keyboard focus and mode
  state, the open region passes axe, and independently disabled creation no
  longer crashes ordering.
- Studio home collection cards now show the complete pagination total instead
  of truncating counts to the first 24-entry page.
- Creating an entry with an ID that exists on another collection page now keeps
  the dialog open, shows the localized duplicate-ID conflict, disables Create,
  and returns focus to the selected ID instead of reporting a generic failure.
- Studio field rendering, schema helpers, toolbar deployment polling, publish
  outcome presentation, draft HTTP operations, and preview-cookie transitions are separate browser modules
  with strict JavaScript type checks included in core type checking and CI.
  Assets retain their existing package and `/__caret/` delivery paths.
- Studio nested field reads and writes now share the strictly checked field
  model, including creation of missing object and array path segments.
- Studio save and delete requests now use a strictly checked mutation client;
  revision-conflict guidance remains visible while the edited form is retained
  for a safe retry.
- Studio history loading and restoration now use a strictly checked client with
  normalized history rows and curated authentication and failure outcomes.
- Studio image preparation and uploads now use a strictly checked client for
  MIME filtering, resizing, dimension normalization, multipart requests, and
  curated authentication and response failures.
- Studio entry and schema loading now use a strictly checked client for parallel
  requests, missing/new initialization, revisions, validation issues,
  publication metadata, and curated source-read failures.
- Studio preview and field-selection synchronization now use a strictly checked
  controller for embedded messages, cross-tab channels, origin filtering,
  debounced previews, and lifecycle cleanup.
- The complete Studio entry orchestrator is now covered by strict browser
  JavaScript checks, with explicit guards for dynamic config, DOM, collection,
  file, schema-template, entry, and restored-history values.
- The complete inline toolbar and its configuration/highlight dependencies are
  now strictly checked, including injected configuration normalization, cloud
  URL/session handling, status callbacks, and optional draft/deployment controls.
- Page-side Studio synchronization and its binding/sanitizer dependencies are
  now strictly checked. Iframe, cross-tab, and persisted selection messages are
  validated before selector, navigation, or DOM use.
- Inline text editing, link interactions, and linkification are now strictly
  checked. Applying a rich-text link exits safely if the browser selection is
  no longer available after opening the link popover.
- Inline image editing, compression/carousel utilities, and request-security
  helpers are now strictly checked. Malformed upload responses are rejected,
  and a missing canvas context falls back to uploading the original image.
- The floating rich-text toolbar is now strictly checked. Link popovers retain
  their editable field across focus changes and update the live anchor after DOM
  normalization, including when formatting Markdown blocks.
- Markdown block editing, paragraph grouping, and browser serialization are now
  strictly checked. Malformed paragraph-source metadata leaves the affected
  group read-only instead of crashing editor boot or entering a mutation.
- The inline save queue is now strictly checked. Malformed mutation response
  JSON no longer turns a committed save into a reported failure or suppresses
  revision-conflict recovery; malformed entry snapshots fail safely.
- The content map is now strictly checked. Duplicate binding rows target their
  exact page elements, malformed entry data and stale refreshes fail safely,
  and the map uses keyboard-accessible rows and named panel controls.
- Section and layout controls are now strictly checked. Layout saves preserve
  collection context, malformed responses and duplicate IDs fail safely,
  picker focus is managed, and control overlays no longer block editable text.
- The complete inline editor entry graph is now strictly checked. Studio panel
  state tolerates blocked session storage and iframe Escape, keyboard-focused
  link affordances remain visible, async toast actions are contained, and stega
  hydration promotes only valid complete bindings.
- The development-toolbar app is now strictly checked. Highlight toggles no
  longer close the inspector, repeated scroll flashes restore the original
  inline style, controls expose their pressed state, and rescans keep warning
  notifications current.

### Added

- Deployment status providers can associate an accepted rebuild request with a
  provider build ID and report deploying, failed, or live. Live status is shown
  only when provider evidence covers the published commit or entry revisions;
  a deterministic simulated provider supports local and browser testing. The
  GitHub Deployments provider resolves an exact Caret correlation ID, maps real
  deployment statuses, reads runtime tokens without serializing them into the
  provider configuration, and returns only provider-supplied build links.
- Cloudflare deployments can use a SQLite-backed Durable Object storage adapter
  with atomic revision, entry, history, index, and multi-entry reorder commits.
  The existing KV adapter remains available with its single-writer limit.
- Authoritative identity adapters can define a fail-closed write policy for
  editing, publishing, deleting, collection management, and uploads. Policy
  mode stores content changes in isolated per-editor drafts and preflights an
  entire bulk publication before applying it.
- Top-level Markdown paragraph regions support splitting, insertion, merging,
  deletion, undo, and plain-text paste. Drafts retain source conflict checks and
  support preview reload, publication, and history restore.
- Markdown frontmatter supports literal and folded multiline strings, including
  chomping and indentation indicators. Studio renders multiline values as textareas.
- Markdown saves and draft publication preserve untouched top-level frontmatter
  blocks and body bytes; changed fields use canonical serialization. See
  [frontmatter compatibility](docs/markdown-frontmatter.md) for limits.

### Fixed

- Markdown network-save failures retain unsaved edits for retry. Inline code
  survives sanitization; core, browser, and caretize allowlists remain aligned.
- Static structured drafts retain their original base and reject stale publications
  instead of overwriting newer edits. Legacy structured drafts require reapplication.
- Interrupted publishing retains a recovery plan; retries finish content, revision,
  history, and cleanup without repeating completed steps. Bulk results distinguish
  completed, conflicted, and recovery-required entries.
- Studio paginates collections and searches IDs and displayed titles across pages.
  Reordering is disabled when the complete collection is not loaded.
- Rebuild hooks have a bounded timeout and an editor-specific manual deployment
  retry that survives draft cleanup on supported adapters.
- Studio distinguishes missing entries from unsupported frontmatter, invalid
  content, and storage failures, with per-entry diagnostics and Retry.
- Caret's toolbar reserves space above Astro's development toolbar.

- `bodyEditing` is recognized by the unknown-option guard, so disabling Markdown
  prose editing no longer emits a false warning that the option was ignored.
- Studio history restore now returns the restored entry to the browser, records
  the replaced state for undo, and restores Markdown source byte-for-byte without
  reserializing its frontmatter.

See [draft and publish recovery](docs/publish-recovery.md) for migration, storage
requirements, and deployment retry limitations.

## [0.3.0] - 2026-08-20

### Added

- Rendered Markdown prose can now be edited directly on the page. Caret maps
  paragraphs, headings, lists, quotes, and supported text styles back to their
  exact source ranges, keeps edits as drafts, and writes them to the Markdown
  file only when an editor publishes. If the file changed in the meantime,
  Caret stops and asks the editor to resolve the conflict instead of overwriting
  someone else's work.
- Studio and the page can locate the same field. Click a field on either side to
  scroll to and briefly mark its match. This works in the sidebar and in separate
  Studio and preview tabs, including for fields inside nested records.
- Repeating groups use the correct control for each field. Editors get image
  upload and preview controls, number inputs, switches, URL fields, rich text,
  nested groups, and nested lists instead of plain text boxes.
- Repeating rows have useful names and controls for moving or removing them.
  New rows use the defaults from the collection schema and receive focus after
  they are added.
- Image fields show a larger preview, the stored URL, and a clear replace action.
  An uploaded gallery image can fill an empty ID, title, alt text, width, and
  height.
- A collection can define its label, description, icon, position, and whether
  editors may create, reorder, or delete entries. It can also point to one fixed
  entry, such as a site settings page. Caret enforces these rules on the server
  as well as in Studio.
- Studio includes English and Spanish text. Integrations can replace individual
  messages without maintaining a full translation file.
- Server deployments can use an external sign-in service. Studio records the
  editor's name with drafts and history when the service supplies one.

### Changed

- The Save area always says whether an entry is saved, unsaved, or being saved.
  It also says whether Save writes to the public site or to a private preview.
  Studio asks for confirmation before the first public save in a browser session.
- Save, History, Delete, and Preview site stay visible while the editor scrolls.
  The action bar also fits narrow mobile screens.
- Text and image changes appear on the page while an editor types in the Studio
  sidebar. After a saved structural change, the page reloads without closing the
  sidebar or losing the current entry.
- New-entry help explains permanent entry IDs and the difference between saving
  and publishing.
- Collection cards can use `images[0]`, `coverImage`, or `portrait` for their
  thumbnail. Cards show Published or Unpublished when the collection has that
  field.
- If one stored entry does not match its collection schema, public collection
  reads skip that entry and report its ID. Other entries continue to load, and
  Studio shows which fields need repair.
- Repeating rows can be dragged with a pointer or moved with the keyboard.
- Studio has clearer contrast, page headings, form labels, and navigation for
  screen readers.
- The deployment guide explains password changes, forced sign-out, and the
  limits of shared-password mode.
- Astro, the Cloudflare adapter, Wrangler, and their build dependencies were
  updated to versions with no reported npm security issues at release time.

### Fixed

- Saving an entry checks required fields, number limits, and nested field types
  before writing. Errors point to the field that needs attention.
- Reordering checks every affected entry before writing any of them. A failed
  check cannot leave half of a collection reordered.
- R2 uploads stop with a configuration error when Caret cannot return a public
  image URL. Caret no longer reports a successful upload with a URL that returns
  404.
- Uploading or redrawing an image field keeps its label, name, URL, and later
  edits connected to the same field.
- Hidden image upload controls and row action buttons have names that screen
  readers can announce.
- Clicking a page field while the Studio sidebar is on its home screen opens the
  right entry before scrolling to the field.
- Saves in one Studio or preview tab refresh the other tab without replacing an
  unsaved inline edit.
- Astro development mode keeps the current request and registered collection
  schemas available when Vite loads Caret more than once.
- Providers that use a named export no longer produce a false missing-default
  warning during builds.
- Custom Studio messages cannot break out of the script that contains them.
- Markdown editing calculates the right source range for accented characters
  and emoji with both Astro 6 and Astro 7.

## [0.2.0] - 2026-07-08

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

[Unreleased]: https://github.com/web-stacked/caretcms/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/web-stacked/caretcms/releases/tag/v0.4.0
[0.3.0]: https://github.com/web-stacked/caretcms/releases/tag/v0.3.0
[0.2.0]: https://github.com/web-stacked/caretcms/releases/tag/v0.2.0
[0.1.2]: https://github.com/web-stacked/caretcms/releases/tag/v0.1.2
[0.1.1]: https://github.com/web-stacked/caretcms/releases/tag/v0.1.1
[0.1.0]: https://github.com/web-stacked/caretcms/releases/tag/v0.1.0
