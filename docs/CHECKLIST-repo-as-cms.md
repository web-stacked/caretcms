# Checklist — "Repository is the CMS" initiative

Work off this top-to-bottom. Each task notes the primary file(s). See `PRD-repo-as-cms.md` for
rationale, contracts, and risks. Boxes: `[ ]` todo · `[~]` in progress · `[x]` done.

Global rule for every PR: `npm run check` stays green; core keeps **0 runtime deps**; KV/R2 path
unaffected.

---

## W1 · Single-source schemas (`@caretcms/zod`) — start here

- [ ] Scaffold `packages/zod` → `@caretcms/zod`; `zod` (+ `zod-to-json-schema` for Zod 3) as
      **peerDependencies**; build/typecheck wired into root scripts + `validate:versions`.
- [ ] `schemasFromCollections(collections)` → `Record<string, Record<string, unknown>>`; iterate
      collections, convert each `.schema` via `z.toJSONSchema()` (Zod 4) / `zodToJsonSchema()` (Zod 3).
- [ ] Mapping layer:
  - [ ] promote Zod `description` → JSON Schema `title` (Studio reads `prop.title`).
  - [ ] `z.coerce.date()` → `{type:"string", format:"date"}`.
  - [ ] convention/annotation hits → `format`: `"image"`, `"html"`, `"uri"` (support `.meta({format})`).
  - [ ] reject non-`z.object()` roots with a clear error.
- [ ] Validate output against `CollectionSchema` shape (`packages/core/src/types.ts`): `type:"object"`
      + `properties`.
- [ ] Unit tests: each field type + each mapping gap (date/image/html/title/optional/array).
- [ ] Migrate `examples/content-site`: derive `blog` from `content.config.ts`; delete its duplicate in
      `caret.schemas.mjs`; confirm Studio labels/inputs unchanged (manual + screenshot).
- [ ] Docs: supported Zod→JSON-Schema mappings + the `format` annotation convention.

## W2 · Drafts & Publish

**Editor identity**
- [ ] Extend `SessionPayload` to `{ editor:true, editorId:string, exp }` in
      `packages/core/src/runtime/auth/session.ts`; update `buildToken`/`parseToken`/cookie issue.
- [ ] Thread `editorId` into `CaretRequestContext` (`request-context.ts`).

**Per-editor overlay**
- [ ] Add optional `makeEditorOverlay(editorId): Promise<StorageAdapter>` to `StorageAdapter`
      (`types.ts`), peer to `makeSessionOverlay`.
- [ ] Implement: Filesystem (`.caret/drafts/<editorId>/` data + sidecar), KV
      (`draft/<editorId>/` prefix, **no TTL**), InMemory (fresh instance, for tests). Markdown →
      delegate to a filesystem draft root.
- [ ] Namespace the engine lock key by editor for overlay writes
      (`entry::<editorId>::<collection>::<id>`) — `mutations/engine.ts`.

**Preview wiring**
- [ ] Preview signal (`?preview=1` or a cookie) → `previewMode` on the context.
- [ ] `middleware.ts`: branch `isEditorAuthenticated && previewMode` → install
      `SessionOverlayAdapter(base, makeEditorOverlay(editorId))`. Keep `editor` (stega) independent of
      overlay selection.

**Publish / discard**
- [ ] `POST /api/cms/publish` `{collection?, id?}`: per-entry `withEntryLock`; tombstone ⇒
      `base.deleteEntry`, else `base.writeEntry`+`bumpRevision`+`appendHistory("publish")`; clear
      overlay; **return new base revisions**.
- [ ] `DELETE /api/cms/draft`: wipe overlay without publishing.
- [ ] Client reconciliation: editor runtime updates its cached revision map from the publish response
      (prevents post-publish 409).

**UI**
- [ ] Preview toggle + Publish + Discard in the editor chrome / Studio.

**Tests**
- [ ] Overlay isolation, tombstone publish (delete), publish returns revisions, edit-after-publish no
      409, two-editor lock isolation, discard reverts.

## W3 · Git-native history (commit on Publish)

- [ ] Startup capability detection: filesystem-backed adapter **and** `.git` present → git enabled,
      else no-op. Expose a `caret()` toggle to force-off.
- [ ] `postWrite` hook fired at **command granularity** in `mutations/engine.ts` (one commit per
      `executeMutation`), and in the restore path `routes/history.ts`.
- [ ] **Recommended scope (per PRD §6):** commit on **Publish** (W2), not every keystroke-save — drafts
      stay out of git, publishes become the meaningful commits.
- [ ] Author = `editorId`; message = action + scope (e.g. `publish pages/home`); optional "publish all"
      batched into one commit.
- [ ] Best-effort semantics: commit failure logs, never blocks the response or skips `bumpRevision`;
      run after `rename(2)`; never shell out synchronously inside the lock/`serializeWrite` chain (use a
      bounded background queue).
- [ ] Guards: overlay/draft writes do **not** commit; KV/R2 deployments unaffected.
- [ ] Document known limits: `markdown deleteCollection` leaves source files (needs explicit `git rm`);
      `git reset --hard` desyncs sidecar revisions (out-of-band).
- [ ] Tests: commit produced on publish (fs+git), no commit on KV, no commit on draft write, concurrent
      publishes don't corrupt, partial "publish all" reports committed set.

## W4 · caretize `--bind-collections` (Tier-5, direct-render first)

- [ ] `getCollectionCalls(fmText)` in `packages/caretize/src/frontmatter.ts` →
      `Map<varName, collectionName>` (handle `.sort()/.slice()` chains via existing bracket balancer).
- [ ] Extend the flag (`detect.ts`): add `collectionName`, `itemParam` (reuse
      `usage.ts` `mapParamIdents`/`readCallbackFirstParam`), `accessedFields` (regex
      `<itemParam>\.data\.(\w+)` over expression text). Entry id convention `<itemParam>.id`.
- [ ] `detectCollectionBindTargets(src, rel, ast)` producing direct-render bind targets (fields rendered
      into native elements inside the loop body; component-prop case → leave flagged).
- [ ] Transform in `run.ts`: import `bindEntry`; ensure block-body arrow (concise→block rewrite with an
      **inverse gate** modeled on `verifyHoistResult`); inject `const g = bindEntry({collection, id:
      <item>.id})`; splice `{...g("field")}` onto target elements (reuse `splice.ts`); re-parse gate.
- [ ] `cli.ts:analyzeFiles`: 5th pass → `bindsByFile`; extend `Analysis`, `selectChanges`,
      `prepareTouched`, `printCommit`; update flag-suppression to also drop bind-covered receivers.
- [ ] `--bind-collections` flag in `cli-args.ts` (default off → diagnostic only).
- [ ] Tests: `tests/fixtures/caretize/real/starlog-index.astro` flag → working `bindEntry()` that
      re-parses; component-prop loop still flags with a clear message; dry-run plan; `--restore` works.

## W5 · In-context primacy (principle)
- [ ] Add a CONTRIBUTING/design-principles note: in-context editing is primary; Studio = structural ops
      + non-visual fields. Review new Studio form work against it.

## W6 · Deployment matrix (docs)
- [ ] Document the storage/deploy matrix: filesystem+git (editorial) vs KV/R2 (high-write/edge);
      what each gives up/gains (history, hosting, write throughput).

---

### Suggested PR slices (each independently shippable + green)
1. `feat(zod): @caretcms/zod schema derivation` (+ migrate content-site) — **W1**
2. `feat(core): per-editor draft overlay + editorId in session` — **W2 part 1**
3. `feat(core): publish/discard endpoints + preview wiring + UI` — **W2 part 2**
4. `feat(core): git-native commit-on-publish (opt-in, guarded)` — **W3**
5. `feat(caretize): --bind-collections direct-render tier` — **W4**
6. `docs: in-context principle + deployment matrix` — **W5/W6**
