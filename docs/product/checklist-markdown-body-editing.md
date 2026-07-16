# Checklist - Markdown Body Inline Editing (v0.3.0)

Working checklist for [prd-markdown-body-editing.md](./prd-markdown-body-editing.md).
Check items off as they land. One commit per phase (messages at each phase
end). Gate for every phase: `npm run check` green (validate:versions ->
typecheck x4 -> build x4 -> test:unit). E2E runs separately in Phase 5.

Conventions reminder: `.test.ts` = vitest unit, `.spec.ts` = playwright e2e,
exact-pinned versions only, zero new runtime deps in core.

## Phase 0 - Decisions

- [ ] Q2: decide `.mdx` prose stamping in v1 (recommendation: defer to
      v0.4; revisit after Phase 2 parity corpus exists). Record decision in
      PRD section 11.
- [ ] Q3: decide whether bake strips `data-caret-md-src` (recommendation:
      keep). Record decision in PRD section 11.
- [ ] Confirm v1 editable block set stands: paragraph, heading, list item,
      blockquote inner paragraph (single-line-nested rule applies).

## Phase 1 - Contracts + serializer core  --  DONE (uncommitted)

Contracts (`src/markdown/contracts.ts`, re-exported from `src/contracts.ts`):

- [x] `CARET_MD_ATTR`, `CARET_MD_SRC_ATTR` (+ `BODY_OVERLAY_KEY`, `BODY_FIELD`).
- [x] Binding grammar `<collection>::<id>::body::<blockPath>` with
      `BLOCK_PATH_RE`, `parse/formatBlockPath`, `parse/formatMdBinding`.
- [x] `src` hint grammar `<start>:<end>:<hash>` (`parse/formatMdSrc`),
      bounds + 8-hex-hash validation.
- [x] `fnv1a32(str)` (8-char hex, no deps; checked against FNV vectors).
- [x] `canonicalBody(fileSource)` in `src/markdown/canonical-body.ts` --
      self-contained fence detector handling YAML `---` AND TOML `+++`
      (the YAML codec is `---`-only), trims, exposes `fileOffsetOf`.
- [x] Unit tests (`tests/unit/md-contracts.test.ts`): grammar round-trips,
      FNV vectors, canonicalBody property test slicing every offset across
      yaml/toml/no-fm + leading/trailing whitespace.

Serializer (`src/markdown/serialize.ts`, pure DOM-free TS; browser mirror
`static/cms/editor/md-serialize.js`):

- [x] Minimal `SNode` tree (DOM-free) so vitest covers it without jsdom;
      browser `domToSNodes` is the only DOM-touching part.
- [x] Closed set text/`strong`/`em`/`a[href]`/`code`/`br`; `b`->`strong`,
      `i`->`em`; adjacent same-type marks merged.
- [x] Escaping incl. `~` (GFM strikethrough) and ordered/bullet/heading/
      quote line-start markers (lone markers + EOL handled).
- [x] Emphasis-adjacency correctness (rule-of-three): alternate `*`/`_`
      across abutting emphasis, underscore-vs-word-char guard; one
      pathological shape documented + excluded.
- [x] Context-aware emit: heading level markers; nested context refuses `br`.
- [x] Hard-fail (`SerializeError`) on out-of-set node / missing href / bad level.
- [x] Property tests (`md-serialize.test.ts`, 600 runs): fixed-point stability
      through real satteri render + adversarial fuzz. Parity test
      (`md-serialize-parity.test.ts`, 1000 runs) holds TS/JS byte-identical.
- [x] `@astrojs/markdown-satteri` pinned `0.3.3` as a dev dependency
      (dev-only; core runtime stays dep-free).

Deviations from original plan (all improvements): canonical base is
fence-detected directly (not via the YAML codec) so TOML files get correct
offsets; serializer is the DOM-free source of truth with a JS mirror + corpus
parity test (jsdom avoided); byte-exact round-trip realized as fixed-point
stability through render (markdown has many equivalent encodings, so a block
canonicalizes on first edit).

Commit: `feat(core): data-caret-md contract and markdown block serializer`

## Phase 2 - Stamping plugins + injection

Shared logic (`packages/core/src/markdown/stamp.ts`):

- [x] `computeStamp(...)` + `resolveEntry` + `planParagraph` in
      `src/markdown/stamp.ts` -- attrs or null; canonical delta
      normalization; `ISLAND_TYPES` (table/tableRow/tableCell/footnoteDef/
      html/mdxJsx*/code).
- [x] `resolveEntry` maps `fileURL` -> `{collection,id}` via contentRoot;
      null outside root, on `.mdx`, on nested slugs, on id/collection regex
      failure.
- [x] Null on: `.mdx`, missing position, island ancestors, container-nested
      block with a newline in its slice. List-item dedupe handled by
      `planParagraph` (stamp the `<li>` via its FIRST inner paragraph's
      marker-free offsets; skip other paragraphs).

Frontends:

- [x] `src/markdown/satteri.ts`: named plugin, `options: { position: true }`,
      `heading`/`paragraph` visitors, `ctx.setProperty(node, "data",
      { hProperties })` (merges existing data), `ctx.parent()`/`indexOf()`
      for path + nesting. Type-only `satteri` import.
- [x] `src/markdown/remark.ts`: internal recursive walker (no
      unist-util-visit), same rules, sets `node.data.hProperties`.
      `transformCaretRemark` exported for direct testing.
- [~] No public `./markdown` subpath -- index.ts and server modules import
      relatively; nothing external consumes the plugins, so no new public API.

Injection (`src/index.ts`, `astro:config:setup`):

- [x] New `bodyEditing?: boolean` option (default true); gate: markdown
      storage entrypoint + embedded + `bodyEditing`. Runs after zero-config
      detection so an auto-selected markdown adapter is covered.
- [x] `injectMarkdownStamping`: `processor?.name === "satteri"` ->
      push to `processor.options.mdastPlugins`; else
      `updateConfig({ markdown: { remarkPlugins: [...] } })`. Never SET
      `markdown.processor`.
- [x] contentRoot threaded from the markdown provider options (fallback
      `<root>/src/content`).
- [x] One status line per branch.

Tests:

- [x] `md-stamp.test.ts` (9): real Sätteri render -- headings/paragraphs/
      list items/blockquote stamped; li marker excluded; heading marker
      included; table+code islands skipped; multi-line nested skip; `.mdx`
      skip; out-of-root skip; nested-slug skip; frontmatter-blanked offset
      normalization.
- [x] `md-stamp-parity.test.ts` (2): satteri vs remark frontends emit
      identical attributes over one tree (mock ctx); offset-base test pins
      fact 4.6 across trimmed / blanked-frontmatter / leading-blank bases.
- [x] `md-injection.test.ts` (5): satteri push (no replacement), remark
      fallback, unified->remark, `bodyEditing:false` no-op, non-markdown
      storage no-op.

Config option is `bodyEditing?: boolean` (flat, in caret's namespace) rather
than `markdown: { body }` -- avoids confusion with Astro's own `markdown`
config. Note (deferred to a later phase): `generated-node (no position) skip`
and the full GFM/edge-whitespace parity CORPUS are covered by the render test +
computeStamp guards; a broader corpus can be added when remark (Astro 6) is
actually installed to render against.

### Live dogfood (examples/content-site, real `astro dev`) -- DONE

Ran the stamping against the real Astro 7 content-collection render path
(`render(post)` / `<Content />`) on `examples/content-site`'s blog. Confirmed
the injected mdast plugin IS honored by a real build, and stamped offsets slice
to exact block text via server-side `canonicalBody`. Four bugs found + fixed:

- [x] **Relative `contentRoot`** ("./src/content") wasn't resolved against the
      project root, so `resolveEntry` never matched absolute file URLs -> zero
      stamps. Fixed: `resolve(projectRoot, contentRoot)` in the injection.
- [x] **UTF-8 byte offsets** (Sätteri) vs JS string indices -> mis-sliced /
      dropped blocks on any non-ASCII content (em dashes, accents, emoji).
      Fixed: `byteToStringIndex` converter in the satteri frontend; new
      non-ASCII regression test.
- [x] **GFM autolink** of a bare email inside emphasis produced an
      unrepresentable `x*[link]*` (opening `*` not left-flanking). Documented
      as a CommonMark/GFM limitation; property generator excludes autolink
      triggers; unit test pins the auto-link-on-render behaviour.
- [x] **Dash thematic breaks with interior spaces** (`-- -`) weren't escaped
      -> rendered `<hr>`. Fixed the line-start guard in serializer + JS mirror.

Commit: `feat(core): stamp markdown body blocks via satteri/remark plugins`

## Phase 3 - Store path (drafts)  --  DONE (uncommitted)

Mutation engine:

- [x] New `md_block` op (`mutations/contracts.ts` `MdBlockCommand` +
      `parseMdBlockCommand`; `engine.ts` `applyMdBlock` + dispatch).
      Payload: `{ collection, id, blockPath, src: "start:end:hash",
      html, expectedRevision }`. **No `md` field — markdown is derived
      SERVER-SIDE** (sanitize -> `html-to-snodes.ts` strict parser ->
      `serializeBlock`), so client markdown can never reach a source file.
- [x] Block context (heading level / nested) derived from the verified
      source range (`markdown/block-context.ts`), not client claims —
      forged contexts can't change block type or smuggle hard breaks into
      containers.
- [x] Validation order: CSRF/auth (route) -> grammar parse + 64KB html cap
      (`MAX_MD_BLOCK_HTML_LENGTH`) -> per-entry lock -> revision check ->
      `readBodySource` + `canonicalBody` hash staleness check (409 +
      `currentRevision`) -> sanitize -> derive md (400 on
      SerializeError/HtmlParseError) -> write -> bump -> history.
- [x] Always-draft: mutate route builds the editor overlay explicitly for
      `md_block` (like publish.ts) — never writes through the base
      markdown adapter, where `__body` would serialize into frontmatter.
- [x] `StorageAdapter.readBodySource?` (types.ts) implemented by
      `MarkdownAdapter` (raw file), delegated to BASE by
      `SessionOverlayAdapter`.
- [x] `executeMutation(adapter, input, options?)` gains `MutationOptions`
      (`allowedClasses`) threaded from runtime services.

`__body` invisibility:

- [x] `stripBodyOverlay` (`runtime/utils.ts`) applied at: entries route
      (single + list), `loadEntry`/`loadCollection` (content.ts),
      `caretLoader` (before stega encode), schema.ts inference fallback.
- [x] Write guards: `save_field` rejects `__body`/`__body.*` field paths;
      `put_entry` rejects data containing the key (only `md_block` may
      write it); `resolveBinding` (rewrite.ts) nulls `data-caret` bindings
      targeting it.
- [x] Regression suite `md-body-invisibility.test.ts` pins every boundary.

Tests (`md-block-mutation.test.ts`, real temp-dir MarkdownAdapter + editor
overlay):

- [x] Happy path: server-derived md under `__body`, frontmatter preserved,
      source file untouched at draft time; heading context derivation;
      accumulation across blocks.
- [x] Staleness: external file edit -> 409 + currentRevision.
- [x] Revision race: stale expectedRevision -> 409.
- [x] Script markup can't reach the stored draft (tags stripped, md
      escaped); malformed/unbalanced HTML never stores corrupt structure.
- [x] Grammar + size-cap rejections (incl. `__proto__` blockPath).
- [x] Non-markdown storage -> 400.
- [x] Reserved-key write guards (save_field / put_entry).

Note for Phase 5: `publishOverlay` does `base.writeEntry(draft.data)` — the
body flush MUST strip `__body` from the data before the frontmatter write and
apply it as source splices instead, or it lands in YAML. History route
returns raw snapshots (auth-gated, editors only) — body-history/rollback
handling is part of Phase 5's splice design.

Commit: `feat(core): markdown body draft mutations with staleness guard`

## Phase 4 - Show path (preview + editor client)  --  DONE (uncommitted)

Rewrite engine (`packages/core/src/runtime/rewrite.ts`):

- [x] `CARET_MD_ELEMENT_PATTERN` discovery pass (h1-6/p/li); swap inner
      HTML with `__body[blockPath].html`, re-sanitized on the way out
      (same trust model as `data-caret-rich`). Attributes preserved so the
      editor re-activates swapped blocks.
- [x] Public/bake isolation is STRUCTURAL, not a mode flag: base markdown
      entries never carry `__body` (their data IS the frontmatter), so the
      swap can only fire through a previewing editor's overlay adapter.
- [x] Tests (`md-preview-swap.test.ts`, 7): swap, per-block miss, no-__body
      (= published/bake path) untouched, re-sanitize (script/javascript:
      stripped), heading + li swap, malformed-binding/shape no-ops, and a
      200-run fast-check property that the swap never escapes the bound
      element.

Editor client (`packages/core/static/cms/editor/`):

- [x] `md-block-edit.js`: activation on `[data-caret-md][data-caret-md-src]`,
      contenteditable, dirty tracking, Escape-revert, blur-save.
- [x] `Enter` blocked (toast); `Shift+Enter` allowed only in top-level
      paragraphs (server independently rejects nested hard breaks).
- [x] Rich toolbar reused via selector extension
      (`[data-caret-rich], [data-caret-md]`) — bold/italic/link.
      Inline-code button DEFERRED to Phase 6 polish (execCommand has no
      code command; needs manual range wrapping; serializer already
      round-trips existing code spans).
- [x] Save = `md_block` op with sanitized innerHTML only (server derives
      md). Client pre-flights `md-serialize.js` for instant
      unrepresentable-content feedback (UX only; server is the boundary).
      NO expectedRevision: body drafts are per-editor overlays (no
      cross-editor race); the src hash is the staleness guard.
- [x] 409 (stale source) recovery: revert + "reload to edit" toast —
      re-stamping requires a fresh render, so reload is the correct v1
      recovery (deviation from the original conflict-merge idea, which
      applies to field edits, not source-range bindings).
- [x] Editor bootstrap detection extended to `[data-caret-md]` — a page
      with ONLY body bindings now loads the editor.
- [x] `sync-demo-editor.mjs` verified: directory copy, new asset included.

### Live HTTP dogfood (content-site, real astro dev) -- DONE

Full loop verified over HTTP: login -> `md_block` save against real stamped
attrs (`{ok:true,revision:1}`) -> draft JSON on disk contains SERVER-derived
markdown -> preview request (session + caret_preview) shows the swap ->
public request shows original (zero leakage) -> source `.md` byte-untouched
-> stale hash 409 -> `<script>` injection stored tag-free with escaped md ->
entries API exposes no `__body` even in preview. Drafts cleaned up after.

Commit: `feat(editor): inline editing for markdown body blocks`

## Phase 5 - Publish path + E2E

MarkdownAdapter + publish (`runtime/storage/markdown-adapter.ts`,
`runtime/publish.ts`):

- [ ] Publish flush step: collect `__body`, re-verify EVERY block hash
      against the current file; any mismatch -> whole-entry 409, file
      untouched (all-or-nothing).
- [ ] Apply splices in descending `start` (canonical->file offsets via
      `canonicalBody().fileOffsetOf`); write with `atomicWrite`; bump
      sidecar revision; history snapshot includes the pre-publish raw
      body region for rollback.
- [ ] Clear `__body` from the overlay after flush; frontmatter flush, git
      journal, rebuild webhook proceed unchanged (verify commit contains
      the body diff).
- [ ] Rollback: restoring a snapshot with a body region rewrites the body
      via the same splice machinery.
- [ ] Unit tests: multi-block publish ordering, all-or-nothing on one
      stale block, byte-exactness outside edited ranges (CRLF file too),
      history restore.

E2E (`examples/starter` + `tests/e2e/`):

- [ ] Add a markdown-backed `blog` collection to starter (contentRoot
      files + Astro glob collection + a rendered post page).
- [ ] Spec `markdown-body.spec.ts` (serial, existing harness): login ->
      click paragraph on rendered post -> edit (bold + link) -> save ->
      preview shows draft -> publish -> assert `.md` file on disk contains
      exactly the edit -> reload shows published content.
- [ ] Island inertness: an MDX-style island / code fence on the same page
      is not editable.
- [ ] Full existing unit + e2e suites green; also green with
      `markdown: { body: false }` and with JSON storage (no stamping).

Commit: `feat(core): publish markdown body edits back to source files`

## Phase 6 - Docs, release, launch

Docs (site repo `../caretcms-site`, separate commits there):

- [ ] Docs page: setup, supported blocks + marks, islands, single-line
      nested rule, concurrency/409 behavior, Astro 6 vs 7 notes,
      `markdown: { body }` config. Add to Starlight sidebar config.
- [ ] Update pricing/feature mentions if any list editable field types.

Core repo:

- [ ] README feature list + demo GIF of the paragraph-click-to-git-diff
      flow.
- [ ] CLAUDE.md + AGENTS.md: architecture section gains the markdown
      module, `__body`, canonical-base note.
- [ ] Mark PRD Status: Implemented (same convention as static-delivery
      PRD).
- [ ] Version bump + changelog; `npm run check` + e2e; publish v0.3.0
      (prepublishOnly guards run).

Launch:

- [ ] Blog post: "Edit your Astro content collections on the page itself"
      (lead with the GIF; positioning vs Tina/Keystatic per PRD section 1).
- [ ] Answer the saved Astro Discord thread (shipped feature only, link
      post + repo).
- [ ] Post update in Astro Discord showcase/announcements channel.

Commit: `chore(release): v0.3.0`
