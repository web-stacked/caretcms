# PRD - Markdown Body Inline Editing (v0.3.0)

Status: **Implemented** (verified against Astro 6 and 7, 2026-08-20)
Owner: Allen
Last updated: 2026-07-15
Target: `@caretcms/core` v0.3.0
Working checklist: [checklist-markdown-body-editing.md](./checklist-markdown-body-editing.md)

This document is ASCII-only on purpose ("Satteri" refers to Astro 7's native
markdown pipeline, `@astrojs/markdown-satteri`). It is meant to be easy to
review in git, copy into issues, and work through as a checklist.

## 1. Summary

CaretCMS can already inline-edit text, rich text, images, and section blocks
bound with `data-caret`, and its `MarkdownAdapter` maps Astro content
collections (`src/content/<collection>/<id>.{md,mdx}`) to entries. But the
adapter edits **frontmatter only**:

```text
packages/core/src/runtime/storage/markdown-adapter.ts
  "The body is NOT editable in v1."
```

For the Astro audience the body IS the content. This PRD makes the markdown
body editable **on the rendered page**:

```text
Click a paragraph of your rendered blog post.
Edit it in place with the existing rich toolbar.
Save -> draft overlay (existing machinery).
Publish -> the prose is written back into src/content/blog/post.md,
           committed to git, rebuild webhook fires, static bake re-runs.
```

No competitor ships this combination (open source + git-native + true
on-page editing + markdown source round-trip). TinaCMS is sidebar-preview
and cloud-leaning; Keystatic is form-based and quiet. There is an open
Astro Discord thread literally asking for this category.

## 2. One paragraph pitch

Your repo is the CMS. Your rendered page is the editor. Publish writes
markdown files and commits them.

## 3. Current foundation (reuse, do not rebuild)

- **MarkdownAdapter** (`runtime/storage/markdown-adapter.ts`): frontmatter
  read/write with byte-for-byte body splice-through, sidecar meta
  (`.caretcms/`), persistent editor drafts via a JSON-backed
  `FilesystemAdapter` under `.caret/drafts/`.
- **Draft/preview/publish** (`runtime/publish.ts`, `routes/draft.ts`,
  `routes/publish.ts`, `middleware.ts` preview cookie): overlay drafts,
  publish flush, git commit-on-publish (`git-journal.ts`), rebuild webhook
  (`rebuild-webhook.ts`).
- **Static bake** (`runtime/static-bake.ts`): rewrites built HTML from
  storage; publish -> rebuild -> bake already works.
- **Rewrite engine** (`runtime/rewrite.ts`): attribute-driven HTML rewrite,
  `data-caret` / `data-caret-scope` / `data-caret-rich`, sanitization via
  the shared rich allowlist. Security-critical, fuzzed.
- **Rich editing client** (`static/cms/editor/rich-toolbar.js`,
  `sanitize.js`): contenteditable + bold/italic/link/clear, sanitized to
  the shared allowlist on both sides.
- **Mutation engine** (`runtime/mutations/engine.ts`): per-key promise-chain
  locks, optimistic revisions, 409 + `currentRevision` retry protocol,
  history snapshots.
- **Contracts** (`@caretcms/core/contracts` + caretize parity test): the
  pattern for shipping one grammar to multiple packages.

Nothing in this plan replaces any of the above. The feature is a new
binding type + a serializer + a storage write path, plugged into all of it.

## 4. Astro 7 pipeline facts (verified against local installs)

Astro 7 replaced remark/rehype with Satteri, a native Rust markdown engine
(`pulldown-cmark` + Oxc), shipped as `@astrojs/markdown-satteri` (0.3.x over
`satteri` 0.9.x). Verified in `node_modules` on 2026-07-15:

1. **Positions survive, but are OPT-IN and BYTE-BASED.** The plugin
   definition must declare `options: { position: true }`; nodes then carry
   standard unist `Position`. **Critical, verified 2026-07-15 via live
   dogfood: Sätteri (Rust/pulldown-cmark) reports `offset` as UTF-8 BYTE
   offsets, not JS-string (UTF-16) indices** (`"café — ok"` = 9 chars / 12
   bytes -> end offset 12). Any non-ASCII content therefore mis-slices
   unless offsets are converted. The satteri frontend converts byte ->
   string index against `ctx.source` before `computeStamp`; contracts,
   hashing, and the server splice all stay in UTF-16 string space. (remark
   offsets are unist char-based; no conversion there.) Inline-level offsets
   are coarse in pulldown-cmark -- irrelevant, the design is block-level.
2. **Plugins are typed visitors.** `MdastPluginDefinition` = named object
   with per-node-type visitor fns (`paragraph`, `heading`, `listItem`,
   `mdxJsxFlowElement`, ...). Mutations go through `ctx.setProperty`; the
   per-node `data` bag honors the `hName`/`hProperties` convention --
   verified empirically: `data.hProperties["data-caret-md"]` lands as an
   attribute in the rendered HTML, exactly like remark-rehype.
3. **Integrations extend the pipeline by mutating
   `config.markdown.processor.options.*` directly** (documented on the
   `MarkdownProcessor` interface). The default `satteri()` instance is
   created by the config schema BEFORE `astro:config:setup` hooks run, and
   `createRenderer` reads `options.*` lazily -- so pushing onto
   `options.mdastPlugins` from our integration hook is the sanctioned path.
   `markdown.processor` config merge is replace-not-append; never set it.
4. **MDX is native.** Satteri parses MDX (Oxc); `MdxJsxFlowElement` /
   `MdxJsxTextElement` mdast visitors exist WITH positions. This makes the
   v0.4 "MDX components via GUI" follow-up cheaper than the remark world.
5. **Astro 6 still uses remark/rehype** (`@astrojs/markdown-remark`), and
   core's peer range is `^6 || ^7`. Astro 7 keeps deprecated
   `markdown.remarkPlugins` shims. We therefore ship the stamping logic
   behind two thin pipeline frontends (see 6.2). Satteri is primary;
   remark is the compatibility frontend.
6. **The source the pipeline sees is NOT the file** -- verified in Astro
   7.0.6 dist. Three render paths, three offset bases:
   - Direct `.md` imports (`vite-plugin-markdown/index.js`):
     `safeParseFrontmatter(raw, { frontmatter: "empty-with-spaces" })` --
     frontmatter replaced by equal-length whitespace, so offsets are
     file-length-aligned.
   - Content collections (the main path: glob loader
     `content-entry-type.js` `getEntryInfo` -> content-layer
     `#processMarkdown`): body = frontmatter-blanked then **`.trim()`ed**
     -- offsets are relative to the trimmed body.
   - Astro 6 remark: its own body handling.
   Offsets in the attribute are therefore defined against a CANONICAL
   BASE, not the file (see 6.1). Plugins DO run for MDX documents via the
   MDX entry point, so the `.mdx` no-op guard in 6.2 is load-bearing.
7. **Container-nested block positions exclude container markers.**
   Verified: a paragraph inside a blockquote has offsets covering
   `quoted paragraph`, not `> quoted paragraph`; multi-line nested blocks
   would have `> `/indent prefixes EMBEDDED inside their range. Splicing
   multi-line text into such a range corrupts structure -- see the
   newline-free stamping rule in 6.2.

Core itself gains **zero runtime deps** (see 6.4) -- the plugins run inside
the user's Astro build where the pipeline packages already exist, and the
server write path needs no markdown parser at all.

## 5. Goals and non-goals

### Goals

- Inline-edit markdown body prose on the rendered page for `.md` entries
  served from `MarkdownAdapter` collections.
- Round-trip edits to the source file: publish splices edited markdown back
  into `<contentRoot>/<collection>/<id>.md`, byte-exact outside the edited
  blocks.
- Full reuse of drafts, preview, publish, git journal, rebuild webhook,
  static bake, history, and the 409 concurrency protocol.
- Keep `@caretcms/core` runtime-dependency-free.
- Editable v1 block set: paragraphs, headings, blockquote paragraphs, list
  items. Inline mark set: strong, em, link, inline code (the existing rich
  toolbar plus inline code).

### Non-goals (v1)

- Editing MDX component JSX, props, or expressions (non-editable islands;
  the GUI for these is the v0.4 follow-up, section 12).
- Editing code fences, tables, math, footnote definitions, raw HTML blocks
  (non-editable islands).
- Structural block operations in the body (add/delete/reorder paragraphs).
  Text-level editing only. Structural ops come with v0.4.
- `.mdx` bodies entirely (islands logic still stamps nothing there in v1 --
  see open question Q2).
- Any general-purpose HTML->markdown converter. The serializer handles our
  closed mark set only and hard-fails on anything else.

## 6. Design

Same SHOW / STORE / PUBLISH decomposition as the static-delivery PRD.

### 6.1 Binding grammar (contracts change)

New attribute, stamped at render time (never written into user source --
caretize is NOT involved):

```text
data-caret-md="<collection>::<id>::body::<blockPath>"
data-caret-md-src="<start>:<end>:<hash>"
```

- `blockPath` = dot-joined child indexes from mdast root to the block node
  (e.g. `4` = fifth top-level block, `6.2` = third item of the list that is
  the seventh block). Stable identity for the draft overlay key.
- `start`/`end` = offsets against the CANONICAL BODY BASE, defined as:
  frontmatter-stripped source, `.trim()`ed. This is pipeline-independent
  by construction (fact 4.6: each Astro render path feeds the processor a
  different base). Normalization is one line on each side:
  - Plugin side: `delta = source.length - source.trimStart().length`;
    canonical offset = `node.position.offset - delta`. Works for both the
    blanked-frontmatter base (delta = blank region + leading ws) and the
    pre-trimmed base (delta = 0).
  - Server side: canonical body = strip frontmatter with the existing
    `frontmatter-codec.ts`, then `.trim()`. Splice maps canonical offsets
    back to file offsets via `fmBlockEnd + leadingWhitespace`.
- `hash` = short content hash (fnv1a-32 hex, no dep) of
  `canonicalBody.slice(start, end)`. Staleness guard: a save is applied
  only if the bytes at the recorded offsets still hash the same.

Grammar lives in `src/contracts.ts` (id regexes, attribute names, hash fn
name + width) because the client, the server route, and the bake step all
parse it. Caretize does NOT mirror it (it never touches these attributes),
so no parity-test change there.

### 6.2 SHOW: stamping plugins (new subpath `@caretcms/core/markdown`)

One core module computes the attribute payload from
`(fileURL, contentRoot, node.position, rawSource)`; two frontends adapt it
to the two pipelines:

- `caretSatteriPlugin({ contentRoot })` -- plain named object with
  `paragraph` / `heading` / `listItem` / `blockquote` visitors calling
  `ctx.setProperty(node, "data", { hProperties: {...} })`. No import from
  `satteri` (types only, via `import type`).
- `caretRemarkPlugin({ contentRoot })` -- classic remark transformer using
  a ~15-line internal visitor (no `unist-util-visit` dep).

Injection in the integration's `astro:config:setup`
(`packages/core/src/index.ts`), only when the resolved storage provider is
the markdown provider:

```text
p = config.markdown.processor
if p && p.name === "satteri"  -> p.options.mdastPlugins.push(caretSatteriPlugin(...))
else                          -> updateConfig({ markdown: { remarkPlugins: [caretRemarkPlugin(...)] } })
```

(Name check instead of importing `isSatteriProcessor` -- it is a string
compare and keeps core import-free. Astro 6 has no `processor` key and
falls through to the remark branch.)

Rules:

- The satteri frontend MUST declare `options: { position: true }` --
  positions are opt-in (fact 4.1).
- Files outside `<contentRoot>/<collection>/<id>.md` (id/collection regexes
  from contracts) are left unstamped.
- Skip stamping inside non-editable islands (any ancestor that is a JSX
  element, table, footnote definition, or html block).
- `.mdx` files: stamp nothing in v1. This guard is load-bearing -- the
  injected plugins DO run for MDX documents (fact 4.6).
- Blocks with `position === undefined` (generated nodes): stamp nothing.
- Container-nested blocks (inside blockquote/list) are stamped ONLY if
  their source slice is newline-free (fact 4.7: multi-line nested ranges
  embed `> `/indent prefixes; replacing them with prefix-free text would
  corrupt structure). Top-level blocks may span lines freely.
- No double-stamping: a paragraph whose parent is a `listItem` is skipped
  (the `listItem` visitor owns it; in tight lists the inner paragraph
  renders no element of its own). Use `ctx.parent(node)`.

A behavior parity test asserts both frontends emit identical attributes for
the same source across a corpus (offsets are computed per-parser but must
agree on this corpus; divergent edge cases get documented exclusions or
corpus fixes -- see risk R2).

### 6.3 EDIT: client (extend `static/cms/editor/`)

- Binding discovery: elements with `data-caret-md` join the existing
  activation flow (same auth gate, same two-phase bootstrap).
- Editing surface: contenteditable on the block element; reuse
  `rich-toolbar.js` (add inline-code button), reuse `sanitize.js` with the
  same allowlist.
- Contenteditable behavior spec (browsers normalize DOM aggressively):
  - `Enter` is intercepted and blocked in v1 (structural block ops are
    v0.4 scope); `Shift+Enter` inserts a `<br>` -> serialized as a
    markdown hard break, but ONLY in top-level blocks (nested blocks are
    single-line by the stamping rule, so `<br>` is refused there).
  - Serializer normalizes browser tag aliases before emit: `b -> strong`,
    `i -> em`; style-only spans are unwrapped (sanitize.js already strips
    unknown attributes; paste goes through sanitize first).
- New `md-serialize.js`: DOM -> markdown for the closed set
  (strong/em/a/code + text, heading level and list-item context from the
  binding), with markdown-special-char escaping. Hard error -> block save
  and toast if the DOM contains anything else (paste is sanitized first,
  which strips unknown markup anyway). Heading source ranges INCLUDE the
  `#` markers (verified) -- the serializer re-emits them from the binding's
  heading level.
- Save payload -> existing mutate route with a new op:

```text
{ type: "md_block", collection, id, blockPath, src: "start:end:hash",
  html: "<sanitized html>", expectedRevision? }
```

(As built: `src` is the literal `data-caret-md-src` wire string; there is NO
`md` field — markdown is derived server-side from the sanitized html. See
`parseMdBlockCommand` in `runtime/mutations/contracts.ts`.)

`html` is client-rendered and re-sanitized server-side; it exists so
preview/rewrite can show the draft without core needing a markdown
renderer (see 6.4).

### 6.4 STORE: draft overlay (zero new deps)

Body block edits live in the entry's existing JSON draft overlay under a
reserved key:

```text
data.__body = {
  "<blockPath>": { md, html, src: {start, end, hash}, ts }
}
```

- Goes through `mutations/engine.ts` -- same per-key lock, same revision
  check, same 409 protocol, same history snapshots.
- Server re-sanitizes `html` with `sanitize-html.ts` against the rich
  allowlist before storing. `md` is validated against the same grammar
  (defense in depth; publish splices `md` into a file that becomes source).
- Staleness check at write time: reject with 409 unless the CURRENT source
  file still hashes to `src.hash` at `src.start..src.end`. String slice +
  fnv1a -- **no markdown parser in core**.
- `__body` is schema-invisible: schema registry, Studio form editor, and
  loaders must ignore/strip it (it never appears in `EntryData` consumers).

Preview (SHOW while drafted): `rewrite.ts` learns `data-caret-md` bindings.
In preview mode it swaps the element's inner HTML with the stored sanitized
`html` (exact same trust model as the existing `data-caret-rich` path).
Public/non-preview requests ignore `__body` entirely.

### 6.5 PUBLISH: splice back to source

Extend `MarkdownAdapter` + `publish.ts`:

1. Collect the entry's `__body` map from the overlay.
2. Re-verify every block hash against the current file; any mismatch fails
   the whole entry publish with 409 (no partial body writes).
3. Apply splices in descending `start` order; write via existing
   `atomicWrite`; bump sidecar revision; append history snapshot (store the
   pre-publish raw body in the snapshot so rollback can restore it).
4. Clear `__body` from the overlay; existing flow continues: frontmatter
   flush, git journal commit, rebuild webhook, static bake on rebuild.
5. After rebuild, freshly stamped attributes carry new offsets/hashes;
   stale open tabs lose on the hash check and re-fetch. Draft `src` hints
   are refreshed on next edit activation (client re-reads the attributes).

History/rollback: body splices are file-level; the restore path for a body
snapshot rewrites the body region from the snapshot (frontmatter restore
already exists).

### 6.6 Config shape

```text
caret({
  storage: markdownStorage({ contentRoot }),
  markdown: { body: true }   // default true when storage is markdown;
})                           // set false to opt out of stamping + routes
```

No new required config. `contentRoot` is already the markdown provider's
option; the integration threads it to the plugin.

## 7. Architecture changes

### 7.1 Reuse (unchanged)

Mutation engine locks/revisions/history, draft overlay plumbing, publish
pipeline, git journal, rebuild webhook, static bake, auth/CSRF, rich
allowlist + sanitizers, editor bootstrap/activation, toolbar UI.

### 7.2 Change

- `src/contracts.ts`: add `data-caret-md` grammar + hash constants.
- `src/index.ts` (`astro:config:setup`): plugin injection branch (6.2).
- `runtime/rewrite.ts`: `data-caret-md` preview swap path.
- `runtime/mutations/engine.ts`: `mdBlock` op (validate, sanitize, hash
  check, store under `__body`).
- `runtime/storage/markdown-adapter.ts`: body splice on publish; body
  region in history snapshots; `__body` stripping on reads.
- `runtime/publish.ts`: body flush step + all-or-nothing hash verification.
- `static/cms/editor/`: binding activation for md blocks; toolbar
  inline-code button.
- Schema registry / loaders / Studio entry editor: ignore `__body`.

### 7.3 New

- `src/markdown/stamp.ts` (shared payload logic, pure).
- `src/markdown/satteri.ts`, `src/markdown/remark.ts` (frontends).
- `static/cms/editor/md-serialize.js` (DOM -> md, closed set).
- Export map: `"./markdown"` subpath.
- Dev-only test deps: `satteri` (render corpus in unit tests),
  `mdast`-typed fixtures. NO new runtime deps.

## 8. Test plan

- **Round-trip properties (fast-check)**: for generated documents over the
  editable grammar: render (satteri, dev dep) -> stamp -> identity edit ->
  serialize -> splice == original file, byte-exact. And: arbitrary edits
  within the mark set -> splice -> re-render -> re-stamp -> block content
  matches the edit. Escaping fuzz: adversarial text (`*`, `_`, `[`, `` ` ``,
  `<`, `&`) survives the loop.
- **Pipeline parity**: satteri vs remark frontends emit identical
  attributes over a fixture corpus (blog-shaped docs, GFM, islands).
- **Offset-base normalization**: the same file stamped through all three
  bases (blanked-frontmatter, trimmed content-collection body, Astro 6
  remark) yields identical canonical offsets, and the server-side
  canonical body (frontmatter-codec + trim) slices to the same bytes.
  This test pins fact 4.6 against future Astro changes.
- **Container rules**: multi-line nested blocks are NOT stamped;
  single-line nested block splice preserves `> `/list markers; tight vs
  loose lists don't double-stamp.
- **Security**: extend `rewrite-properties.test.ts` invariants to the
  `data-caret-md` swap path; `mdBlock` op rejects out-of-allowlist HTML,
  bad grammar, oversized payloads; splice cannot escape the block (hash +
  offset bounds).
- **Staleness/concurrency**: external file edit -> 409; two editors racing
  on one block -> second gets 409 with `currentRevision`; publish with one
  stale block -> whole publish 409s, file untouched.
- **E2E (starter, serial)**: add a markdown-backed `blog` collection to
  `examples/starter`; spec: login -> edit paragraph on the rendered post ->
  preview shows draft -> publish -> `.md` file contains the edit ->
  re-render shows it. MDX island present on the page stays inert.
- **Unaffected paths**: full existing unit + e2e suites stay green with
  `markdown.body` disabled and with non-markdown storage.

## 9. Phased rollout checklist

### Phase 0 - Alignment

- [x] Land this PRD.
- [x] Resolve Q1-Q3 (section 11).

Commit: `docs: add markdown body inline editing PRD`

### Phase 1 - Contracts + serializer core

- [x] `data-caret-md` grammar + fnv1a hash in `contracts.ts`.
- [x] `md-serialize` logic (write it in TS in core, build a browser copy
      into `static/` the same way editor-runtime assets ship).
- [x] Round-trip + escaping property tests (satteri as dev dep).

Commit: `feat(core): data-caret-md contract and markdown block serializer`

### Phase 2 - Stamping plugins + injection

- [x] `src/markdown/{stamp,satteri,remark}.ts`, `./markdown` export.
- [x] Injection branch in `astro:config:setup` gated on markdown storage.
- [x] Island-skipping rules; `.mdx` stamped-nothing; parity corpus test.

Commit: `feat(core): stamp markdown body blocks via satteri/remark plugins`

### Phase 3 - Store path

- [x] `mdBlock` mutation op (sanitize, validate, hash check, `__body`).
- [x] `__body` invisibility in schema registry, loaders, Studio editor.
- [x] Concurrency/staleness unit tests.

Commit: `feat(core): markdown body draft mutations with staleness guard`

### Phase 4 - Show path

- [x] `rewrite.ts` preview swap for `data-caret-md`.
- [x] Editor client: activation, contenteditable, toolbar code button,
      serializer wiring, 409 recovery UX (reuse conflict-preserve flow).

Commit: `feat(editor): inline editing for markdown body blocks`

### Phase 5 - Publish path

- [x] `MarkdownAdapter` body splice + history body region + rollback.
- [x] `publish.ts` all-or-nothing body flush.
- [x] Production-shaped E2E in the Markdown-backed content-site example.

Commit: `feat(core): publish markdown body edits back to source files`

### Phase 6 - Docs + launch

- [x] Docs page in caretcms-site (`apps/docs`): setup, supported blocks,
      islands, concurrency behavior, Astro 6 vs 7 notes.
- [x] README + CLAUDE.md/AGENTS.md architecture notes.
- [ ] v0.3.0 release; blog post; answer the Discord thread (no vaporware:
      post only once shipped).

Commit: `chore(release): v0.3.0`

## 10. Risks

- **R1 Serializer correctness is the product.** A bad round-trip corrupts
  a user's source file. Mitigation: closed grammar, hard-fail on unknowns,
  property tests as the gate, all-or-nothing publish, history snapshot of
  the pre-publish body, git journal as the ultimate undo.
- **R2 Parser divergence** (pulldown-cmark vs micromark offsets/AST edge
  cases). Partially de-risked: block-level satteri offsets verified
  byte-exact by probe; pulldown-cmark's known position weakness is
  inline-level, which we do not use. Mitigation for the rest: parity
  corpus pins supported shapes; offsets are only ever applied against the
  same canonical body they were computed from, guarded by the hash;
  divergence therefore degrades to "block not editable/409", never to
  corruption.
- **R2b Render-path coupling.** The canonical-base normalization encodes
  how Astro feeds source to the processor (fact 4.6: `empty-with-spaces`
  vs trimmed body). A future Astro minor could change this. Mitigation:
  the normalization is derived (`trimStart` delta), not hardcoded per
  path; the offset-base test in section 8 fails loudly if a new base
  appears; the hash guard makes any drift non-destructive.
- **R3 Satteri is 0.x.** Plugin API may shift. Mitigation: type-only
  imports, name-string detection, the frontend is ~100 lines; pin nothing
  (it ships inside astro).
- **R4 Deprecated remark shims removed in Astro 8.** The remark frontend
  then serves Astro 6 only; satteri path is primary by design.
- **R5 `__body` leaking into consumer-visible data.** Mitigation: strip at
  every read boundary + a dedicated regression test.

## 11. Open questions (decide in Phase 0)

- **Q1**: RESOLVED (probe, fact 4.7): stamp the inner paragraphs; their
  positions exclude the `> ` markers, and the newline-free rule bounds
  them to safe single-line splices. Never stamp the blockquote itself.
- **Q2**: RESOLVED: defer `.mdx` prose stamping to v0.4. Version 0.3 stamps
  `.md` only; JSX and MDX islands remain read-only.
- **Q3**: RESOLVED: keep `data-caret-md-src`. It follows the existing public
  binding-attribute behavior and lets the editor reactivate without a fetch.

## 12. v0.4 outlook - MDX components via GUI (not in scope, sets direction)

The Discord ask. Satteri gives positioned `MdxJsxFlowElement` nodes; the
existing section-controls system (picker, insert, reorder, props) already
models the interaction. v0.4 points section-controls at an MDX
serialization target: stamp component nodes, edit props via a
schema-driven form (component prop schemas via `@caretcms/zod`), serialize
JSX attribute changes back through the same splice+hash machinery.
Structural body ops (add/delete/reorder blocks) land here too. Nothing in
v0.3 may preclude this: blockPath grammar and splice engine are shared.

## 13. Success metrics

- Property suite: zero round-trip corruptions across the fuzz corpus.
- Starter e2e: edit -> publish -> `.md` diff contains exactly the edit.
- Existing suites green in both Astro 6 and 7 example targets.
- Launch: blog post published; Discord thread answered with a shipped
  feature; measurable installs/stars uptick in the following two weeks.
